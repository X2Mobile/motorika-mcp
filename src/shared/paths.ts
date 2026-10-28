// Where the owner of a profile listens: ~/.motorika/run/<first 12 hex of sha1(realpath(profile))>.sock,
// a user-only unix socket (0600) in a 0700 dir. Never a TCP port.
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** ~ is os.homedir(), which respects HOME (contract Q18). */
export function runDir(): string {
  return join(homedir(), '.motorika', 'run');
}

export function ensureRunDir(): string {
  const dir = runDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

export function profileHash(profileDir: string): string {
  mkdirSync(profileDir, { recursive: true });
  return createHash('sha1').update(realpathSync(profileDir)).digest('hex').slice(0, 12);
}

export function socketPathFor(profileDir: string): string {
  return join(runDir(), `${profileHash(profileDir)}.sock`);
}
