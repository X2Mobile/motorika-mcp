// MCP client helper: drives the BUILT server (`node dist/index.js`) over stdio as a consumer would,
// through the SDK `Client`, and enforces three suite-wide rules on every call:
//   G1  wall time <= the call's timeout + 2 s
//   G4  every stdout line of the server process is a valid JSON-RPC message
//   C7  the fixture password literal never appears in any result (text, error, anything but image bytes)
//
// It uses its own stdio Transport instead of StdioClientTransport because the SDK's reader swallows a
// malformed stdout line into `onerror` and the call still succeeds; G4 needs that line recorded as a
// failure. Owning the spawn also gives us the env (TMPDIR per server), explicit stdin close (A7) and pid.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { JSONRPCMessageSchema, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { parseSnapshot, type Snapshot } from './grammar.ts';
import { freshDir, REPO_ROOT, SERVER_ENTRY } from './paths.ts';
import { chromeUnder, killChromeUnder, waitNoChromeUnder, type ProcInfo } from './procs.ts';
import { acquireSlots, type SlotLease } from './slots.ts';
import { PASSWORD_LITERAL } from './spec.ts';

export const NOT_BUILT = 'server not built: run npm run build';

/** Fails immediately (no spawn, no Chrome, no fixture server) when dist/index.js is missing. */
export function assertBuilt(entry: string = SERVER_ENTRY): void {
  if (!existsSync(entry)) throw new Error(`${NOT_BUILT} (missing ${entry})`);
}

// ---------------------------------------------------------------------------------------------
// Defaults from PLAN.md "Modes and configuration".
export const ACTION_TIMEOUT = 10_000;
export const NAVIGATION_TIMEOUT = 30_000;
export const G1_SLACK = 2_000;

type Args = Record<string, unknown>;

/**
 * The timeout that governs a call, per PLAN.md: `timeout_ms` when given, else the configured default.
 * CONTRACT-QUESTION: the plan does not say which default governs tools without `timeout_ms`
 * (session launch, tabs new with url, video frames sampling, batch). Assumed here:
 *   navigate, tabs new+url, session launch -> navigation timeout; wait ms -> max(ms, timeout);
 *   video frames every_ms -> duration_ms + action timeout; batch -> sum of its steps; else action timeout.
 */
export function expectedTimeout(tool: string, args: Args): number {
  const t = typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined;
  switch (tool) {
    case 'navigate':
      return t ?? NAVIGATION_TIMEOUT;
    case 'tabs':
      return args.action === 'new' && typeof args.url === 'string' ? (t ?? NAVIGATION_TIMEOUT) : (t ?? ACTION_TIMEOUT);
    case 'session':
      return args.action === 'launch' ? NAVIGATION_TIMEOUT : ACTION_TIMEOUT;
    case 'wait':
      return typeof args.ms === 'number' ? Math.max(args.ms, t ?? 0) : (t ?? ACTION_TIMEOUT);
    case 'video':
      // PLAN contract answer 1: frames sampling = duration_ms + action timeout; other frames = navigation timeout.
      if (args.action !== 'frames') return t ?? ACTION_TIMEOUT;
      return typeof args.every_ms === 'number' && typeof args.duration_ms === 'number'
        ? (t ?? args.duration_ms + ACTION_TIMEOUT)
        : (t ?? NAVIGATION_TIMEOUT);
    case 'batch': {
      const steps = Array.isArray(args.steps) ? (args.steps as { tool: string; args?: Args }[]) : [];
      return steps.reduce((sum, s) => sum + expectedTimeout(s.tool, s.args ?? {}), 0) || ACTION_TIMEOUT;
    }
    default:
      return t ?? ACTION_TIMEOUT;
  }
}

// ---------------------------------------------------------------------------------------------
// Suite-wide bookkeeping (per test-file process).

export const stats = { callsChecked: 0, stdoutLinesChecked: 0 };
export const orphanReports: { label: string; procs: ProcInfo[] }[] = [];

/** C7 scan: the literal anywhere in the result except inside image bytes. */
export function c7Violation(result: unknown, literal: string = PASSWORD_LITERAL): string | null {
  const s = JSON.stringify(result, (k, v: unknown) => (k === 'data' && typeof v === 'string' && v.length > 200 ? '<image>' : v));
  const i = s.indexOf(literal);
  return i < 0 ? null : s.slice(Math.max(0, i - 120), i + literal.length + 40);
}

/** G4 check of one stdout line. Returns null when valid. */
export function g4Violation(line: string): string | null {
  try {
    const parsed = JSONRPCMessageSchema.safeParse(JSON.parse(line));
    return parsed.success ? null : `not a JSON-RPC message: ${line.slice(0, 200)}`;
  } catch {
    return `not JSON: ${line.slice(0, 200)}`;
  }
}

class TeeStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  child: ChildProcess | null = null;
  readonly violations: string[] = [];
  readonly stderrLines: string[] = [];
  private buf = '';

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly env: NodeJS.ProcessEnv,
    private readonly cwd: string,
  ) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, this.args, { cwd: this.cwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe'] });
      this.child = child;
      child.once('error', (e) => {
        reject(e);
        this.onerror?.(e);
      });
      child.once('spawn', () => resolve());
      child.once('close', () => this.onclose?.());
      child.stdin.on('error', (e) => this.onerror?.(e));
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        this.buf += chunk;
        let nl: number;
        while ((nl = this.buf.indexOf('\n')) >= 0) {
          const line = this.buf.slice(0, nl).replace(/\r$/, '');
          this.buf = this.buf.slice(nl + 1);
          stats.stdoutLinesChecked += 1;
          const bad = g4Violation(line);
          if (bad) {
            this.violations.push(bad);
            continue;
          }
          this.onmessage?.(JSONRPCMessageSchema.parse(JSON.parse(line)));
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        for (const l of chunk.split('\n')) if (l) this.stderrLines.push(l);
        if (this.stderrLines.length > 400) this.stderrLines.splice(0, this.stderrLines.length - 400);
      });
    });
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      const stdin = this.child?.stdin;
      if (!stdin || stdin.destroyed || stdin.writableEnded) {
        reject(new Error('Not connected'));
        return;
      }
      if (stdin.write(JSON.stringify(message) + '\n')) resolve();
      else stdin.once('drain', () => resolve());
    });
  }

  async close(): Promise<void> {
    // Client.close() calls this; the ServerHandle drives the actual shutdown sequence.
  }
}

export interface ToolImage {
  data: string;
  mimeType: string;
}

export interface ToolResult {
  tool: string;
  args: Args;
  text: string;
  images: ToolImage[];
  /** Content items in order, text and image interleaved (frames: label then image). */
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[];
  isError: boolean;
  ms: number;
  budget: number;
  raw: unknown;
}

export interface ServerOptions {
  label?: string;
  /** Default true: `--headless`. */
  headless?: boolean;
  /** Default true: `--isolated`. */
  isolated?: boolean;
  /** Extra CLI flags. */
  flags?: string[];
  /** Extra env (merged over a sanitized copy of process.env). */
  env?: NodeJS.ProcessEnv;
  /** Chrome slots to hold while this server lives (default 1; 0 when the caller holds them). */
  slots?: number;
  /** For the harness self-test: run another entry instead of dist/index.js. */
  entry?: string;
  /** Directory to use as the per-server root (default: a fresh dir under the test root). */
  root?: string;
}

export interface ServerHandle {
  client: Client;
  root: string;
  tmpDir: string;
  outputDir: string;
  pid: number;
  child: ChildProcess;
  stderr(): string;
  stdoutViolations(): string[];
  call(tool: string, args?: Args, opts?: { budgetMs?: number }): Promise<ToolResult>;
  ok(tool: string, args?: Args, opts?: { budgetMs?: number }): Promise<ToolResult>;
  err(tool: string, args?: Args, opts?: { budgetMs?: number }): Promise<ToolResult>;
  snapshot(args?: Args): Promise<Snapshot>;
  /** Reads page state through the `evaluate` tool. `expr` is a JS expression (or `fn` with target). */
  state<T = unknown>(expr: string, opts?: { tab?: string; target?: string }): Promise<T>;
  closeStdin(): void;
  waitExit(ms: number): Promise<boolean>;
  close(): Promise<void>;
}

function sanitizedEnv(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('MOTORIKA_') || k.startsWith('NODE_TEST') || k === 'NODE_OPTIONS') continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}

let serverSeq = 0;

export async function startServer(opts: ServerOptions = {}): Promise<ServerHandle> {
  const entry = opts.entry ?? SERVER_ENTRY;
  assertBuilt(entry);
  serverSeq += 1;
  const label = opts.label ?? `server${serverSeq}`;
  const root = opts.root ?? freshDir('s');
  const tmpDir = join(root, 'tmp');
  const outputDir = join(root, 'out');
  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(outputDir, { recursive: true });
  const args = [entry];
  // MOTORIKA_TEST_SHOW=1 runs every server headed: the A2 headed subset (PLAN A2) is run this way.
  if (opts.headless !== false && process.env.MOTORIKA_TEST_SHOW !== '1') args.push('--headless');
  if (opts.isolated !== false) args.push('--isolated');
  args.push('--output-dir', outputDir, ...(opts.flags ?? []));
  const lease: SlotLease = await acquireSlots(opts.slots ?? 1, label);
  const transport = new TeeStdioTransport(
    process.execPath,
    args,
    sanitizedEnv({ TMPDIR: tmpDir + '/', ...opts.env }),
    REPO_ROOT,
  );
  const client = new Client({ name: 'motorika-acceptance', version: '0.0.0' }, { capabilities: {} });
  let closed = false;

  const exited = (): boolean => transport.child === null || transport.child.exitCode !== null || transport.child.signalCode !== null;
  const waitExit = async (ms: number): Promise<boolean> => {
    const deadline = Date.now() + ms;
    while (!exited() && Date.now() < deadline) await sleep(50);
    return exited();
  };

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try {
      if (!exited()) {
        transport.child?.stdin?.end();
        if (!(await waitExit(5000))) {
          transport.child?.kill('SIGTERM');
          if (!(await waitExit(3000))) {
            transport.child?.kill('SIGKILL');
            await waitExit(2000);
          }
        }
      }
      await client.close().catch(() => undefined);
      // G2 bookkeeping: anything this server left behind is recorded, then removed for hygiene.
      const left = await waitNoChromeUnder(root, 5000);
      if (left.length > 0) {
        orphanReports.push({ label, procs: left });
        await killChromeUnder(root);
      }
    } finally {
      lease.release();
    }
  };

  try {
    await client.connect(transport, { timeout: 15_000 });
  } catch (err) {
    await close();
    throw new Error(`${label}: connect failed: ${String(err)}\nstderr:\n${transport.stderrLines.slice(-30).join('\n')}`);
  }

  const call = async (tool: string, a: Args = {}, o: { budgetMs?: number } = {}): Promise<ToolResult> => {
    const budget = o.budgetMs ?? expectedTimeout(tool, a);
    const t0 = performance.now();
    let raw: unknown;
    try {
      raw = await client.callTool({ name: tool, arguments: a }, undefined, { timeout: budget + G1_SLACK + 3000 });
    } catch (err) {
      const ms = Math.round(performance.now() - t0);
      const leak = c7Violation(String(err));
      assert.equal(leak, null, `C7: password literal in an error from ${tool}: ${leak}`);
      throw new Error(`${tool} threw after ${ms} ms (G1 budget ${budget + G1_SLACK} ms): ${String(err)}`);
    }
    const ms = Math.round(performance.now() - t0);
    stats.callsChecked += 1;
    assert.ok(ms <= budget + G1_SLACK, `G1: ${tool} took ${ms} ms > timeout ${budget} + ${G1_SLACK} ms`);
    assert.deepEqual(transport.violations, [], `G4: non-JSON-RPC stdout lines from the server`);
    const leak = c7Violation(raw);
    assert.equal(leak, null, `C7: password literal in ${tool} result: ${leak}`);
    const r = raw as { content?: unknown[]; isError?: boolean };
    const content = (r.content ?? []) as ToolResult['content'];
    return {
      tool,
      args: a,
      text: content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('\n'),
      images: content.filter((c) => c.type === 'image').map((c) => c as ToolImage),
      content,
      isError: r.isError === true,
      ms,
      budget,
      raw,
    };
  };

  const ok = async (tool: string, a: Args = {}, o: { budgetMs?: number } = {}): Promise<ToolResult> => {
    const r = await call(tool, a, o);
    assert.equal(r.isError, false, `${tool} ${JSON.stringify(a).slice(0, 200)} returned isError:\n${r.text}`);
    return r;
  };

  const err = async (tool: string, a: Args = {}, o: { budgetMs?: number } = {}): Promise<ToolResult> => {
    const r = await call(tool, a, o);
    assert.equal(r.isError, true, `${tool} ${JSON.stringify(a).slice(0, 200)} was expected to fail:\n${r.text}`);
    assertCauseAndHint(r.text);
    return r;
  };

  const snapshot = async (a: Args = {}): Promise<Snapshot> => {
    const r = await ok('snapshot', a);
    const s = parseSnapshot(r.text);
    assert.deepEqual(s.errors, [], `C1: snapshot lines that do not parse:\n${r.text.slice(0, 3000)}`);
    return s;
  };

  const state = async <T>(expr: string, o: { tab?: string; target?: string } = {}): Promise<T> => {
    const script = o.target
      ? `(el) => ({ "__motorikav": ((${expr}))(el) })`
      : `(() => ({ "__motorikav": (${expr}) }))()`;
    const a: Args = { script };
    if (o.tab) a.tab = o.tab;
    if (o.target) a.target = o.target;
    const r = await ok('evaluate', a);
    return extractMarked<T>(r.text);
  };

  return {
    client,
    root,
    tmpDir,
    outputDir,
    pid: transport.child?.pid ?? -1,
    child: transport.child!,
    stderr: () => transport.stderrLines.join('\n'),
    stdoutViolations: () => [...transport.violations],
    call,
    ok,
    err,
    snapshot,
    state,
    closeStdin: () => transport.child?.stdin?.end(),
    waitExit,
    close,
  };
}

/** Pulls `{"__motorikav": …}` back out of an evaluate result, whatever text surrounds it. */
export function extractMarked<T>(text: string): T {
  const key = text.indexOf('"__motorikav"');
  if (key < 0) throw new Error(`evaluate result has no marker:\n${text.slice(0, 500)}`);
  const open = text.lastIndexOf('{', key);
  for (let close = text.lastIndexOf('}'); close > key; close = text.lastIndexOf('}', close - 1)) {
    try {
      return (JSON.parse(text.slice(open, close + 1)) as { __motorikav: T }).__motorikav;
    } catch {
      /* try the next shorter candidate */
    }
  }
  throw new Error(`cannot parse evaluate result:\n${text.slice(0, 500)}`);
}

/**
 * G3: an error result names a cause and a next step.
 * CONTRACT-QUESTION: PLAN.md says "a one-line cause, and a hint for the next step" without a
 * machine-checkable shape. Accepted here: two or more non-empty lines, or one line in which a hint
 * follows a separator (`; `, `. `, ` - `, ` — `, `(`).
 */
export function assertCauseAndHint(text: string): void {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  assert.ok(lines.length > 0, 'G3: error result has no text');
  if (lines.length >= 2) return;
  const one = lines[0]!;
  assert.ok(/(; |\. |\s[-—]\s|\().+/.test(one), `G3: error has a cause but no next-step hint: ${one}`);
}

/** G2 per file: no server of this process left a Chrome behind, and nothing remains under `roots`. */
export async function assertNoOrphans(roots: string[]): Promise<void> {
  const reports = orphanReports.map((r) => `${r.label}: ${r.procs.map((p) => p.pid).join(',')}`);
  const left: ProcInfo[] = [];
  for (const r of roots) left.push(...(await chromeUnder(r)));
  for (const r of roots) await killChromeUnder(r).catch(() => 0);
  assert.deepEqual(reports, [], `G2: servers left Chrome processes behind after exit`);
  assert.deepEqual(left.map((p) => `${p.pid} ${p.userDataDir}`), [], 'G2: Chrome remains under the test root');
}
