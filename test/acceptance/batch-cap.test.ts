// 2026-10-26: batch shares the output cap per step (PLAN amendment of that date).
//
// Incident (old.reddit, 2026-10-26): a 20-step batch (navigate + evaluate + wait, repeated) went past the
// 20,000-char cap; after step 13 the output ended with `… output cut at 20000 chars` and steps 14-20 were
// gone, although they ran. Oracle: the acceptance criteria of that amendment, never this code's output.
//   AC1 every step keeps its `## step <n>: <tool>` header and the first line of its own result; an error step
//       keeps its cause and hint lines.
//   AC2 the budget is shared: one huge step does not starve the later ones; a cut body ends with
//       `… <k> chars cut from step <n> (rerun it alone, or use read/snapshot with offset)`; the whole result
//       stays within --max-output-chars. Images are kept.
// Run alone (after npm run build):
//   node --import tsx --test --test-concurrency=1 'test/acceptance/batch-cap.test.ts'
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startFixtureServer, type FixtureServer } from '../support/fixture-server.ts';
import { assertBuilt, assertNoOrphans, startServer, type ServerHandle } from '../support/mcp-client.ts';

const CAP = 20000;
const NOTE = /^… (\d+) chars cut from step (\d+) \(rerun it alone, or use read\/snapshot with offset\)$/;

let fx: FixtureServer;
let s: ServerHandle;
const roots: string[] = [];

before(async () => {
  assertBuilt();
  fx = await startFixtureServer();
  // The entry can be pointed at another build (red-first: MOTORIKA_TEST_ENTRY=<old checkout>/dist/index.js).
  // Builds from before the 2026-10-28 rename read `x2b.engine` and `X2B_*`, so they miss the planted engine and env cases.
  const entry = process.env.MOTORIKA_TEST_ENTRY;
  s = await startServer({ label: 'batch-cap', flags: ['--max-output-chars', String(CAP)], ...(entry ? { entry } : {}) });
  roots.push(s.root);
});
after(async () => {
  await s?.close();
  await fx?.close();
  await assertNoOrphans(roots);
});

interface Section {
  n: number;
  tool: string;
  error: boolean;
  lines: string[];
}

/** Splits a batch result at its `## step <n>: <tool>` header lines. */
function sections(text: string): Section[] {
  const out: Section[] = [];
  for (const line of text.split('\n')) {
    const m = /^## step (\d+): (\w+)( \(error\))?$/.exec(line);
    if (m) {
      out.push({ n: Number(m[1]), tool: m[2]!, error: m[3] !== undefined, lines: [] });
      continue;
    }
    out.at(-1)?.lines.push(line);
  }
  return out;
}

const firstLine = (t: string): string => t.split('\n')[0] ?? '';
/** Durations differ run to run (`waited for 1ms (2ms)`): compared as `<n>ms`. */
const timeless = (l: string | undefined): string => (l ?? '').replace(/\b\d+ms\b/g, '<n>ms');

describe('batch shares the output cap per step', () => {
  test('AC5 incident shape: 20 steps (navigate, evaluate, wait) over the cap keep every header and first line', async () => {
    const triple = (i: number) => [
      { tool: 'navigate', args: { url: fx.url(`/big-1000.html?i=${i}`) } },
      { tool: 'evaluate', args: { script: `"${String.fromCharCode(97 + i)}".repeat(2500)` } },
      { tool: 'wait', args: { ms: 1 } },
    ];
    const steps = Array.from({ length: 7 }, (_, i) => triple(i)).flat().slice(0, 20);
    const r = await s.call('batch', { steps });
    const sec = sections(r.text);
    assert.deepEqual(sec.map((x) => x.n), Array.from({ length: 20 }, (_, i) => i + 1), `AC1 every header, in order:\n${r.text.slice(-600)}`);
    // The consumer's view (text parts joined by a newline) stays within the cap.
    assert.ok(r.text.length <= CAP, `AC2: ${r.text.length} > ${CAP}`);
    assert.deepEqual(sec.map((x) => x.tool), steps.map((x) => x.tool));
    // AC1: the first line of each step's own result. Its expected shape comes from the tool alone.
    const alone = {
      navigate: firstLine((await s.ok('navigate', { url: fx.url('/big-1000.html?i=x') })).text),
      evaluate: firstLine((await s.ok('evaluate', { script: '"z".repeat(2500)' })).text),
      wait: firstLine((await s.ok('wait', { ms: 1 })).text),
    };
    for (const x of sec) {
      const want = alone[x.tool as keyof typeof alone].replace(/i=x/, `i=${Math.floor((x.n - 1) / 3)}`);
      assert.equal(timeless(x.lines[0]), timeless(want), `AC1 step ${x.n} first line`);
    }
    // AC2: a cut body ends with its note, naming its own step.
    let cut = 0;
    for (const x of sec) {
      const body = x.lines.filter((l) => l !== '');
      const last = body.at(-1) ?? '';
      const m = NOTE.exec(last);
      if (!m) continue;
      cut++;
      assert.equal(Number(m[2]), x.n, `note of step ${x.n}: ${last}`);
      assert.ok(Number(m[1]) > 0);
    }
    assert.ok(cut > 0, 'the batch was over the cap, so some body was cut');
    assert.ok(!/output cut at/.test(r.text), 'the batch shares the cap itself; the generic cut note does not fire');
  });

  test('AC2 one huge step does not starve the later steps', async () => {
    const steps = [
      { tool: 'evaluate', args: { script: '"H".repeat(60000)' } },
      ...Array.from({ length: 5 }, (_, i) => ({ tool: 'evaluate', args: { script: `"${i}".repeat(1500)` } })),
    ];
    const r = await s.call('batch', { steps });
    assert.ok(r.text.length <= CAP, `${r.text.length} > ${CAP}`);
    const sec = sections(r.text);
    assert.deepEqual(sec.map((x) => x.n), [1, 2, 3, 4, 5, 6]);
    for (const x of sec.slice(1)) {
      // Each later step keeps its whole value: 1500 chars is well under an even share of the cap.
      assert.ok(x.lines.some((l) => l === JSON.stringify(String(x.n - 2).repeat(1500))), `step ${x.n} kept whole:\n${x.lines.join('\n').slice(0, 300)}`);
    }
    const one = sec[0]!.lines.filter((l) => l !== '');
    assert.match(one.at(-1) ?? '', NOTE);
    assert.equal(Number(NOTE.exec(one.at(-1)!)![2]), 1);
    // The cut value still closes its JSON string (never split mid-string).
    const value = one[1] ?? '';
    assert.match(value, /^"H+…"$/, value.slice(0, 80));
    assert.doesNotThrow(() => JSON.parse(value));
  });

  test('AC1 an error step keeps its cause and hint; skipped steps keep their headers; images are kept', async () => {
    const steps = [
      { tool: 'evaluate', args: { script: '"A".repeat(15000)' } },
      { tool: 'screenshot', args: {} },
      { tool: 'evaluate', args: { script: '"B".repeat(15000)' } },
      { tool: 'click', args: { target: '#does-not-exist', timeout_ms: 300 } },
      { tool: 'evaluate', args: { script: '1' } },
      { tool: 'wait', args: { ms: 1 } },
    ];
    await s.ok('navigate', { url: fx.url('/click.html'), snapshot: false });
    const alone = await s.call('click', { target: '#does-not-exist', timeout_ms: 300 });
    assert.equal(alone.isError, true);
    const r = await s.call('batch', { steps });
    assert.equal(r.isError, true);
    assert.ok(r.text.length <= CAP, `${r.text.length} > ${CAP}`);
    const sec = sections(r.text);
    assert.deepEqual(sec.map((x) => `${x.n}:${x.tool}${x.error ? '!' : ''}`), ['1:evaluate', '2:screenshot', '3:evaluate', '4:click!', '5:evaluate', '6:wait']);
    // The cause and the hint lines in full (the cause of the same call made alone).
    const cause = firstLine(alone.text);
    const hint = alone.text.split('\n').find((l) => l.startsWith('hint: '))!;
    assert.equal(sec[3]!.lines[0], cause);
    assert.ok(sec[3]!.lines.includes(hint), sec[3]!.lines.join('\n'));
    for (const x of sec.slice(4)) assert.deepEqual(x.lines.filter((l) => l !== ''), ['skipped']);
    assert.equal(r.content.filter((c) => c.type === 'image').length, 1, 'the screenshot image is kept');
    assert.ok(sec.some((x) => NOTE.test(x.lines.filter((l) => l !== '').at(-1) ?? '')), 'something was cut');
  });

  test('review of cc50db4, item 1: 12 screenshot steps at cap 400 keep whole headers, within the cap, images kept', async () => {
    const small = await startServer({ label: 'batch-cap-400', flags: ['--max-output-chars', '400'], ...(process.env.MOTORIKA_TEST_ENTRY ? { entry: process.env.MOTORIKA_TEST_ENTRY } : {}) });
    roots.push(small.root);
    try {
      await small.ok('navigate', { url: fx.url('/click.html'), snapshot: false });
      const r = await small.call('batch', { steps: Array.from({ length: 12 }, () => ({ tool: 'screenshot', args: {} })) });
      assert.ok(r.text.length <= 400, `${r.text.length} > 400`);
      const lines = r.text.split('\n');
      const heads = lines.filter((l) => l.startsWith('## '));
      heads.forEach((h, i) => assert.equal(h, `## step ${i + 1}: screenshot`, `whole header ${i + 1}:\n${r.text}`));
      assert.match(lines.at(-1) ?? '', /^… steps? [\d, -]+: no room; rerun (them|it)$/, r.text);
      // Every step without a header is named on that line (`1-5, 7`: numbers and ranges).
      const list = /^… steps? ([\d, -]+):/.exec(lines.at(-1) ?? '')?.[1] ?? '';
      const named = new Set(list.split(', ').flatMap((x) => {
        const [a, b] = x.split('-').map(Number) as [number, number | undefined];
        return Array.from({ length: (b ?? a) - a + 1 }, (_, i) => a + i);
      }));
      for (let n = heads.length + 1; n <= 12; n++) assert.ok(named.has(n), `step ${n} named: ${lines.at(-1)}`);
      assert.equal(r.content.filter((c) => c.type === 'image').length, 12);
    } finally {
      await small.close();
    }
  });
});
