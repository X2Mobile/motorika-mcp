// Shared locations for the acceptance suite and the fixture harness.
//
// The test root is deliberately SHORT. macOS caps Unix socket paths at 104 bytes, and Chrome puts its
// singleton socket under `$TMPDIR/.com.google.Chrome.XXXXXX/SingletonSocket`. The default macOS tmp
// realpath is already 56 chars, so a nested root under it can push Chrome over the limit. The A4 join
// socket (`$HOME/.motorika/run/<12 hex>.sock`) has the same limit when HOME is pointed into the root.
// Override with MOTORIKA_TEST_ROOT.
import { mkdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FIXTURES_DIR = join(REPO_ROOT, 'test', 'fixtures');
export const MEDIA_DIR = join(FIXTURES_DIR, 'media');
export const SERVER_ENTRY = join(REPO_ROOT, 'dist', 'index.js');

/** The Chrome binary for throwaway instances and the fixture harness. */
export const CHROME_BIN =
  process.env.MOTORIKA_TEST_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const uid = typeof process.getuid === 'function' ? process.getuid() : 0;

function ensureReal(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return realpathSync(dir);
}

/** Suite-wide root. Every Chrome the suite causes lives under it (G2 checks that nothing remains). */
export const TEST_ROOT = ensureReal(process.env.MOTORIKA_TEST_ROOT ?? `/tmp/motorika-acc-${uid}`);

let seq = 0;

/** A fresh, short, per-use directory under the test root, e.g. `<root>/c3-41234`. */
export function freshDir(tag: string): string {
  seq += 1;
  return ensureReal(join(TEST_ROOT, `${tag}${seq}-${process.pid}`));
}
