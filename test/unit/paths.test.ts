import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { PathDenied, confineUploadPath, sanitizeFilename, uniquePathIn } from '../../src/util/paths.js';

describe('upload path confinement (PLAN Security)', () => {
  let base: string;
  let root: string;
  let outside: string;
  before(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'motorika-unit-paths-')));
    root = join(base, 'root');
    outside = join(base, 'outside');
    mkdirSync(join(root, 'sub'), { recursive: true });
    mkdirSync(join(root, '.hidden'), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(root, 'ok.txt'), 'ok');
    writeFileSync(join(root, 'sub', 'deep.txt'), 'deep');
    writeFileSync(join(root, '.env'), 'secret');
    writeFileSync(join(root, '.hidden', 'x.txt'), 'x');
    writeFileSync(join(outside, 'id_rsa'), 'key');
    symlinkSync(join(outside, 'id_rsa'), join(root, 'link-out.txt'));
    symlinkSync(join(root, '.env'), join(root, 'link-to-dotfile.txt'));
    symlinkSync(outside, join(root, 'dirlink'));
  });
  after(() => rmSync(base, { recursive: true, force: true }));

  const denied = (p: string, re: RegExp, allowHidden = false) =>
    assert.throws(() => confineUploadPath(p, [root], allowHidden, base), (e: unknown) => e instanceof PathDenied && re.test(e.message));

  it('a file inside a root resolves to its realpath', () => {
    assert.equal(confineUploadPath(join(root, 'ok.txt'), [root], false), join(root, 'ok.txt'));
    assert.equal(confineUploadPath('root/sub/deep.txt', [root], false, base), join(root, 'sub', 'deep.txt'));
  });
  it('dot-segments that climb out are refused and name --allow-file-root', () => denied(join(root, 'sub', '..', '..', 'outside', 'id_rsa'), /outside the allowed upload roots.*--allow-file-root/));
  it('a symlink pointing outside is refused (realpath)', () => denied(join(root, 'link-out.txt'), /outside the allowed upload roots/));
  it('a symlinked directory pointing outside is refused', () => denied(join(root, 'dirlink', 'id_rsa'), /outside the allowed upload roots/));
  it('a dot-file is refused and names --allow-hidden-files', () => denied(join(root, '.env'), /hidden.*--allow-hidden-files/));
  it('a file inside a dot-dir is refused', () => denied(join(root, '.hidden', 'x.txt'), /hidden/));
  it('a symlink to a dot-file is refused after realpath', () => denied(join(root, 'link-to-dotfile.txt'), /hidden/));
  it('--allow-hidden-files permits dot-files inside a root', () => {
    assert.equal(confineUploadPath(join(root, '.env'), [root], true), join(root, '.env'));
  });
  it('a root that itself lives under a dot-dir still allows its plain files (amendment 2026-10-21)', () => {
    assert.equal(confineUploadPath(join(root, '.hidden', 'x.txt'), [join(root, '.hidden')], false), join(root, '.hidden', 'x.txt'));
  });
  it('missing files and directories are refused', () => {
    denied(join(root, 'nope.txt'), /does not exist/);
    denied(join(root, 'sub'), /not a regular file/);
  });
});

describe('filename sanitising (PLAN: no separators, no .., no leading dot, <= 120 chars)', () => {
  it('strips directories and separators', () => {
    assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd');
    assert.ok(!sanitizeFilename('a\\b\\c.txt').includes('\\'));
    assert.ok(!sanitizeFilename('a/b').includes('/'));
  });
  it('no ".." and no leading dot', () => {
    for (const n of ['..', '.bashrc', '...x', 'a..b', '. .env']) {
      const s = sanitizeFilename(n);
      assert.ok(!s.includes('..'), `${n} -> ${s}`);
      assert.ok(!s.startsWith('.'), `${n} -> ${s}`);
      assert.ok(s.length > 0);
    }
  });
  it('control characters and reserved chars are replaced', () => {
    assert.equal(sanitizeFilename('a\u0000b:c*?.pdf'), 'a_b_c__.pdf');
  });
  it('at most 120 chars, keeping the extension', () => {
    const s = sanitizeFilename(`${'x'.repeat(300)}.pdf`);
    assert.equal(s.length, 120);
    assert.ok(s.endsWith('.pdf'));
  });
  it('collisions get a numeric suffix and stay inside the dir', () => {
    const taken = new Set(['/d/report.pdf', '/d/report-1.pdf']);
    assert.equal(uniquePathIn('/d', 'report.pdf', (p) => taken.has(p)), '/d/report-2.pdf');
    assert.equal(uniquePathIn('/d', '../../x.txt', () => false), '/d/x.txt');
  });
});
