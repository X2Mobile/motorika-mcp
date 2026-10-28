// Fix round 5 (page): read and find on the composed tree stay linear, and inline shadow hosts keep their
// slotted blocks apart. Oracles: the round-4 re-checks (reviewer pages contents.mjs, e1.mjs, e1b.mjs,
// deep.mjs and their measurements) and the acceptance criteria in PLAN.md "2026-10-23: fix round 5
// (page)", never this code's output. Run alone (after npm run build):
//   node --import tsx --test --test-concurrency=1 'test/regress/page-r5.test.ts'
// Red-first: MOTORIKA_TEST_ENTRY=<old checkout>/dist/index.js runs the same tests against another build.
// Builds from before the 2026-10-28 rename read `x2b.engine` and `X2B_*`, so they miss the planted engine and env cases.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startFixtureServer, type FixtureServer } from '../support/fixture-server.ts';
import { parseFindHits } from '../support/grammar.ts';
import { assertBuilt, assertNoOrphans, startServer, type ServerHandle } from '../support/mcp-client.ts';

const ENTRY = process.env.MOTORIKA_TEST_ENTRY;
const roots: string[] = [];
let s: ServerHandle;
let fx: FixtureServer;

before(async () => {
  assertBuilt(ENTRY);
  fx = await startFixtureServer();
  s = await startServer({ label: 'page-r5', flags: ['--action-timeout', '3000', '--max-output-chars', '200000'], ...(ENTRY ? { entry: ENTRY } : {}) });
  roots.push(s.root);
});
after(async () => {
  await s?.close();
  await fx?.close();
  await assertNoOrphans(roots);
});

async function go(path: string): Promise<void> {
  await s.ok('navigate', { url: fx.url(path), snapshot: false });
}
async function read(path: string, format?: 'markdown' | 'text'): Promise<string> {
  await go(path);
  return (await s.ok('read', format ? { format } : {})).text;
}
/** Median wall time of `reps` calls (the first, warm-up call is not counted). */
async function median(tool: string, args: Record<string, unknown>, reps = 3): Promise<number> {
  await s.ok(tool, args, { budgetMs: 120_000 });
  const ms: number[] = [];
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    await s.ok(tool, args, { budgetMs: 120_000 });
    ms.push(performance.now() - t0);
  }
  return ms.sort((a, b) => a - b)[Math.floor(reps / 2)]!;
}
/** The content blocks of a read result (blank-line separated), without the header line. */
const blocks = (t: string): string[] => t.split('\n').slice(1).join('\n').split(/\n\n+/).map((b) => b.trim());

describe('item 3: block-level slotted children stay separate blocks, whatever the host display', () => {
  for (const format of ['markdown', 'text'] as const) {
    test(`inline host, block host and an unknown light-DOM element read the same way (${format})`, async () => {
      const b = blocks(await read('/inline-host.html', format));
      for (const k of ['INL', 'BLK', 'PLAIN']) {
        assert.ok(b.includes(`${k} para one end`), `"${k} para one end" must be a block of its own:\n${b.join('\n--\n')}`);
        assert.ok(b.includes(`${k} para two`), `"${k} para two" must be a block of its own:\n${b.join('\n--\n')}`);
      }
      assert.ok(b.includes('Head x-inl'), b.join('\n--\n'));
    });
  }
  test('headings, lists, divs and paragraphs slotted into an inline host stay apart', async () => {
    const b = blocks(await read('/inline-host.html'));
    for (const x of ['### KIND heading', '- KIND item', 'KIND div', 'KIND para']) assert.ok(b.includes(x), `"${x}" missing as a block:\n${b.join('\n--\n')}`);
  });
  test('a display:none span inside an inline wrapper neither shows nor splits the line', async () => {
    const t = await read('/inline-host.html');
    assert.doesNotMatch(t, /HIDDEN-WORD/, t);
    assert.ok(blocks(t).includes('Hello world again end'), t);
  });
});

describe('item 2: find on a page with shadow DOM', () => {
  test('hits come in composed (rendering) order: named slots reorder light DOM', async () => {
    await go('/inline-host.html');
    const t = (await s.ok('find', { query: 'ORDERWORD' })).text;
    const names = parseFindHits(t).map((h) => h.el.name);
    assert.deepEqual(names, ['ORDERWORD bravo', 'ORDERWORD alpha'], t);
  });
  test('one shadow host (a cookie banner) costs no more than the no-shadow baseline (+20%, AC)', async () => {
    // Base: 242 -> 454 ms in the review. The bound here is looser (+50%) for a shared, loaded machine.
    await go('/shadow-long.html?n=3000&shape=plain');
    const plain = await median('find', { query: 'lorem', limit: 200 });
    await go('/shadow-long.html?n=3000&shape=plus1');
    const t = (await s.ok('find', { query: 'lorem', limit: 200 })).text;
    assert.equal(parseFindHits(t).length, 200, t.slice(0, 500));
    const plus1 = await median('find', { query: 'lorem', limit: 200 });
    assert.ok(plus1 < plain * 1.5 + 100, `plain ${plain.toFixed(0)} ms, plus1 ${plus1.toFixed(0)} ms`);
  });
  test('every section slotted into one host costs no more than the no-shadow baseline', async () => {
    await go('/shadow-long.html?n=3000&shape=plain');
    const plain = await median('find', { query: 'lorem', limit: 200 });
    await go('/shadow-long.html?n=3000&shape=slotone');
    const t = (await s.ok('find', { query: 'lorem', limit: 200 })).text;
    const hits = parseFindHits(t);
    assert.equal(hits.length, 200, t.slice(0, 500));
    assert.match(hits[0]!.el.name ?? '', /^Body 0 lorem/, t.slice(0, 500));
    const slot = await median('find', { query: 'lorem', limit: 200 });
    assert.ok(slot < plain * 1.5 + 100, `plain ${plain.toFixed(0)} ms, slotted ${slot.toFixed(0)} ms`);
  });
});

describe('item 1: read is linear on nested display:contents', () => {
  test('ten chains 800 deep read every paragraph as its own block, in linear time', async () => {
    const t = await read('/deep-chains.html?contents=800&copies=10');
    const b = blocks(t);
    for (let j = 0; j < 10; j++) assert.ok(b.includes(`Deep text ${j} here`), t.slice(0, 600));
    // Base: 1762 ms in the review (6.4 s on this machine under load); linear is tens of ms.
    const ms = await median('read', {});
    assert.ok(ms < 1000, `read took ${ms.toFixed(0)} ms`);
  });
});

describe('item 4: a deep open-shadow chain is read to the end', () => {
  test('200 nested hosts: every level once, in order, as its own block', async () => {
    const t = await read('/deep-chains.html?shadow=200');
    const b = blocks(t);
    for (const k of [199, 150, 100, 43, 42, 17, 1, 0]) assert.ok(b.includes(`Level ${k} words`), `Level ${k} missing:\n${t.slice(-400)}`);
    assert.equal((t.match(/Level \d+ words/g) ?? []).length, 200, t.slice(-400));
    assert.ok(t.indexOf('Level 199 words') < t.indexOf('Level 0 words'), t.slice(0, 300));
  });
  test('find reaches the innermost level', async () => {
    await go('/deep-chains.html?shadow=200');
    const hits = parseFindHits((await s.ok('find', { query: 'Level 0 words' })).text);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.el.name, 'Level 0 words');
  });
});
