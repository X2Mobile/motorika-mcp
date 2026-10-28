// merge-agent.mjs: two sessions of one round become one report input; overlaps and mismatches are refused.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mergeAgent } from './merge-agent.mjs';

const run = (contender, task, rep, cost) => ({ contender, task, rep, success: true, wall_ms: 1000, total_cost_usd: cost, file: `results/agent/x/${task}-${contender}-rep${rep}.jsonl` });
const part = (date, tools, extra = {}) => ({
  kind: 'agent', date, model: 'm', timeout_min: 6, plan: { tag: date }, start: { uptime: `up-${date}` }, end: { uptime: `end-${date}` },
  warmups: tools.map((c) => ({ contender: c })), skipped: [], runs: tools.flatMap((c) => [run(c, 'T1', 1, 0.1), run(c, 'T2', 1, null)]), ...extra,
});

describe('mergeAgent', () => {
  const a = part('2026-10-26T14:00:00Z', ['motorika', 'playwright'], { voided: [{ contender: 'playwright', task: 'T1', rep: 2 }], resumed_at: [{ at: 't' }] });
  const b = part('2026-10-27T15:00:00Z', ['browsermcp'], { skipped: [{ contender: 'browsermcp', reason: 'T1 failed twice; remaining agent runs stopped per the budget rule' }] });
  const m = mergeAgent([a, b]);
  it('keeps every run, skip, void, resume and warm-up of both parts', () => {
    assert.equal(m.runs.length, 6);
    assert.deepEqual(m.skipped, b.skipped);
    assert.deepEqual(m.voided, a.voided);
    assert.deepEqual(m.resumed_at, a.resumed_at);
    assert.equal(m.warmups.length, 3);
  });
  it('sums only known costs and labels each part with its date and tools', () => {
    assert.ok(Math.abs(m.total_cost_usd - 0.3) < 1e-9);
    assert.equal(m.date, '2026-10-26 + 2026-10-27');
    assert.deepEqual(m.merged_from, ['2026-10-26 (motorika, playwright)', '2026-10-27 (browsermcp)']);
    assert.equal(m.start.uptime, '2026-10-26 (motorika, playwright): up-2026-10-26T14:00:00Z; 2026-10-27 (browsermcp): up-2026-10-27T15:00:00Z');
    assert.equal(m.kind, 'agent');
    assert.equal(m.timeout_min, 6);
  });
  it('refuses a tool that has runs in two inputs', () => {
    assert.throws(() => mergeAgent([a, part('2026-10-27T15:00:00Z', ['playwright'])]), /playwright has runs in two inputs/);
  });
  it('reads the pre-rename id x2-browser as motorika, so a file from each side of the rename is refused', () => {
    const legacy = part('2026-10-26T14:00:00Z', ['x2-browser']);
    assert.throws(() => mergeAgent([legacy, part('2026-10-29T10:00:00Z', ['motorika'])]), /motorika has runs in two inputs/);
    assert.deepEqual(mergeAgent([legacy, b]).merged_from, ['2026-10-26 (motorika)', '2026-10-27 (browsermcp)']);
  });
  it('refuses a different model or hard timeout', () => {
    assert.throws(() => mergeAgent([a, { ...b, model: 'other' }]), /model differs/);
    assert.throws(() => mergeAgent([a, { ...b, timeout_min: 10 }]), /hard timeout differs/);
  });
  it('refuses a single input', () => {
    assert.throws(() => mergeAgent([a]), /at least two/);
  });
});
