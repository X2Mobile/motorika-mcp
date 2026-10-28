// `motorika open [url] [--profile-dir <dir>] [--headless] [--executable-path <path>]`
// Starts a plain Chrome on the agent profile so the user can sign in by hand. No automation flags
// (no --enable-automation, no --remote-debugging-*): Google refuses sign-in in automation-controlled
// windows. Exits when that Chrome exits. Exit 2 when the profile is already in use.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readProfileLock } from '../browser/session.js';
import { probeSocket } from '../shared/owner.js';
import { socketPathFor } from '../shared/paths.js';

export const OPEN_USAGE = 'usage: motorika open [url] [--profile-dir <dir>] [--headless] [--executable-path <path>]\n';

export interface OpenArgs {
  url: string | undefined;
  profileDir: string;
  headless: boolean;
  executablePath: string | undefined;
}

function expand(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return resolve(p);
}

export function parseOpenArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): OpenArgs {
  const out: OpenArgs = {
    url: undefined,
    profileDir: expand(env.MOTORIKA_PROFILE_DIR || join(homedir(), '.motorika', 'profile')),
    headless: false,
    executablePath: env.MOTORIKA_EXECUTABLE_PATH || undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    const value = (): string => {
      const eq = a.indexOf('=');
      if (eq >= 0) return a.slice(eq + 1);
      const v = argv[++i];
      if (v === undefined || v === '') throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--headless') out.headless = true;
    else if (a === '--profile-dir' || a.startsWith('--profile-dir=')) out.profileDir = expand(value());
    else if (a === '--executable-path' || a.startsWith('--executable-path=')) out.executablePath = expand(value());
    else if (a.startsWith('--')) throw new Error(`unknown flag ${a}`);
    else if (out.url === undefined) out.url = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  return out;
}

export function chromeBinary(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (platform === 'darwin') return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (platform === 'win32') return join(env.PROGRAMFILES ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe');
  return '/opt/google/chrome/chrome';
}

/**
 * The plain Chrome command line: profile, no first-run noise, and nothing that marks automation.
 * A12: Playwright starts the agent's Chrome with --use-mock-keychain (macOS) and --password-store=basic
 * (Linux), so its cookies are encrypted with a mock key. The login window must use the same mode, or a
 * login done by hand would be unreadable to the agent (and the agent's cookies to the window).
 */
export function openChromeArgs(o: OpenArgs, platform: NodeJS.Platform = process.platform): string[] {
  const args = [`--user-data-dir=${o.profileDir}`, '--no-first-run', '--no-default-browser-check'];
  if (platform === 'darwin') args.push('--use-mock-keychain');
  if (platform === 'linux') args.push('--password-store=basic');
  if (o.headless) args.push('--headless=new');
  if (o.url) args.push(o.url);
  return args;
}

export async function runOpen(argv: string[]): Promise<never> {
  let o: OpenArgs;
  try {
    o = parseOpenArgs(argv);
  } catch (e) {
    process.stderr.write(`motorika open: ${e instanceof Error ? e.message : String(e)}\n${OPEN_USAGE}`);
    process.exit(64);
  }
  mkdirSync(o.profileDir, { recursive: true });
  if ((await probeSocket(socketPathFor(o.profileDir))) === 'live') {
    process.stderr.write(
      `motorika open: a Motorika server is using ${o.profileDir} right now.\n` +
        'Log in through that server\'s browser window instead (session launch headless=false), or stop that server first.\n',
    );
    process.exit(2);
  }
  const lock = readProfileLock(o.profileDir);
  if (lock && lock.alive !== false) {
    process.stderr.write(`motorika open: Chrome pid ${lock.pid} already uses ${o.profileDir}; use that window or close it first.\n`);
    process.exit(2);
  }
  const bin = o.executablePath ?? chromeBinary();
  if (!existsSync(bin)) {
    process.stderr.write(`motorika open: no Chrome at ${bin}; pass --executable-path <chrome binary>\n`);
    process.exit(1);
  }
  const child = spawn(bin, openChromeArgs(o), { stdio: 'ignore' });
  const forward = (sig: NodeJS.Signals) => () => {
    if (child.exitCode === null) child.kill(sig);
  };
  process.on('SIGINT', forward('SIGINT'));
  process.on('SIGTERM', forward('SIGTERM'));
  process.on('SIGHUP', forward('SIGHUP'));
  process.stderr.write(`motorika open: Chrome started on ${o.profileDir}; sign in, then quit Chrome (Cmd+Q on macOS; closing the window leaves it running).\n`);
  return new Promise<never>(() => {
    child.once('error', (e) => {
      process.stderr.write(`motorika open: could not start Chrome: ${e.message}\n`);
      process.exit(1);
    });
    child.once('exit', (code) => process.exit(code ?? 0));
  });
}
