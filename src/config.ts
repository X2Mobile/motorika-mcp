// Flag + env parsing. Flags win over env; env wins over defaults.
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';

export type BrowserChannel = 'chrome' | 'chrome-beta' | 'msedge' | 'chromium';
export type Mode = 'launch' | 'connect' | 'auto_connect';

export interface Config {
  headless: boolean;
  browser: BrowserChannel;
  executablePath: string | undefined;
  profileDir: string;
  isolated: boolean;
  /** Launch Chrome without its renderer sandbox (S2 opt-out, e.g. Linux containers as root). Default false. */
  noSandbox: boolean;
  cdpEndpoint: string | undefined;
  autoConnect: boolean;
  chromeUserDataDir: string;
  viewport: { width: number; height: number };
  outputDir: string;
  fileRoots: string[];
  /** The `--allow-file-root` / MOTORIKA_FILE_ROOTS part of fileRoots (compared when joining a shared browser, G2). */
  extraFileRoots: string[];
  /** Inside a root but never a file: navigation target (re-check item 4): <output-dir>/downloads. */
  fileNavExcluded: string[];
  allowHiddenFiles: boolean;
  /** chrome:, devtools:, about: (except blank/srcdoc) and other internal URLs (PLAN review item 1). */
  allowChromeUrls: boolean;
  /** Origin entries: a host (matches subdomains), a *.pattern, or a full origin (PLAN review item 2). */
  blockedOrigins: string[];
  allowedOrigins: string[];
  actionTimeout: number;
  navigationTimeout: number;
  maxOutputChars: number;
}

export class ConfigError extends Error {}

const channelSchema = z.enum(['chrome', 'chrome-beta', 'msedge', 'chromium']);
const positiveInt = z.coerce.number().int().positive();

export function defaultChromeUserDataDir(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  const home = homedir();
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Google', 'Chrome');
  if (platform === 'win32') return join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Google', 'Chrome', 'User Data');
  return join(home, '.config', 'google-chrome');
}

export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

export function parseViewport(raw: string): { width: number; height: number } {
  const m = /^(\d{2,5})x(\d{2,5})$/i.exec(raw.trim());
  if (!m) throw new ConfigError(`invalid viewport "${raw}": expected <width>x<height>, e.g. 1280x800`);
  return { width: Number(m[1]), height: Number(m[2]) };
}

const BOOL_FLAGS = new Set(['headless', 'isolated', 'auto-connect', 'allow-hidden-files', 'allow-chrome-urls', 'no-sandbox']);
const VALUE_FLAGS = new Set([
  'browser',
  'executable-path',
  'profile-dir',
  'cdp-endpoint',
  'chrome-user-data-dir',
  'viewport',
  'output-dir',
  'allow-file-root',
  'blocked-origins',
  'allowed-origins',
  'action-timeout',
  'navigation-timeout',
  'max-output-chars',
]);

interface RawFlags {
  bools: Set<string>;
  values: Map<string, string[]>;
}

function parseArgv(argv: string[]): RawFlags {
  const bools = new Set<string>();
  const values = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (!arg.startsWith('--')) throw new ConfigError(`unexpected argument "${arg}"; run with --help for the flag list`);
    let name = arg.slice(2);
    let inline: string | undefined;
    const eq = name.indexOf('=');
    if (eq >= 0) {
      inline = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    if (BOOL_FLAGS.has(name)) {
      if (inline !== undefined && !['1', 'true', '0', 'false'].includes(inline)) {
        throw new ConfigError(`flag --${name} takes no value`);
      }
      if (inline === '0' || inline === 'false') bools.delete(name);
      else bools.add(name);
      continue;
    }
    if (VALUE_FLAGS.has(name)) {
      let value = inline;
      if (value === undefined) {
        value = argv[i + 1];
        i++;
      }
      if (value === undefined || value === '') throw new ConfigError(`flag --${name} needs a value`);
      const list = values.get(name) ?? [];
      list.push(value);
      values.set(name, list);
      continue;
    }
    throw new ConfigError(`unknown flag --${name}; run with --help for the flag list`);
  }
  return { bools, values };
}

function envBool(v: string | undefined): boolean {
  return v !== undefined && ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

export function parseConfig(argv: string[], env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): Config {
  const f = parseArgv(argv);
  const one = (flag: string, envName: string): string | undefined => {
    const vals = f.values.get(flag);
    if (vals && vals.length > 0) return vals[vals.length - 1];
    const e = env[envName];
    return e === undefined || e === '' ? undefined : e;
  };
  const bool = (flag: string, envName: string): boolean => f.bools.has(flag) || envBool(env[envName]);
  const num = (flag: string, envName: string, def: number): number => {
    const raw = one(flag, envName);
    if (raw === undefined) return def;
    const r = positiveInt.safeParse(raw);
    if (!r.success) throw new ConfigError(`--${flag} must be a positive integer, got "${raw}"`);
    return r.data;
  };
  const path = (p: string): string => resolve(cwd, expandHome(p));

  const browserRaw = one('browser', 'MOTORIKA_BROWSER') ?? 'chrome';
  const browser = channelSchema.safeParse(browserRaw);
  if (!browser.success) throw new ConfigError(`--browser must be one of chrome, chrome-beta, msedge, chromium; got "${browserRaw}"`);

  const cdpEndpoint = one('cdp-endpoint', 'MOTORIKA_CDP_ENDPOINT');
  if (cdpEndpoint !== undefined && !/^(https?|wss?):\/\//i.test(cdpEndpoint)) {
    throw new ConfigError(`--cdp-endpoint must start with http://, https://, ws:// or wss://; got "${cdpEndpoint}"`);
  }
  const autoConnect = bool('auto-connect', 'MOTORIKA_AUTO_CONNECT');
  if (autoConnect && cdpEndpoint !== undefined) {
    throw new ConfigError('--auto-connect and --cdp-endpoint are exclusive; pass only one');
  }

  const outputDir = path(one('output-dir', 'MOTORIKA_OUTPUT_DIR') ?? '~/.motorika/output');
  const rootFlags = f.values.get('allow-file-root');
  let extraRoots: string[] = [];
  if (rootFlags && rootFlags.length > 0) extraRoots = rootFlags;
  else if (env.MOTORIKA_FILE_ROOTS) extraRoots = env.MOTORIKA_FILE_ROOTS.split(':').filter((s) => s !== '');
  const home = homedir();
  const fileRoots = [
    cwd,
    outputDir,
    join(home, 'Downloads'),
    join(home, 'Desktop'),
    join(home, 'Documents'),
    ...extraRoots.map(path),
  ];

  const viewportRaw = one('viewport', 'MOTORIKA_VIEWPORT');
  return {
    headless: bool('headless', 'MOTORIKA_HEADLESS'),
    browser: browser.data,
    executablePath: (() => {
      const p = one('executable-path', 'MOTORIKA_EXECUTABLE_PATH');
      return p === undefined ? undefined : path(p);
    })(),
    profileDir: path(one('profile-dir', 'MOTORIKA_PROFILE_DIR') ?? '~/.motorika/profile'),
    isolated: bool('isolated', 'MOTORIKA_ISOLATED'),
    noSandbox: bool('no-sandbox', 'MOTORIKA_NO_SANDBOX'),
    cdpEndpoint,
    autoConnect,
    chromeUserDataDir: (() => {
      const p = one('chrome-user-data-dir', 'MOTORIKA_CHROME_USER_DATA_DIR');
      return p === undefined ? defaultChromeUserDataDir() : path(p);
    })(),
    viewport: viewportRaw === undefined ? { width: 1280, height: 800 } : parseViewport(viewportRaw),
    outputDir,
    fileRoots: [...new Set(fileRoots)],
    extraFileRoots: [...new Set(extraRoots.map(path))],
    fileNavExcluded: [join(outputDir, 'downloads')],
    allowHiddenFiles: bool('allow-hidden-files', 'MOTORIKA_ALLOW_HIDDEN_FILES'),
    allowChromeUrls: bool('allow-chrome-urls', 'MOTORIKA_ALLOW_CHROME_URLS'),
    blockedOrigins: originList(f.values.get('blocked-origins'), env.MOTORIKA_BLOCKED_ORIGINS, '--blocked-origins'),
    allowedOrigins: originList(f.values.get('allowed-origins'), env.MOTORIKA_ALLOWED_ORIGINS, '--allowed-origins'),
    actionTimeout: num('action-timeout', 'MOTORIKA_ACTION_TIMEOUT', 10000),
    navigationTimeout: num('navigation-timeout', 'MOTORIKA_NAVIGATION_TIMEOUT', 30000),
    maxOutputChars: num('max-output-chars', 'MOTORIKA_MAX_OUTPUT_CHARS', 20000),
  };
}

/** Comma-separated, repeatable flag; the flag replaces the env list. Entries are validated. */
function originList(flags: string[] | undefined, envValue: string | undefined, flag: string): string[] {
  const raw = flags && flags.length > 0 ? flags : envValue ? [envValue] : [];
  const out: string[] = [];
  for (const part of raw.flatMap((r) => r.split(','))) {
    const e = part.trim().toLowerCase();
    if (e === '') continue;
    const ok =
      /^https?:\/\/[a-z0-9.-]+(:\d+)?\/?$/.test(e) || /^wss?:\/\/[a-z0-9.-]+(:\d+)?\/?$/.test(e) || /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(e);
    if (!ok) throw new ConfigError(`${flag}: "${part.trim()}" is not a host, *.pattern or origin (e.g. bank.example, *.bank.example, https://mail.google.com)`);
    out.push(e.replace(/\/$/, ''));
  }
  return [...new Set(out)];
}

export function configuredMode(c: Config): Mode {
  if (c.cdpEndpoint !== undefined) return 'connect';
  if (c.autoConnect) return 'auto_connect';
  return 'launch';
}

export const HELP = `motorika: MCP server (stdio) for full Chrome control.

Usage:
  motorika [flags]               run the MCP server on stdio
  motorika open [url] [--profile-dir <dir>] [--headless]
                                 a plain Chrome on the agent profile, for logging in by hand

Flags (env in parentheses):
  --headless                     (MOTORIKA_HEADLESS=1) headless Chrome
  --browser <chrome|chrome-beta|msedge|chromium> (MOTORIKA_BROWSER)
  --executable-path <path>       (MOTORIKA_EXECUTABLE_PATH)
  --profile-dir <dir>            (MOTORIKA_PROFILE_DIR) default ~/.motorika/profile
  --isolated                     (MOTORIKA_ISOLATED=1) temp profile, deleted on exit
  --no-sandbox                   (MOTORIKA_NO_SANDBOX=1) launch Chrome without its sandbox (containers as root); unsafe
  --cdp-endpoint <url>           (MOTORIKA_CDP_ENDPOINT) attach to a Chrome debugging endpoint
  --auto-connect                 (MOTORIKA_AUTO_CONNECT=1) attach to your running Chrome
  --chrome-user-data-dir <dir>   (MOTORIKA_CHROME_USER_DATA_DIR) where auto-connect reads DevToolsActivePort
  --viewport <WxH>               (MOTORIKA_VIEWPORT) default 1280x800
  --output-dir <dir>             (MOTORIKA_OUTPUT_DIR) default ~/.motorika/output
  --allow-file-root <dir>        (MOTORIKA_FILE_ROOTS, ':'-separated) extra upload roots, repeatable
  --allow-hidden-files           (MOTORIKA_ALLOW_HIDDEN_FILES=1) allow dot-files as upload sources
  --allow-chrome-urls            (MOTORIKA_ALLOW_CHROME_URLS=1) allow chrome:, devtools: and about: pages
  --blocked-origins <list>       (MOTORIKA_BLOCKED_ORIGINS) never load these hosts/origins (comma-separated)
  --allowed-origins <list>       (MOTORIKA_ALLOWED_ORIGINS) load only these hosts/origins (comma-separated)
  --action-timeout <ms>          (MOTORIKA_ACTION_TIMEOUT) default 10000
  --navigation-timeout <ms>      (MOTORIKA_NAVIGATION_TIMEOUT) default 30000
  --max-output-chars <n>         (MOTORIKA_MAX_OUTPUT_CHARS) default 20000, a hard ceiling on any text result

Env only:
  MOTORIKA_LOG=debug|info|warn|error  stderr log level, default info
`;
