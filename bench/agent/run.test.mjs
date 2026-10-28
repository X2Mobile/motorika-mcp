// Tests for the B2 round-2 harness: run with `cd bench && npm test` (node --test, no network, no real claude).
// Expectations come from the sites and the brief, not from the oracle code: T5 facts from the live thread captured
// on 2026-10-26 (fixture). T4 (local shop, server-log oracle) is tested in shop.test.mjs.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { TASKS, blockOrders, invalidKind, isRetryable, runKey, schedule } from './run.mjs';

const HERE = new URL('.', import.meta.url).pathname;
const BENCH = join(HERE, '..');
const HN = gunzipSync(readFileSync(join(HERE, 'fixtures', 'hn-1626305-2026-10-26.html.gz'))).toString('utf8');
const ev = (resultText, extra = {}) => ({ resultText, urls: [], tabOpens: 0, images: 0, ...extra });

describe('T5 long thread oracle and precheck', () => {
  const right = { blog_post: { user: 'Qerub', title: 'The Treacherous Optimization' }, podcast: { user: 'frou_dh', name: 'Security Now' }, plan9: { user: 'konad', reply_by: 'kragen' } };
  const seen = 'Qerub ... "The Treacherous Optimization" ... frou_dh The Security Now podcast ... konad Plan9 grep ... kragen';

  it('the fixture is the live page as verified: three facts, one page, deep', () => {
    assert.match(HN, /<title>Why GNU grep is Fast \| Hacker News/);
    assert.ok(HN.includes('115&nbsp;comments'));
    for (const s of ['Treacherous Optimization', 'Security Now', 'Plan9 grep']) assert.ok(HN.indexOf(s) > HN.length * 0.9, s);
  });
  it('passes the right answers seen through the tools', () => {
    const r = TASKS.T5.check(right, ev(seen));
    assert.equal(r.answerOk && r.evidenceOk, true, r.detail);
  });
  it('tolerates an @ before a username and the podcast title without its article', () => {
    assert.equal(TASKS.T5.check({ ...right, podcast: { user: '@frou_dh', name: 'Security Now!' } }, ev(seen)).answerOk, true);
  });
  it('fails a wrong reply author or a wrong commenter', () => {
    assert.equal(TASKS.T5.check({ ...right, plan9: { user: 'konad', reply_by: 'vidarh' } }, ev(seen)).answerOk, false);
    assert.equal(TASKS.T5.check({ ...right, blog_post: { user: 'kragen', title: 'The Treacherous Optimization' } }, ev(seen)).answerOk, false);
  });
  it('fails when only the top of the thread came back through the tools', () => {
    const top = HN.slice(0, Math.floor(HN.length / 2)).replace(/<[^>]+>/g, ' ');
    assert.equal(TASKS.T5.check(right, ev(top)).evidenceOk, false);
  });
  it('the questions do not carry the answers', () => {
    for (const s of ['Qerub', 'Treacherous', 'frou_dh', 'Security Now', 'konad', 'kragen']) assert.ok(!TASKS.T5.prompt.includes(s), s);
  });

  const withFetch = async (body, fn, status = 200) => {
    const real = globalThis.fetch;
    globalThis.fetch = async () => new Response(body, { status });
    try {
      return await fn();
    } finally {
      globalThis.fetch = real;
    }
  };
  it('precheck passes on the page as captured', async () => {
    assert.equal(await withFetch(HN, () => TASKS.T5.precheck()), null);
  });
  it('precheck flags a changed comment count', async () => {
    assert.match(await withFetch(HN.replace('115&nbsp;comments', '114&nbsp;comments'), () => TASKS.T5.precheck()), /115 comments/);
  });
  it('precheck flags a removed comment', async () => {
    assert.match(await withFetch(HN.replaceAll('Security Now', 'a podcast'), () => TASKS.T5.precheck()), /Security Now/);
  });
  it('precheck flags facts that are no longer deep in the page', async () => {
    const i = HN.indexOf('<tr class="athing comtr"');
    const moved = HN.slice(0, i) + '<p>Plan9 grep Security Now Treacherous Optimization</p>' + HN.slice(i);
    assert.match(await withFetch(moved, () => TASKS.T5.precheck()), /no longer deep/);
  });
  it('precheck flags an HTTP error', async () => {
    assert.match(await withFetch('busy', () => TASKS.T5.precheck({ retryMs: 0 }), 503), /unavailable: HTTP 503/);
  });
});

describe('T1-T3 unchanged (comparable with 2026-10-23)', () => {
  it('prompts and oracles are byte-identical to the ones at abea518 (the 2026-10-23 code)', () => {
    // The abea518 blocks are frozen in fixtures/frozen-T<n>-abea518.txt (block text plus one newline), so the
    // guard needs no git history: the published repo is a single commit.
    const frozen = (t) => {
      const s = readFileSync(join(HERE, 'fixtures', `frozen-${t}-abea518.txt`), 'utf8');
      assert.ok(s.endsWith('\n'), `frozen ${t} fixture lost its trailing newline`);
      return s.slice(0, -1);
    };
    const now = readFileSync(join(HERE, 'run.mjs'), 'utf8');
    const block = (s, t) => {
      const at = s.indexOf(`  ${t}: {`);
      assert.ok(at >= 0, `${t} not found`);
      return s.slice(at, s.indexOf('\n  },\n', at));
    };
    // 2026-10-28: the T1 test persona (customer name and telephone) was replaced for publication. Only those
    // four slots are masked (the frozen T1 holds them already masked); everything else in T1, and all of T2
    // and T3, stays byte-identical.
    const PERSONA_SLOTS = [/(Customer name ")[^"]*(")/, /(Telephone ")[^"]*(")/, /(f\.custname === ')[^']*(')/, /(f\.custtel === ')[^']*(')/];
    const mask = (s) => PERSONA_SLOTS.reduce((x, re) => x.replace(re, '$1<PERSONA>$2'), s);
    const t1 = block(now, 'T1');
    for (const want of ['Customer name "Ann H1"', 'Telephone "+1 555 0100"', "f.custname === 'Ann H1'", "f.custtel === '+1 555 0100'"]) {
      assert.ok(t1.includes(want), `T1 persona slot missing: ${want}`);
    }
    assert.equal(mask(t1), frozen('T1'), 'T1 changed');
    for (const t of ['T2', 'T3']) assert.equal(block(now, t), frozen(t), `${t} changed`);
  });
});

describe('fair ordering (--balanced, seeded Williams design)', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const tasks = ['T1', 'T2', 'T3', 'T4', 'T5'];
  const blocks = (s) => blockOrders(s).map((x) => x.order);
  const tally = (bs) => {
    const pos = new Map();
    const pairs = new Map();
    for (const b of bs) {
      b.forEach((id, i) => pos.set(`${id}@${i}`, (pos.get(`${id}@${i}`) ?? 0) + 1));
      for (let i = 1; i < b.length; i += 1) pairs.set(`${b[i - 1]}>${b[i]}`, (pairs.get(`${b[i - 1]}>${b[i]}`) ?? 0) + 1);
    }
    return { pos, pairs };
  };
  it('every (rep, task) block runs each tool exactly once, seeded or not', () => {
    for (const seed of [null, 7]) {
      const s = schedule(5, tasks, ids, seed);
      assert.equal(s.length, 5 * 5 * 8);
      for (const b of blocks(s)) assert.deepEqual([...b].sort(), ids);
      assert.equal(new Set(s.map(runKey)).size, s.length);
    }
  });
  it('without a seed the order is the round-1 order', () => {
    for (const b of blocks(schedule(2, tasks, ids, null))) assert.deepEqual(b, ids);
  });
  it('8 tools: every 8 consecutive blocks put each tool in each position once and each ordered neighbour pair once', () => {
    const bs = blocks(schedule(5, tasks, ids, 12345)).slice(0, 8);
    const { pos, pairs } = tally(bs);
    assert.equal(pos.size, 64);
    assert.ok([...pos.values()].every((v) => v === 1));
    assert.equal(pairs.size, 8 * 7, 'all 56 ordered pairs occur');
    assert.ok([...pairs.values()].every((v) => v === 1));
  });
  it('odd tool count (7): every 14 blocks balance positions and ordered pairs twice each', () => {
    const seven = ids.slice(0, 7);
    const bs = blocks(schedule(14, ['T1'], seven, 99));
    const { pos, pairs } = tally(bs);
    assert.ok([...pos.values()].every((v) => v === 2) && pos.size === 49);
    assert.ok([...pairs.values()].every((v) => v === 2) && pairs.size === 42);
  });
  it('neighbours change: no tool has the same successor in two consecutive blocks within the first 8', () => {
    const bs = blocks(schedule(5, tasks, ids, 4242)).slice(0, 8);
    for (let i = 1; i < bs.length; i += 1) {
      const next = (b) => new Map(b.slice(0, -1).map((id, k) => [id, b[k + 1]]));
      const [p, q] = [next(bs[i - 1]), next(bs[i])];
      for (const [id, succ] of p) assert.notEqual(q.get(id), succ, `block ${i}: ${id} keeps neighbour ${succ}`);
    }
  });
  it('the same seed reproduces the order; another seed gives another', () => {
    assert.deepEqual(schedule(5, tasks, ids, 1), schedule(5, tasks, ids, 1));
    assert.notDeepEqual(schedule(5, tasks, ids, 1), schedule(5, tasks, ids, 2));
  });
});

describe('resume (end to end with a fake claude)', () => {
  // A fake `claude` first on PATH: logs each invocation and prints a minimal stream with no answer.
  const dir = mkdtempSync(join(tmpdir(), 'motorika-bench-resume-'));
  const calls = join(dir, 'calls.log');
  writeFileSync(join(dir, 'claude'), `#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(calls)}, 'run\\n');\nconsole.log(JSON.stringify({type:'result',result:'no answer',total_cost_usd:0.001,duration_ms:1,num_turns:1}));\n`);
  chmodSync(join(dir, 'claude'), 0o755);
  const tag = `selftest-resume-${process.pid}`;
  const date = new Date().toISOString().slice(0, 10);
  const resultFile = join(BENCH, 'results', `${date}-agent-${tag}.json`);
  const logs = join(BENCH, 'results', 'agent', `${date}-${tag}`);
  const run = (args) => spawnSync(process.execPath, [join(HERE, 'run.mjs'), ...args], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf8', timeout: 120_000 });
  const count = () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').length : 0);
  after(() => {
    rmSync(resultFile, { force: true });
    rmSync(logs, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it('a fresh run records its plan; a resume skips recorded runs; a plain rerun is still refused', () => {
    const base = ['--tag', tag, '--reps', '2', '--tasks', 'T3', '--only', 'motorika,playwright', '--balanced', '--seed', '11', '--warmup'];
    const first = run(base);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(count(), 6, '2 warm-ups + 4 runs');
    const full = JSON.parse(readFileSync(resultFile, 'utf8'));
    assert.deepEqual(full.plan.tasks, ['T3']);
    assert.equal(full.plan.balanced, true);
    assert.equal(full.plan.seed, 11);
    assert.equal(full.plan.orders.length, 2, 'one recorded order per (rep, task) block');
    // Simulate a run killed after its first two runs.
    const cut = { ...full, runs: full.runs.slice(0, 2) };
    delete cut.end;
    writeFileSync(resultFile, JSON.stringify(cut));
    const refused = run(base);
    assert.equal(refused.status, 1, 'a plain rerun on the same tag must still be refused');
    assert.match(refused.stderr, /refusing to overwrite/);
    assert.equal(count(), 6, 'a refused run starts no agent');
    const resumed = run(['--resume', resultFile, '--reps', '9']); // the recorded plan wins over the flag
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(count(), 10, 'warm-ups again (cache expired), then only the two missing runs');
    const done = JSON.parse(readFileSync(resultFile, 'utf8'));
    assert.deepEqual(done.runs.map(runKey).sort(), full.runs.map(runKey).sort());
    assert.equal(done.resumed_at.length, 1);
    const again = run(['--resume', resultFile]);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(count(), 10, 'resuming a complete file runs nothing, not even warm-ups');
    assert.equal(JSON.parse(readFileSync(resultFile, 'utf8')).warmups.length, 4);
  });
});

describe('review nit on the T5 oracle (item 4)', () => {
  it('T5 usernames match case-insensitively, in the answer and in the evidence', () => {
    const ans = { blog_post: { user: 'qerub', title: 'The Treacherous Optimization' }, podcast: { user: 'FROU_DH', name: 'Security Now' }, plan9: { user: 'Konad', reply_by: 'Kragen' } };
    const r = TASKS.T5.check(ans, ev('QERUB frou_dh KONAD'));
    assert.equal(r.answerOk && r.evidenceOk, true, r.detail);
  });
});

describe('review items 2, 6, 7c: retryable voids, interruption, resume path', () => {
  // Fake claude: logs each call; with FAKE_HANG=1 it starts a child "browser" (sleep), records both pids, and hangs.
  const dir = mkdtempSync(join(tmpdir(), 'motorika-bench-sig-'));
  const calls = join(dir, 'calls.log');
  const pids = join(dir, 'pids.log');
  writeFileSync(
    join(dir, 'claude'),
    `#!/usr/bin/env node
const fs = require('fs');
fs.appendFileSync(${JSON.stringify(calls)}, 'run\\n');
if (process.env.FAKE_HANG === '1') {
  const b = require('child_process').spawn('sleep', ['300'], { stdio: 'ignore' });
  fs.writeFileSync(${JSON.stringify(pids)}, process.pid + ' ' + b.pid);
  setInterval(() => {}, 1000);
} else {
  console.log(JSON.stringify({ type: 'result', result: 'no answer', total_cost_usd: 0.001, duration_ms: 1, num_turns: 1 }));
}
`,
  );
  chmodSync(join(dir, 'claude'), 0o755);
  const date = new Date().toISOString().slice(0, 10);
  const tags = [];
  const files = (tag) => ({ json: join(BENCH, 'results', `${date}-agent-${tag}.json`), logs: join(BENCH, 'results', 'agent', `${date}-${tag}`) });
  const env = (extra = {}) => ({ ...process.env, PATH: `${dir}:${process.env.PATH}`, ...extra });
  const runSync = (args, extra) => spawnSync(process.execPath, [join(HERE, 'run.mjs'), ...args], { env: env(extra), encoding: 'utf8', timeout: 120_000 });
  const count = () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).length : 0);
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  after(() => {
    for (const t of tags) {
      rmSync(files(t).json, { force: true });
      rmSync(files(t).logs, { recursive: true, force: true });
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('classifies voids: page changed is permanent, network and HTTP errors are retryable', () => {
    assert.equal(invalidKind('page changed: Security Now'), 'page-changed');
    assert.equal(invalidKind('precheck unavailable: HTTP 419'), 'unavailable');
    assert.equal(invalidKind('precheck error: fetch failed'), 'unavailable');
    assert.equal(isRetryable({ invalid: true, invalid_reason: 'HTTP 419' }), true, 'records written before invalid_kind existed');
    assert.equal(isRetryable({ invalid: true, invalid_kind: 'page-changed', invalid_reason: 'page changed: x' }), false);
    assert.equal(isRetryable({ interrupted: true }), true);
    assert.equal(isRetryable({ success: false, timedOut: true }), false, 'a timeout is a result, not retried');
  });

  it('resume re-runs network voids, keeps page-changed voids, and writes to the --resume path it was given', () => {
    const tag = `selftest-void-${process.pid}`;
    tags.push(tag);
    const first = runSync(['--tag', tag, '--reps', '2', '--tasks', 'T3', '--only', 'motorika']);
    assert.equal(first.status, 0, first.stderr);
    const n0 = count();
    const j = JSON.parse(readFileSync(files(tag).json, 'utf8'));
    j.runs[0] = { ...j.runs[0], invalid: true, invalid_kind: 'unavailable', invalid_reason: 'precheck unavailable: HTTP 419', file: null };
    j.runs[1] = { ...j.runs[1], invalid: true, invalid_kind: 'page-changed', invalid_reason: 'page changed: Security Now', file: null };
    // The file was moved: resume must write to the moved copy, not recreate the dated name.
    const moved = join(dir, 'moved.json');
    writeFileSync(moved, JSON.stringify(j));
    rmSync(files(tag).json);
    const res = runSync(['--resume', moved]);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(count(), n0 + 1, 'exactly the network void is re-run');
    assert.equal(existsSync(files(tag).json), false, 'nothing written to the dated path');
    const after1 = JSON.parse(readFileSync(moved, 'utf8'));
    assert.equal(after1.runs.length, 2);
    assert.equal(after1.runs.filter((r) => r.invalid_kind === 'page-changed').length, 1, 'page-changed void kept');
    assert.equal(after1.runs.filter((r) => r.invalid_kind === 'unavailable').length, 0);
    assert.equal(after1.retried.length, 1);
    copyFileSync(moved, files(tag).json); // so after() can clean the logs dir by tag
  });

  it('SIGTERM kills the running claude and its browser, records the run as interrupted, and resume re-runs it', async () => {
    const tag = `selftest-sig-${process.pid}`;
    tags.push(tag);
    const n0 = count();
    rmSync(pids, { force: true });
    const child = spawn(process.execPath, [join(HERE, 'run.mjs'), '--tag', tag, '--reps', '1', '--tasks', 'T3', '--only', 'motorika,playwright'], { env: env({ FAKE_HANG: '1' }), stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    for (let i = 0; i < 100 && !existsSync(pids); i += 1) await new Promise((r) => setTimeout(r, 100));
    assert.ok(existsSync(pids), 'the fake claude started');
    const [claudePid, browserPid] = readFileSync(pids, 'utf8').split(' ').map(Number);
    await new Promise((r) => setTimeout(r, 2500)); // let the harness see the browser in its tree poll
    child.kill('SIGTERM');
    const code = await new Promise((r) => child.on('close', (c) => r(c)));
    assert.equal(code, 143, stderr);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(alive(claudePid), false, 'claude killed');
    assert.equal(alive(browserPid), false, 'its browser killed');
    const j = JSON.parse(readFileSync(files(tag).json, 'utf8'));
    assert.equal(j.runs.length, 1);
    assert.equal(j.runs[0].interrupted, true);
    assert.equal(j.runs[0].success, false);
    assert.equal(count(), n0 + 1);
    const res = runSync(['--resume', files(tag).json]);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(count(), n0 + 3, 'the interrupted run and the never-started one');
    const done = JSON.parse(readFileSync(files(tag).json, 'utf8'));
    assert.equal(done.runs.length, 2);
    assert.equal(done.runs.some((r) => r.interrupted), false);
    assert.equal(done.retried.length, 1);
  });
});

// Re-check item 5: plan.orders is what happened, not only what was planned.
describe('recorded order is the executed order', () => {
  const dir = mkdtempSync(join(tmpdir(), 'motorika-bench-order-'));
  writeFileSync(join(dir, 'claude'), `#!/usr/bin/env node\nconsole.log(JSON.stringify({type:'result',result:'no answer',total_cost_usd:0.001,duration_ms:1,num_turns:1}));\n`);
  chmodSync(join(dir, 'claude'), 0o755);
  const tag = `selftest-order-${process.pid}`;
  const date = new Date().toISOString().slice(0, 10);
  const json = join(BENCH, 'results', `${date}-agent-${tag}.json`);
  const logs = join(BENCH, 'results', 'agent', `${date}-${tag}`);
  const run = (args) => spawnSync(process.execPath, [join(HERE, 'run.mjs'), ...args], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf8', timeout: 120_000 });
  after(() => {
    rmSync(json, { force: true });
    rmSync(logs, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });
  it('a run re-done on resume appears where it actually ran; the plan is kept apart', () => {
    const first = run(['--tag', tag, '--reps', '1', '--tasks', 'T3', '--only', 'motorika,playwright']);
    assert.equal(first.status, 0, first.stderr);
    const j = JSON.parse(readFileSync(json, 'utf8'));
    assert.deepEqual(j.runs.map((r) => r.contender), ['motorika', 'playwright']);
    // motorika's run was interrupted: resume re-runs it after playwright's.
    j.runs[0] = { ...j.runs[0], interrupted: true, file: null };
    writeFileSync(json, JSON.stringify(j));
    const res = run(['--resume', json]);
    assert.equal(res.status, 0, res.stderr);
    const done = JSON.parse(readFileSync(json, 'utf8'));
    assert.deepEqual(done.plan.planned_orders, [{ block: '1|T3', order: ['motorika', 'playwright'] }]);
    assert.deepEqual(done.plan.orders, [{ block: '1|T3', order: ['playwright', 'motorika'] }]);
  });
});
