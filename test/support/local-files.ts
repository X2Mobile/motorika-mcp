// R1 (review-lens decision 1): a local file tree under the test root, built at run time.
//   <dir>/allowed/page.html        title "Local allowed"; links to outside/secret.html and to the dot-dir page
//   <dir>/allowed/.hidden/x.html   title "Hidden local" (inside the root, but a dot-segment)
//   <dir>/outside/secret.html      title "Outside secret", text LOCAL-SECRET-TEXT
// The test passes `--allow-file-root <dir>/allowed`; `outside/` is under no default root.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface LocalTree {
  allowedRoot: string;
  page: string;
  hidden: string;
  outside: string;
  url(path: string): string;
}

export const LOCAL_SECRET_TEXT = 'LOCAL-SECRET-TEXT';

export function makeLocalTree(dir: string): LocalTree {
  const allowedRoot = join(dir, 'allowed');
  const hiddenDir = join(allowedRoot, '.hidden');
  const outsideDir = join(dir, 'outside');
  mkdirSync(hiddenDir, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });
  const page = join(allowedRoot, 'page.html');
  const hidden = join(hiddenDir, 'x.html');
  const outside = join(outsideDir, 'secret.html');
  const url = (p: string) => pathToFileURL(p).href;
  writeFileSync(outside, `<!doctype html><title>Outside secret</title><p>${LOCAL_SECRET_TEXT}</p>`);
  writeFileSync(hidden, '<!doctype html><title>Hidden local</title><p>hidden page</p>');
  writeFileSync(
    page,
    `<!doctype html><title>Local allowed</title><h1>Local allowed</h1>` +
      `<p><a id="out" href="${url(outside)}">Outside link</a></p>` +
      `<p><a id="dot" href="${url(hidden)}">Hidden link</a></p>`,
  );
  return { allowedRoot, page, hidden, outside, url };
}
