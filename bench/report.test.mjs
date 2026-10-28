// report.mjs on a round-2 shaped file: 5 tasks x 8 tools, one invalid T5 run. Expected numbers are worked by hand.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { agentCross, agentCsv, agentTables, normalizeIds, prepareRuns } from './report.mjs';

const TOOLS = ['motorika', 'playwright', 'playwright-vision', 'devtools', 'agent-infra', 'puppeteer', 'browsermcp', 'claude-in-chrome'];
const TASKS = ['T1', 'T2', 'T3', 'T4', 'T5'];
const run = (contender, task, rep, wallS, cost, ok = true) => ({ contender, task, rep, success: ok, wall_ms: wallS * 1000, total_cost_usd: cost, tool_calls: 3, tool_result_chars: 1000, tool_result_images: 0, detail: 'x', answer_ok: ok, evidence_ok: ok });
const runs = [];
for (const t of TASKS) for (const id of TOOLS) for (const rep of [1, 2, 3]) runs.push(run(id, t, rep, 10 * rep, 0.1 * rep));
// motorika T4: walls 10, 20, 90 s -> median 20, min 10, max 90; one failure.
runs.find((r) => r.contender === 'motorika' && r.task === 'T4' && r.rep === 3).wall_ms = 90_000;
runs.find((r) => r.contender === 'motorika' && r.task === 'T4' && r.rep === 3).success = false;
const invalid = { contender: 'playwright', task: 'T5', rep: 4, invalid: true, invalid_reason: 'page changed: Security Now', success: false, total_cost_usd: 0, tool_calls: 0, tool_result_chars: 0, wall_ms: 0, file: null };
const agent = { kind: 'agent', date: 'd', model: 'm', timeout_min: 6, plan: {}, start: { uptime: 'u' }, end: { uptime: 'u' }, skipped: [], total_cost_usd: 1, runs: [...runs, invalid] };

describe('cross-tool summary', () => {
  const cross = agentCross(prepareRuns(agent, () => null).valid);
  const lines = cross.split('\n').filter((l) => l.startsWith('|'));
  it('has one column per tool (8) and one row per task (5) plus the overall row', () => {
    assert.equal(lines[0].split('|').length - 3, 8);
    assert.equal(lines.length, 2 + 5 + 1);
    for (const t of ['T1 form', 'T2 Wikipedia', 'T3 three tabs', 'T4 shop checkout', 'T5 long thread']) assert.ok(cross.includes(`| ${t} |`), t);
  });
  it('cells give ok/n, median [min–max] wall and cost', () => {
    const t4 = lines.find((l) => l.startsWith('| T4'));
    const x2 = t4.split(' | ')[1];
    assert.equal(x2, '2/3; 20.0 [10.0–90.0] s; $0.200 [0.100–0.300]');
  });
  it('overall row is like-for-like: mean of per-task means over the named task set', () => {
    const all = lines.at(-1).split(' | ');
    assert.match(all[0], /Like-for-like mean over T1, T2, T3, T4, T5/);
    // motorika task means: 20, 20, 20, 20 and T4 (10+20+90)/3 = 40 -> (4*20 + 40) / 5 = 24.0 s; cost 0.2.
    assert.equal(all[1], '14/15; mean 24.0 s; mean $0.200');
    // playwright: the invalid run is excluded, so 15 runs, mean 20.0 s.
    assert.equal(all[2], '15/15; mean 20.0 s; mean $0.200');
  });
});

describe('tables', () => {
  const t = agentTables(agent, () => null);
  it('summary covers all 5 tasks x 8 tools and drops the invalid run', () => {
    assert.equal(t.summary.split('\n').length - 2, 40);
    assert.ok(t.summary.includes('| T5 | playwright | 3/3 |'));
  });
  it('detail lists the invalid run separately, not as a failure', () => {
    assert.match(t.detail, /Invalid \(page changed[^\n]*\n- T5 playwright rep4: page changed: Security Now/);
    assert.ok(!/\| T5 \| playwright \| 4 \|/.test(t.detail));
  });
});

describe('per-run CSV', () => {
  const csv = agentCsv(agent, () => null).trim().split('\n');
  it('has the columns charts need, one row per run', () => {
    assert.equal(csv[0], 'tool,task,rep,ok,wall_s,cost_usd,calls,result_chars,timed_out,invalid');
    assert.equal(csv.length, 1 + 120 + 1);
  });
  it('writes measured runs with numbers and invalid runs as invalid=1', () => {
    assert.ok(csv.includes('motorika,T4,3,0,90.0,0.3000,3,1000,0,0'));
    assert.ok(csv.includes('playwright,T5,4,,,,,,,1'));
  });
});

// Review item 1: a run killed at the timeout has total_cost_usd null and no result line.
describe('timed-out runs: no $0, the same figure everywhere, counted as failures', () => {
  const mk = (rep, wallS, cost, extra = {}) => ({ ...run('devtools', 'T5', rep, wallS, cost), ...extra });
  const timeoutRun = mk(3, 360, null, { timedOut: true, success: true, file: 'results/agent/x/T5-devtools-rep3.jsonl' });
  const a = { ...agent, runs: [mk(1, 10, 0.1), mk(2, 20, 0.3), timeoutRun] };
  it('without a stream cost: n/a in the detail, a dagger in every aggregate, never $0', () => {
    const t = agentTables(a, () => null);
    const sumRow = t.summary.split('\n').find((l) => l.startsWith('| T5 | devtools'));
    assert.equal(sumRow.split(' | ')[2], '2/3', 'the timeout is a failure even though success was true');
    assert.match(sumRow, /\| 0\.200† \(1 of 3 without cost\) \|/, 'median of the two known costs, marked');
    assert.ok(!/\| 0\.000 \|/.test(t.summary + t.detail), 'no $0 anywhere');
    assert.match(t.detail, /\| T5 \| devtools \| 3 \| NO \| 360\.0 .*\| n\/a† \| TIMEOUT/);
    assert.match(t.detail, /total cost \$0\.40† \+ n\/a for 1 run\(s\) without cost/);
    assert.match(t.summary + t.detail, /killed at the hard timeout/);
    const cross = t.cross.split('\n').find((l) => l.startsWith('| T5'));
    assert.match(cross, /2\/3; 20\.0 \[10\.0–360\.0\] s; \$0\.200 \[0\.100–0\.300\]† \(1 of 3 without cost\)/, 'same median as the summary, and the timeout\'s wall time counts');
    assert.match(t.cross, /killed at the hard timeout/);
  });
  it('recovers the cost from the saved stream when its result line is there', () => {
    const t = agentTables(a, (file) => (file === timeoutRun.file ? 0.9 : null));
    const sumRow = t.summary.split('\n').find((l) => l.startsWith('| T5 | devtools'));
    assert.match(sumRow, /\| 0\.300 \|/, 'median of 0.1, 0.3, 0.9');
    assert.ok(!t.summary.includes('†'));
    assert.match(t.detail, /\| T5 \| devtools \| 3 \| NO \| .*\| 0\.900 \| TIMEOUT/);
  });
  it('the CSV leaves an unknown cost empty and flags the timeout', () => {
    const csv = agentCsv(a, () => null);
    assert.ok(csv.includes('devtools,T5,3,0,360.0,,3,1000,1,0'), csv);
  });
});

// Review item 3: the headline row must compare the same tasks for every tool.
describe('like-for-like overall row', () => {
  it('uses only the tasks every tool ran, names them, and says what was left out and why', () => {
    const runs = [run('motorika', 'T1', 1, 10, 0.1), run('motorika', 'T3', 1, 100, 1.0), run('puppeteer', 'T1', 1, 30, 0.3)];
    const cross = agentCross(prepareRuns({ runs }, () => null).valid);
    const last = cross.split('\n').find((l) => l.includes('Like-for-like'));
    assert.match(last, /Like-for-like mean over T1\*\*/);
    assert.equal(last.split(' | ')[1], '1/1; mean 10.0 s; mean $0.100', 'x2 T3 (100 s, $1) must not enter the comparison');
    assert.match(cross, /Left out of the like-for-like row: T3 \(no valid runs: puppeteer\)/);
  });
  it('weights each task equally, whatever the run count per task', () => {
    const runs = [run('motorika', 'T1', 1, 10, 0.1), run('motorika', 'T1', 2, 10, 0.1), run('motorika', 'T1', 3, 10, 0.1), run('motorika', 'T2', 1, 40, 0.4), run('playwright', 'T1', 1, 10, 0.1), run('playwright', 'T2', 1, 40, 0.4)];
    const last = agentCross(prepareRuns({ runs }, () => null).valid).split('\n').find((l) => l.includes('Like-for-like'));
    assert.equal(last.split(' | ')[1], '4/4; mean 25.0 s; mean $0.250', '(10 + 40) / 2, not (3*10 + 40) / 4');
    assert.equal(last.split(' | ')[2].replace(/ \|$/, ''), '2/2; mean 25.0 s; mean $0.250');
  });
  it('says so when no task is common to all tools', () => {
    const runs = [run('motorika', 'T1', 1, 10, 0.1), run('puppeteer', 'T2', 1, 30, 0.3)];
    const cross = agentCross(prepareRuns({ runs }, () => null).valid);
    assert.ok(!cross.includes('| **Like-for-like'));
    assert.match(cross, /no like-for-like overall row/);
  });
});

// Re-check items 2-4.
describe('run total, headline with timeouts, headline scope', () => {
  const T1_STOP = 'T1 failed twice; remaining agent runs stopped per the budget rule';
  const base = { kind: 'agent', date: 'd', model: 'm', timeout_min: 6, plan: {}, start: { uptime: 'u' }, skipped: [] };
  it('a file saved mid-run (no total_cost_usd yet) prints a real total, never $undefined', () => {
    const t = agentTables({ ...base, runs: [run('motorika', 'T1', 1, 10, 0.1), run('motorika', 'T1', 2, 10, 0.3)] }, () => null);
    assert.ok(!t.detail.includes('undefined'), t.detail.split('\n')[0]);
    assert.match(t.detail, /total cost \$0\.40,/);
  });
  it('the header total includes costs recovered from streams, as the tables do', () => {
    const lost = { ...run('motorika', 'T1', 2, 360, null), timedOut: true, file: 'f.jsonl' };
    const t = agentTables({ ...base, total_cost_usd: 0.1, runs: [run('motorika', 'T1', 1, 10, 0.1), lost] }, (f) => (f === 'f.jsonl' ? 0.7 : null));
    assert.match(t.detail, /total cost \$0\.80,/);
  });
  const timeoutRun = (id, task, rep, cost, file) => ({ ...run(id, task, rep, 361, cost), timedOut: true, success: false, file });
  it('headline: an unknown cost makes that tool\'s headline cost "n/a (k runs unknown)", not a mean of the rest', () => {
    const runs = [run('motorika', 'T1', 1, 10, 0.1), timeoutRun('motorika', 'T1', 2, null, null), run('playwright', 'T1', 1, 20, 0.2)];
    const last = agentCross(prepareRuns({ runs }, () => null).valid, { timeoutMin: 6 }).split('\n').find((l) => l.includes('Like-for-like'));
    assert.match(last.split(' | ')[1], /mean \$n\/a \(1 runs unknown\)/);
  });
  it('headline: a recovered cost counts at that cost', () => {
    const runs = [run('motorika', 'T1', 1, 10, 0.1), timeoutRun('motorika', 'T1', 2, null, 'f'), run('playwright', 'T1', 1, 20, 0.2)];
    const last = agentCross(prepareRuns({ runs }, () => 0.9).valid, { timeoutMin: 6 }).split('\n').find((l) => l.includes('Like-for-like'));
    assert.match(last.split(' | ')[1], /mean \$0\.500/);
  });
  it('headline: a timeout counts at the timeout value and is marked', () => {
    const runs = [run('motorika', 'T1', 1, 10, 0.1), timeoutRun('motorika', 'T1', 2, 0.5, null), run('playwright', 'T1', 1, 20, 0.2)];
    const cross = agentCross(prepareRuns({ runs }, () => null).valid, { timeoutMin: 6 });
    const cell = cross.split('\n').find((l) => l.includes('Like-for-like')).split(' | ')[1];
    assert.match(cell, /mean 185\.0 s‡/, '(10 + 360) / 2');
    assert.match(cross, /‡.*timeout.*6 min/);
  });
  it('a tool stopped by the T1 rule does not shrink the headline; it is named as excluded', () => {
    const runs = ['T1', 'T2', 'T3'].flatMap((t) => [run('motorika', t, 1, 10, 0.1), run('playwright', t, 1, 20, 0.2)]).concat([run('puppeteer', 'T1', 1, 30, 0.3, false), run('puppeteer', 'T1', 2, 30, 0.3, false)]);
    const cross = agentCross(prepareRuns({ runs }, () => null).valid, { timeoutMin: 6, stopped: ['puppeteer'] });
    const last = cross.split('\n').find((l) => l.includes('Like-for-like'));
    assert.match(last, /over T1, T2, T3/);
    assert.match(last.split(' | ')[3], /excluded: stopped by the T1 rule/);
    assert.match(cross, /puppeteer.*stopped by the T1 rule/);
  });
  it('agentTables passes the T1-stopped tools from skipped into the headline', () => {
    const runs = ['T1', 'T2'].flatMap((t) => [run('motorika', t, 1, 10, 0.1)]).concat([run('puppeteer', 'T1', 1, 30, 0.3, false)]);
    const t = agentTables({ ...base, skipped: [{ contender: 'puppeteer', reason: T1_STOP }], runs }, () => null);
    assert.match(t.cross, /Like-for-like mean over T1, T2/);
  });
});

// AC (rename 2026-10-28): committed result files keep the pre-rename contender id `x2-browser`; the report reads it as `motorika`.
describe('legacy contender id x2-browser', () => {
  it('micro: the contenders key is renamed in place, order and other keys kept; the numeric runs field is untouched', () => {
    const m = normalizeIds({ runs: 20, contenders: { 'x2-browser': { a: 1 }, playwright: { b: 2 } } });
    assert.deepEqual(Object.keys(m.contenders), ['motorika', 'playwright']);
    assert.deepEqual(m.contenders.motorika, { a: 1 });
    assert.equal(m.runs, 20);
  });
  it('agent: runs, skipped and plan orders are renamed; prose fields stay as recorded', () => {
    const a = normalizeIds({
      kind: 'agent', merged_from: ['2026-10-26 (playwright, x2-browser)'],
      runs: [{ contender: 'x2-browser', task: 'T1' }, { contender: 'playwright', task: 'T1' }],
      skipped: [{ contender: 'x2-browser', reason: 'r' }],
      plan: { seed: 1, planned_orders: [{ block: '1|T1', order: ['x2-browser', 'playwright'] }], orders: [{ block: '1|T1', order: ['playwright', 'x2-browser'] }] },
    });
    assert.deepEqual(a.runs.map((r) => r.contender), ['motorika', 'playwright']);
    assert.deepEqual(a.skipped, [{ contender: 'motorika', reason: 'r' }]);
    assert.deepEqual(a.plan, { seed: 1, planned_orders: [{ block: '1|T1', order: ['motorika', 'playwright'] }], orders: [{ block: '1|T1', order: ['playwright', 'motorika'] }] });
    assert.deepEqual(a.merged_from, ['2026-10-26 (playwright, x2-browser)']);
  });
  it('a legacy file renders the same tables as one recorded under the new id', () => {
    const legacy = { ...agent, runs: agent.runs.map((r) => (r.contender === 'motorika' ? { ...r, contender: 'x2-browser' } : r)) };
    assert.deepEqual(agentTables(normalizeIds(legacy), () => null), agentTables(agent, () => null));
  });
});
