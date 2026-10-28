// Smoke-test client: spawns the built server (dist/index.js) over stdio with the SDK Client, in a
// private TMPDIR, and guarantees teardown of every Chrome it started (matched by that TMPDIR).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SERVER = join(root, 'dist', 'index.js');

export interface Result {
  text: string;
  isError: boolean;
  images: { data: string; mimeType: string }[];
  ms: number;
}

/** Chrome processes whose command line mentions dir (any --user-data-dir under it). */
export function chromePidsUnder(dir: string): number[] {
  const out = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const needles = [dir, dir.replace(/^\/private/, ''), `/private${dir}`];
  const pids: number[] = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const cmd = m[2] ?? '';
    if (!cmd.includes('--user-data-dir=')) continue;
    if (needles.some((n) => cmd.includes(`--user-data-dir=${n}`))) pids.push(Number(m[1]));
  }
  return pids;
}

export class Smoke {
  readonly tmp: string;
  readonly out: string;
  private client: Client | undefined;
  private transport: StdioClientTransport | undefined;
  stderr = '';

  constructor(
    readonly extraArgs: string[] = [],
    readonly opts: { isolated?: boolean; tmp?: string } = {},
  ) {
    this.tmp = opts.tmp ?? mkdtempSync(join(tmpdir(), 'motorika-smoke-'));
    this.out = join(this.tmp, 'out');
  }

  async start(): Promise<void> {
    this.transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER, '--headless', ...(this.opts.isolated === false ? [] : ['--isolated']), '--output-dir', this.out, ...this.extraArgs],
      env: { ...(process.env as Record<string, string>), TMPDIR: this.tmp },
      stderr: 'pipe',
    });
    this.transport.stderr?.on('data', (d: Buffer) => {
      this.stderr += d.toString();
    });
    this.client = new Client({ name: 'motorika-smoke', version: '0.0.0' });
    this.client.onerror = (e) => {
      throw new Error(`protocol error (stdout not JSON-RPC?): ${String(e)}`);
    };
    await this.client.connect(this.transport);
  }

  /** pid of the server process (for signal tests). */
  get pid(): number | null {
    return this.transport?.pid ?? null;
  }

  async listTools(): Promise<string[]> {
    if (!this.client) throw new Error('not started');
    const r = await this.client.listTools();
    return r.tools.map((t) => t.name);
  }

  async call(name: string, args: Record<string, unknown> = {}, timeoutMs = 45000): Promise<Result> {
    if (!this.client) throw new Error('not started');
    const t0 = Date.now();
    const r = await this.client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
    const content = (r.content ?? []) as { type: string; text?: string; data?: string; mimeType?: string }[];
    return {
      text: content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n'),
      isError: r.isError === true,
      images: content.filter((c) => c.type === 'image').map((c) => ({ data: c.data ?? '', mimeType: c.mimeType ?? '' })),
      ms: Date.now() - t0,
    };
  }

  /** Read a page value back through evaluate (JSON result after the header line). */
  async read(expr: string, tab?: string): Promise<unknown> {
    const r = await this.call('evaluate', tab ? { script: expr, tab } : { script: expr });
    if (r.isError) throw new Error(`evaluate failed: ${r.text}`);
    const body = r.text.slice(r.text.indexOf('\n') + 1);
    return JSON.parse(body) as unknown;
  }

  /** Close the client (stdin end), wait for Chrome to go, kill leftovers we started, remove tmp. */
  async stop(keepTmp = false): Promise<number[]> {
    try {
      await this.client?.close();
    } catch {
      /* already closed */
    }
    const deadline = Date.now() + 8000;
    let left = chromePidsUnder(this.tmp);
    while (left.length > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      left = chromePidsUnder(this.tmp);
    }
    for (const pid of left) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
    if (!keepTmp) rmSync(this.tmp, { recursive: true, force: true });
    return left;
  }
}

export function page(html: string): string {
  return `data:text/html,${encodeURIComponent(html)}`;
}

/** Find the ref of the first snapshot line matching role and name. */
export function refOf(snapshot: string, role: string, name: string): string {
  const re = new RegExp(`- ${role} ${JSON.stringify(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} (e\\d+)`);
  const m = re.exec(snapshot);
  if (!m?.[1]) throw new Error(`no ${role} "${name}" in:\n${snapshot}`);
  return m[1];
}
