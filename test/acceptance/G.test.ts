// Acceptance group G: robustness and hygiene. G1 and G4 (stdout) are enforced by the client helper on
// every call in every file; G2 runs in every file's `after` hook; these tests add explicit checks.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { promisify } from 'node:util';
import { refOf } from '../support/grammar.ts';
import { stats } from '../support/mcp-client.ts';
import { REPO_ROOT } from '../support/paths.ts';
import { chromeUnder, waitNoChromeUnder } from '../support/procs.ts';
import { useFileServer } from '../support/suite.ts';

const execFileP = promisify(execFile);
const ctx = useFileServer('G');
const SRC = join(REPO_ROOT, 'src');

function sources(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? sources(p) : /\.(ts|mts|cts)$/.test(f) ? [p] : [];
  });
}

/** Removes comments and string/template literals so a regex sees only code. */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1')
    .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, '""');
}

describe('G robustness and hygiene', () => {
  test('G1 a call never exceeds its timeout + 2 s (navigate to a never-answering page, timeout_ms 1000)', async () => {
    const r = await ctx.s.call('navigate', { url: ctx.fx.url('/hang'), timeout_ms: 1000 });
    assert.equal(r.isError, true);
    assert.ok(r.ms <= 3000, `${r.ms} ms`);
    const w = await ctx.s.call('wait', { text: 'never there', timeout_ms: 1000 });
    assert.ok(w.ms <= 3000);
    assert.ok(stats.callsChecked >= 2, 'the helper checked every call');
  });

  test('G3 every isError result names a cause and a next step (spot checks)', async () => {
    await ctx.s.ok('navigate', { url: ctx.fx.url('/click.html'), snapshot: false });
    const s = await ctx.s.snapshot();
    // s.err asserts isError AND the cause + hint shape for each of these.
    await ctx.s.err('click', { target: '#does-not-exist', timeout_ms: 1000 });
    await ctx.s.err('click', { target: refOf(s, 'button', 'Disabled action'), timeout_ms: 1000 });
    await ctx.s.err('click', { target: 'role=button', timeout_ms: 1000 }); // strict mode: many matches
    await ctx.s.err('click', { target: 'e999999' });
    await ctx.s.err('wait', { text: 'never there', timeout_ms: 500 });
    await ctx.s.err('navigate', { url: 'http://nonexistent.invalid' });
    await ctx.s.err('upload', { target: '#nope', paths: ['/etc/hosts'] });
    await ctx.s.err('tabs', { action: 'select', tab: 't999' });
    await ctx.s.err('evaluate', { script: '(() => { throw new Error("g3") })()' });
  });

  test('G3 a strict-mode error lists up to 5 matches as snapshot lines with refs', async () => {
    await ctx.s.ok('navigate', { url: ctx.fx.url('/big-1000.html'), snapshot: false });
    const r = await ctx.s.err('click', { target: 'button.item', timeout_ms: 1000 });
    const refs = r.text.match(/- button "Item \d+" e\d+/g) ?? [];
    assert.ok(refs.length >= 1 && refs.length <= 5, r.text);
  });

  test('G4 npm run typecheck is clean', async () => {
    assert.ok(existsSync(SRC), 'src/ exists');
    const { stdout, stderr } = await execFileP('npm', ['run', 'typecheck'], { cwd: REPO_ROOT, maxBuffer: 16 * 1024 * 1024 }).catch(
      (e: { stdout?: string; stderr?: string }) => {
        throw new Error(`typecheck failed:\n${e.stdout ?? ''}\n${e.stderr ?? ''}`);
      },
    );
    assert.ok(!/error TS\d+/.test(stdout + stderr));
  });

  test('G4 no `any` and no console.log in src/', () => {
    const files = sources(SRC);
    assert.ok(files.length > 0, 'src/ has TypeScript files');
    const anyRe = /(:\s*any\b|\bas\s+any\b|<any>|\bany\[\]|Array<any>|[<,]\s*any\s*[>,])/;
    const hits: string[] = [];
    for (const f of files) {
      const code = codeOnly(readFileSync(f, 'utf8'));
      code.split('\n').forEach((l, i) => {
        if (anyRe.test(l)) hits.push(`${f}:${i + 1}: any: ${l.trim()}`);
        if (/\bconsole\.log\s*\(/.test(l)) hits.push(`${f}:${i + 1}: console.log: ${l.trim()}`);
      });
    }
    assert.deepEqual(hits, []);
  });

  test('G4 the server stdout carried only JSON-RPC for this whole file', () => {
    assert.deepEqual(ctx.s.stdoutViolations(), []);
    assert.ok(stats.stdoutLinesChecked > 0, 'stdout lines were checked');
  });

  test('G2 after this server exits, no Chrome with a --user-data-dir under its root remains', async () => {
    assert.ok((await chromeUnder(ctx.s.root)).length > 0, 'this file did launch Chrome');
    await ctx.s.close();
    assert.deepEqual(await waitNoChromeUnder(ctx.s.root, 5000), []);
  });
});
