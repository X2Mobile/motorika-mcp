// Round 4, G2: a server joins a shared browser only when its security settings match the owner's. The owner
// runs every forwarded call with ITS settings (its origin lists live in its Chrome, its sandbox flag launched
// that Chrome), so joining with other settings would silently drop the joiner's own.
import { realpathSync } from 'node:fs';
import type { Config } from '../config.js';

/** Security-relevant settings, by flag, in a canonical printable form. */
export type SecurityPolicy = Record<string, string>;

function canonPath(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

function list(xs: readonly string[]): string {
  return xs.length === 0 ? 'none' : [...new Set(xs)].sort().join(',');
}

const onOff = (b: boolean): string => (b ? 'on' : 'off');

/**
 * What a joined session would inherit from the owner. The cwd and --output-dir are per session (every
 * Claude session has its own) and are not compared; README "One agent browser" says what that means.
 */
export function securityPolicy(c: Config): SecurityPolicy {
  return {
    '--blocked-origins': list(c.blockedOrigins),
    '--allowed-origins': list(c.allowedOrigins),
    '--no-sandbox': onOff(c.noSandbox),
    '--allow-chrome-urls': onOff(c.allowChromeUrls),
    '--allow-hidden-files': onOff(c.allowHiddenFiles),
    '--allow-file-root': list(c.extraFileRoots.map(canonPath)),
  };
}

/** A well-formed policy from the socket (string values only), or undefined. */
export function validPolicy(v: unknown): SecurityPolicy | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const out: SecurityPolicy = {};
  for (const [k, x] of Object.entries(v)) {
    if (typeof x !== 'string' || k.length > 64 || x.length > 8192 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(k + x)) return undefined;
    out[k] = x;
  }
  return out;
}

/** One entry per differing setting: `--flag (this server: X; owner: Y)`. Empty when they match. */
export function policyDifferences(mine: SecurityPolicy, owner: SecurityPolicy | undefined): string[] {
  if (!owner) return ['the owner did not report its security settings (an older Motorika)'];
  const keys = [...new Set([...Object.keys(mine), ...Object.keys(owner)])];
  return keys
    .filter((k) => mine[k] !== owner[k])
    .map((k) => `${k} (this server: ${mine[k] ?? 'unknown'}; owner: ${owner[k] ?? 'unknown'})`);
}
