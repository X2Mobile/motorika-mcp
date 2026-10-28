// Harness: the cross-process Chrome semaphore (test/support/slots.ts). Expectations come from the brief for
// the 2026-10-23 r4-merge failure: "acquisition must not deadlock" and "a leaked lease must be released even
// when a test fails". The deadlock scenario is the one the full suite hit: core-r4c G2 held one of two slots
// while waiting for another, and page-r3 P3 did the same, so both waited 15 min for each other.
// Each child gets its own MOTORIKA_TEST_ROOT, so these tests never touch the suite's slots.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { freshDir, REPO_ROOT } from '../support/paths.ts';

const CHILD = join(REPO_ROOT, 'test', 'harness', 'slots-child.ts');

function child(root: string, args: string[]): { proc: ChildProcess; out: () => string; exited: Promise<number | null> } {
  const proc = spawn(process.execPath, ['--import', 'tsx', CHILD, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, MOTORIKA_TEST_ROOT: root, MOTORIKA_TEST_CHROME_SLOTS: '2' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout!.on('data', (d: Buffer) => (out += d.toString()));
  proc.stderr!.on('data', (d: Buffer) => (out += d.toString()));
  const exited = new Promise<number | null>((ok) => proc.once('exit', (code) => ok(code)));
  return { proc, out: () => out, exited };
}

async function within<T>(ms: number, p: Promise<T>): Promise<T | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<'timeout'>((ok) => (timer = setTimeout(() => ok('timeout'), ms)));
  try {
    return await Promise.race([p, t]);
  } finally {
    clearTimeout(timer);
  }
}

describe('Chrome slots across processes', () => {
  test('two processes that each hold 1 of 2 slots and ask for 1 more both finish (no hold-and-wait deadlock)', async () => {
    const root = freshDir('slt');
    const barrier = join(root, 'barrier');
    mkdirSync(barrier);
    const a = child(root, ['cycle', barrier]);
    const b = child(root, ['cycle', barrier]);
    try {
      const r = await within(30_000, Promise.all([a.exited, b.exited]));
      assert.notEqual(r, 'timeout', `deadlocked:\nA: ${a.out()}\nB: ${b.out()}`);
      assert.deepEqual(r, [0, 0], `A: ${a.out()}\nB: ${b.out()}`);
      assert.match(a.out(), /^done$/m);
      assert.match(b.out(), /^done$/m);
    } finally {
      a.proc.kill('SIGKILL');
      b.proc.kill('SIGKILL');
    }
  });

  test('a holder killed without releasing (a failed test file) gives its slots back to the next process', async () => {
    const root = freshDir('slk');
    const h = child(root, ['hold']);
    try {
      for (let i = 0; i < 300 && !/held/.test(h.out()); i++) await new Promise((ok) => setTimeout(ok, 50));
      assert.match(h.out(), /held/, h.out());
      h.proc.kill('SIGKILL');
      await h.exited;
      const t = child(root, ['take']);
      const r = await within(15_000, t.exited);
      t.proc.kill('SIGKILL');
      assert.equal(r, 0, `the next process did not get the dead holder's slots: ${t.out()}`);
      assert.match(t.out(), /took/);
    } finally {
      h.proc.kill('SIGKILL');
    }
  });
});
