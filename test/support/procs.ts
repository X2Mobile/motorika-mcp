// Process helpers: find the suite's Chrome processes, start a throwaway Chrome (A8/A9), check TCP
// listeners (A10, A4e), talk raw CDP to a throwaway Chrome. Kills only PIDs under the test root or
// PIDs this module spawned itself.
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { CHROME_BIN, TEST_ROOT } from './paths.ts';
import { acquireSlots, type SlotLease } from './slots.ts';

const execFileP = promisify(execFile);

export interface ProcInfo {
  pid: number;
  ppid: number;
  command: string;
  userDataDir: string | null;
  /** true for the browser (main) process, false for renderer/gpu/utility children. */
  main: boolean;
}

/** All path spellings of a directory: as given and its realpath (/tmp vs /private/tmp). */
function spellings(dir: string): string[] {
  const out = new Set<string>([dir.replace(/\/+$/, '')]);
  try {
    out.add(realpathSync(dir).replace(/\/+$/, ''));
  } catch {
    /* gone already */
  }
  for (const d of [...out]) {
    if (d.startsWith('/private/')) out.add(d.slice('/private'.length));
    else if (d.startsWith('/tmp/') || d.startsWith('/var/')) out.add(`/private${d}`);
  }
  return [...out];
}

export async function listProcesses(): Promise<ProcInfo[]> {
  const { stdout } = await execFileP('ps', ['-axww', '-o', 'pid=,ppid=,command='], { maxBuffer: 64 * 1024 * 1024 });
  const out: ProcInfo[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const command = m[3] ?? '';
    // Test-root paths never contain spaces, so \S+ is exact for every process we care about.
    const udd = /--user-data-dir=(\S+)/.exec(command);
    out.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      command,
      userDataDir: udd?.[1]?.trim() ?? null,
      main: !/\s--type=/.test(command),
    });
  }
  return out;
}

/** Chrome processes whose --user-data-dir is at or under `root` (default: the whole test root). */
export async function chromeUnder(root: string = TEST_ROOT, opts: { mainOnly?: boolean } = {}): Promise<ProcInfo[]> {
  const prefixes = spellings(root);
  return (await listProcesses()).filter(
    (p) =>
      p.userDataDir !== null &&
      prefixes.some((pre) => p.userDataDir === pre || p.userDataDir!.startsWith(pre + '/')) &&
      (!opts.mainOnly || p.main),
  );
}

/** Chrome processes whose --user-data-dir is exactly `dir` (any spelling). */
export async function chromeWithProfile(dir: string, opts: { mainOnly?: boolean } = {}): Promise<ProcInfo[]> {
  const exact = spellings(dir);
  return (await listProcesses()).filter(
    (p) => p.userDataDir !== null && exact.includes(p.userDataDir.replace(/\/+$/, '')) && (!opts.mainOnly || p.main),
  );
}

/** Polls until no Chrome is left under `root` or the time is up. Returns what remains. */
export async function waitNoChromeUnder(root: string, ms: number): Promise<ProcInfo[]> {
  const deadline = Date.now() + ms;
  for (;;) {
    const left = await chromeUnder(root);
    if (left.length === 0 || Date.now() > deadline) return left;
    await sleep(200);
  }
}

/** Last-resort cleanup: SIGKILL every Chrome under `root` (only ever a test-root path). */
export async function killChromeUnder(root: string): Promise<number> {
  // Only ever at or under the test root: the user's real Chrome helpers also carry --user-data-dir.
  if (!spellings(root).some((s) => s === TEST_ROOT || s.startsWith(TEST_ROOT + '/')))
    throw new Error(`refusing to kill Chrome outside the test root: ${root}`);
  const procs = await chromeUnder(root);
  for (const p of procs) {
    try {
      process.kill(p.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  return procs.length;
}

/** TCP sockets in LISTEN state owned by any of `pids` (lsof). Empty array = none. */
export async function tcpListeners(pids: number[]): Promise<string[]> {
  if (pids.length === 0) return [];
  try {
    const { stdout } = await execFileP('lsof', ['-nP', '-a', '-p', pids.join(','), '-iTCP', '-sTCP:LISTEN']);
    return stdout.split('\n').slice(1).filter((l) => l.trim() !== '');
  } catch (err) {
    const e = err as { code?: number; stdout?: string };
    if (e.code === 1) return []; // lsof exits 1 when nothing matched
    throw err;
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface ThrowawayChrome {
  pid: number;
  userDataDir: string;
  port: number;
  /** `http://127.0.0.1:<port>` */
  httpEndpoint: string;
  /** ws URL of the browser target, from DevToolsActivePort line 2. */
  wsEndpoint: string;
  process: ChildProcess;
  /** Targets from the Chrome's own `/json/list`. */
  listTargets(): Promise<{ id: string; type: string; url: string; title: string; webSocketDebuggerUrl?: string }[]>;
  stop(): Promise<void>;
}

/**
 * Starts a headless Chrome with a TCP debugging port (the thing connect / auto-connect attach to).
 * `--remote-debugging-port=0` makes Chrome write DevToolsActivePort into the user-data-dir.
 */
export async function startThrowawayChrome(
  userDataDir: string,
  url: string,
  opts: { takeSlot?: boolean } = {},
): Promise<ThrowawayChrome> {
  const lease: SlotLease = opts.takeSlot === false ? { count: 0, release: () => undefined } : await acquireSlots(1, 'throwaway');
  const child = spawn(
    CHROME_BIN,
    [
      '--headless',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--use-mock-keychain',
      '--password-store=basic',
      url,
    ],
    { stdio: 'ignore', env: { ...process.env, TMPDIR: userDataDir } },
  );
  const portFile = join(userDataDir, 'DevToolsActivePort');
  const stop = async (): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((r) => child.once('exit', () => r()));
      child.kill('SIGTERM');
      await Promise.race([exited, sleep(5000)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await Promise.race([exited, sleep(3000)]);
      }
    }
    // Helpers (renderers, GPU) die with the browser; make sure, scoped to this profile only.
    for (const p of await chromeWithProfile(userDataDir)) {
      try {
        process.kill(p.pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
    lease.release();
  };
  try {
    const deadline = Date.now() + 20_000;
    let lines: string[] = [];
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`throwaway Chrome exited early with ${child.exitCode}`);
      if (existsSync(portFile)) {
        lines = readFileSync(portFile, 'utf8').split('\n').filter(Boolean);
        if (lines.length >= 2) break;
      }
      await sleep(100);
    }
    if (lines.length < 2) throw new Error(`no DevToolsActivePort in ${userDataDir} after 20 s`);
    const port = Number(lines[0]);
    const httpEndpoint = `http://127.0.0.1:${port}`;
    const listTargets = async () => {
      const r = await fetch(`${httpEndpoint}/json/list`);
      return (await r.json()) as { id: string; type: string; url: string; title: string; webSocketDebuggerUrl?: string }[];
    };
    // Wait until the requested page is a target and its document has finished loading.
    while (Date.now() < deadline) {
      const t = await listTargets().catch(() => []);
      const pg = t.find((x) => x.type === 'page' && x.url.startsWith(url.split('#')[0] ?? url));
      if (pg?.webSocketDebuggerUrl) {
        const state = await cdpEvaluate(pg.webSocketDebuggerUrl, 'document.readyState').catch(() => null);
        if (state === 'complete') break;
      }
      await sleep(100);
    }
    return {
      pid: child.pid ?? -1,
      userDataDir,
      port,
      httpEndpoint,
      wsEndpoint: `ws://127.0.0.1:${port}${lines[1]}`,
      process: child,
      listTargets,
      stop,
    };
  } catch (err) {
    await stop();
    throw err;
  }
}

/** Runtime.evaluate over a raw CDP page websocket (independent of the server under test). */
export async function cdpEvaluate(wsUrl: string, expression: string): Promise<unknown> {
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((res, rej) => {
    ws.addEventListener('open', () => res(), { once: true });
    ws.addEventListener('error', () => rej(new Error(`cannot open ${wsUrl}`)), { once: true });
  });
  try {
    const reply = await new Promise<{ result?: { result?: { value?: unknown } }; error?: unknown }>((res, rej) => {
      const t = setTimeout(() => rej(new Error('cdpEvaluate timed out')), 5000);
      ws.addEventListener('message', (ev) => {
        const msg = JSON.parse(String(ev.data)) as { id?: number };
        if (msg.id === 1) {
          clearTimeout(t);
          res(msg as never);
        }
      });
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    });
    if (reply.error) throw new Error(JSON.stringify(reply.error));
    return reply.result?.result?.value;
  } finally {
    ws.close();
  }
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}
