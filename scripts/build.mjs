// Build: bundle the injected page engine (esbuild IIFE), compile the server (tsc),
// then make dist/index.js an executable with a shebang.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
mkdirSync(dist, { recursive: true });

execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(root, 'tsconfig.json')], {
  stdio: 'inherit',
});

await build({
  entryPoints: [join(root, 'src/page/injected/index.ts')],
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  minify: true,
  legalComments: 'none',
  outfile: join(dist, 'injected.js'),
  logLevel: 'warning',
});

const entry = join(dist, 'index.js');
const src = readFileSync(entry, 'utf8');
if (!src.startsWith('#!')) writeFileSync(entry, `#!/usr/bin/env node\n${src}`);
chmodSync(entry, 0o755);
process.stderr.write('build ok: dist/index.js, dist/injected.js\n');
