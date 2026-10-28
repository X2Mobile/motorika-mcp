// Fix round 3, C3/C4 (performance round 2, item 11): the reviewer's refsmicro.mjs scenario as a test.
// "A page re-renders 1,000 rows per cycle and has a 'Home' button that never leaves the DOM ... e1 still
// clicks at cycle 300. Live refs stay bounded. A re-issued ref refreshes its recency." C4: "issuing is
// amortised O(1)" (before: 1,001 refs in 34.4 ms past the cap, 0.6 ms before it).
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { describe, test } from 'node:test';
import { FORGOTTEN_CAP, LIVE_PER_DOC_CAP, RefRegistry } from '../../src/browser/refs.ts';

function median(xs: number[]): number {
  const a = [...xs].sort((x, y) => x - y);
  return a[a.length >> 1] ?? NaN;
}

describe('C3/C4 ref recency and the per-document cap', () => {
  test('300 cycles of 1000 new rows: Home keeps its ref, evicted rows are stale, live refs bounded, issue O(1)', () => {
    const reg = new RefRegistry<string>();
    for (let k = 0; k < 100; k++) reg.issue({ tabId: 't2', frame: 'f2', docId: 'd2', localId: k, role: 'button', name: 'x' });
    const home = () => reg.issue({ tabId: 't1', frame: 'f1', docId: 'd1', localId: 0, role: 'button', name: 'Home' });
    const e1 = home();
    let local = 1;
    let firstRow = 0;
    let recentRow = 0;
    const early: number[] = [];
    const late: number[] = [];
    for (let c = 1; c <= 300; c++) {
      const t = performance.now();
      assert.equal(home(), e1, `Home got another ref at cycle ${c}`);
      for (let k = 0; k < 1000; k++) {
        const r = reg.issue({ tabId: 't1', frame: 'f1', docId: 'd1', localId: local++, role: 'button', name: `Row ${k}` });
        if (c === 1 && k === 0) firstRow = r;
        if (c === 275 && k === 0) recentRow = r;
      }
      (c <= 20 ? early : c > 280 ? late : []).push(performance.now() - t);
    }
    assert.ok(reg.get(e1), 'Home (e1) is live at cycle 300');
    assert.equal(reg.get(e1)?.name, 'Home');
    assert.equal(reg.get(firstRow), undefined, 'the first row was evicted');
    // The first row's reason has aged out of the FORGOTTEN_CAP most recent; a recently evicted row has it.
    assert.equal(reg.get(recentRow), undefined, 'a row of cycle 275 was evicted');
    assert.equal(reg.whyMissing(recentRow).reason, 'stale', 'an evicted ref gets the stale-ref error, not "earlier document"');
    assert.ok(reg.size <= LIVE_PER_DOC_CAP + 100, `live refs ${reg.size} > cap`);
    assert.ok(reg.forgottenSize <= 3 * FORGOTTEN_CAP, `forgotten refs ${reg.forgottenSize} unbounded`);
    // Amortised O(1): issuing past the cap costs about what it costs below it (generous bound for CI noise).
    const lo = median(early);
    const hi = median(late);
    assert.ok(hi < Math.max(5, lo * 4), `1001 issues past the cap: median ${hi.toFixed(2)} ms vs ${lo.toFixed(2)} ms before it`);
  });

  test('a ref of another tab keeps its earlier-document reason after the cap churns', () => {
    const reg = new RefRegistry<string>();
    const r = reg.issue({ tabId: 't9', frame: 'f9', docId: 'old', localId: 1, role: 'link', name: 'a' });
    reg.forgetFrame('t9', 'f9');
    assert.equal(reg.whyMissing(r).reason, 'old-doc');
    let local = 0;
    for (let k = 0; k < LIVE_PER_DOC_CAP + 5000; k++) reg.issue({ tabId: 't1', frame: 'f1', docId: 'd', localId: local++, role: 'button', name: 'r' });
    assert.equal(reg.whyMissing(r).reason, 'old-doc');
  });

  test('retireLocals gives the stale-ref reason', () => {
    const reg = new RefRegistry<string>();
    const r = reg.issue({ tabId: 't1', frame: 'f1', docId: 'd', localId: 7, role: 'button', name: 'b' });
    reg.retireLocals('d', [7]);
    assert.equal(reg.get(r), undefined);
    assert.deepEqual(reg.whyMissing(r), { reason: 'stale', tabId: 't1' });
  });
});
