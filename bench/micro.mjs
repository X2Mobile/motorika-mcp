// B1 micro benchmark: every stdio contender over the MCP SDK client on local fixtures.
// Run: npm run bench [-- --runs 20 --cold 10 --only motorika,playwright --smoke --tag <name>]
// Writes bench/results/<date>-micro[-<tag>].json and refuses to overwrite an existing one (--smoke writes
// to bench/.tmp and may overwrite).
//
// One contender's browser at a time, in this one process. Timing is client-side wall time per step
// (sum of the step's calls). A run counts only when the page-state oracle confirms the step did its job;
// oracle calls (evaluate, the fixture server's submission log) are out of band and never measured.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { startFixtureServer } from '../test/support/fixture-server.ts';
import { ADAPTERS, FORM, expectedSubmission, need, parseMarked } from './adapters.mjs';
import { CONTENDERS } from './contenders.mjs';
import { descendants, imageSize, machineState, percentile, refuseOverwrite, resultName, startContender } from './lib.mjs';

const { values: opt } = parseArgs({
  options: {
    runs: { type: 'string', default: '20' },
    cold: { type: 'string', default: '10' },
    only: { type: 'string' },
    smoke: { type: 'boolean', default: false },
    tag: { type: 'string' },
  },
});
const RUNS = opt.smoke ? 1 : Number(opt.runs);
const COLD = opt.smoke ? 1 : Number(opt.cold);
const BENCH = new URL('.', import.meta.url).pathname;
const log = (s) => process.stderr.write(`${s}\n`);
// Fixed at start, so a run that crosses midnight still writes the file it checked.
const OUT_FILE = join(opt.smoke ? join(BENCH, '.tmp') : join(BENCH, 'results'), `${resultName(new Date().toISOString().slice(0, 10), 'micro', opt.tag)}.json`);
if (!opt.smoke) refuseOverwrite(OUT_FILE);

const STEPS = {
  a: 'cold first call: spawn + initialize + first navigate (incl. browser launch)',
  b: 'navigate + snapshot of the form page',
  c: 'complete snapshot of big-1000 (all 1000 items; continuation pages counted)',
  d: 'click, no navigation',
  e: 'type into an input',
  f: 'fill 8 fields + submit',
  g: 'viewport screenshot',
};

function sum(calls) {
  return {
    ms: calls.reduce((n, c) => n + c.ms, 0),
    calls: calls.length,
    textChars: calls.reduce((n, c) => n + c.textChars, 0),
    imageBytes: calls.reduce((n, c) => n + c.imageBytes, 0),
    toolErrors: calls.filter((c) => c.isError).length,
  };
}

function summarise(runs) {
  const ok = runs.filter((r) => r.ok);
  const ms = ok.map((r) => r.ms);
  const pick = (k) => (ok.length ? percentile(ok.map((r) => r[k]), 50) : null);
  return {
    n: runs.length,
    ok: ok.length,
    p50_ms: percentile(ms, 50),
    p95_ms: percentile(ms, 95),
    calls: pick('calls'),
    textChars: pick('textChars'),
    imageBytes: pick('imageBytes'),
    // Over every run, failed ones included, so a contender that never passes still shows what it cost.
    p50_all_ms: percentile(runs.map((r) => r.ms), 50),
    calls_all: percentile(runs.map((r) => r.calls), 50),
    textChars_all: percentile(runs.map((r) => r.textChars), 50),
    failures: [...new Set(runs.filter((r) => !r.ok).map((r) => r.why))].slice(0, 5),
  };
}

async function oracle(ad, h, expr) {
  const r = await ad.evaluate(h, expr);
  return parseMarked(r.text);
}

async function guard(fn) {
  try {
    return await fn();
  } catch (err) {
    return { ok: false, why: `harness: ${err?.message ?? err}`, ms: 0, calls: 0, textChars: 0, imageBytes: 0 };
  }
}

async function coldRuns(c, ad, srv) {
  const out = [];
  for (let i = 0; i < COLD; i += 1) {
    out.push(
      await guard(async () => {
        const url = srv.url('forms.html');
        const t0 = performance.now();
        const h = await startContender(c);
        try {
          const nav = await ad.nav(h, url);
          const ms = performance.now() - t0;
          const s = sum(nav);
          const title = await oracle(ad, h, 'document.title');
          const ok = s.toolErrors === 0 && title.value === 'Full form';
          return { ...s, ms, ok, why: ok ? null : `title=${JSON.stringify(title.value)} errors=${s.toolErrors} ${nav[0]?.text.slice(0, 160)}` };
        } finally {
          await h.close();
        }
      }),
    );
    log(`  a#${i + 1} ${Math.round(out[i].ms)}ms ok=${out[i].ok}${out[i].ok ? '' : ` ${out[i].why}`}`);
  }
  return out;
}

/** The browser executable in the contender's process tree, to prove everyone ran the same Chrome. */
function browserOf(h) {
  const pids = descendants(h.pid);
  if (!pids.length) return 'unknown';
  let out = '';
  try {
    out = execFileSync('ps', ['-o', 'command=', '-p', pids.join(',')], { encoding: 'utf8' });
  } catch {
    return 'unknown';
  }
  const line = out.split('\n').find((l) => /--user-data-dir|--remote-debugging/.test(l) && !/--type=/.test(l));
  return line ? line.split(' --')[0].trim() : 'unknown';
}

async function warmRuns(c, ad, srv) {
  const res = { b: [], c: [], d: [], e: [], f: [], g: [] };
  const h = await startContender(c);
  const say = (k, i, r) => log(`  ${k}#${i + 1} ${Math.round(r.ms)}ms calls=${r.calls} chars=${r.textChars} img=${r.imageBytes} ok=${r.ok}${r.ok ? '' : ` ${r.why}`}`);
  try {
    await ad.nav(h, srv.url('index.html')); // warm-up, not measured
    res.browser = browserOf(h);

    for (let i = 0; i < RUNS; i += 1) {
      const r = await guard(async () => {
        const calls = await ad.navSnap(h, srv.url('forms.html'));
        const s = sum(calls);
        const text = calls.map((x) => x.text).join('\n');
        const title = await oracle(ad, h, 'document.title');
        const content = ['Full name', 'Email', 'Country', 'Send form'].every((t) => text.includes(t));
        const ok = s.toolErrors === 0 && content && title.value === 'Full form';
        return { ...s, ok, why: ok ? null : `content=${content} title=${JSON.stringify(title.value)}` };
      });
      res.b.push(r);
      say('b', i, r);
    }

    await ad.nav(h, srv.url('big-1000.html'));
    for (let i = 0; i < RUNS; i += 1) {
      const r = await guard(async () => {
        const calls = await ad.snapAll(h);
        const s = sum(calls);
        const text = calls.map((x) => x.text).join('\n');
        const missing = [];
        for (let n = 1; n <= 1000; n += 1) if (!new RegExp(`Item ${n}\\b`).test(text)) missing.push(n);
        const ok = s.toolErrors === 0 && missing.length === 0;
        return { ...s, ok, why: ok ? null : `missing ${missing.length} items (first ${missing[0]})` };
      });
      res.c.push(r);
      say('c', i, r);
    }

    await ad.nav(h, srv.url('click.html'));
    const clickSnap = await ad.snapshot(h);
    const plainRef = ad.ref(clickSnap.text, { role: 'button', name: 'Plain', id: 'plain' });
    for (let i = 0; i < RUNS; i += 1) {
      if (!plainRef) { res.d.push({ ok: false, why: 'prep: no ref for "Plain" in snapshot', ms: 0, calls: 0, textChars: 0, imageBytes: 0 }); continue; }
      const r = await guard(async () => {
        const before = await oracle(ad, h, 'window.__counts.plain || 0');
        const calls = await ad.click(h, plainRef);
        const s = sum(calls);
        const after = await oracle(ad, h, 'window.__counts.plain || 0');
        const ok = s.toolErrors === 0 && after.value === before.value + 1;
        return { ...s, ok, why: ok ? null : `count ${before.value} -> ${after.value}; ${calls[0]?.text.slice(0, 160)}` };
      });
      res.d.push(r);
      say('d', i, r);
    }

    await ad.nav(h, srv.url('type.html'));
    const typeSnap = await ad.snapshot(h);
    const replaceRef = ad.ref(typeSnap.text, { role: 'textbox', name: 'Replace me', id: 'replace' });
    for (let i = 0; i < RUNS; i += 1) {
      if (!replaceRef) { res.e.push({ ok: false, why: 'prep: no ref for "Replace me" in snapshot', ms: 0, calls: 0, textChars: 0, imageBytes: 0 }); continue; }
      const r = await guard(async () => {
        const text = `typed value ${i}`;
        const calls = await ad.type(h, replaceRef, text);
        const s = sum(calls);
        const v = await oracle(ad, h, "document.getElementById('replace').value");
        const ok = s.toolErrors === 0 && v.value === text;
        return { ...s, ok, why: ok ? null : `value=${JSON.stringify(v.value)}; ${calls[0]?.text.slice(0, 160)}` };
      });
      res.e.push(r);
      say('e', i, r);
    }

    for (let i = 0; i < RUNS; i += 1) {
      const r = await guard(async () => {
        // Same untimed preparation for every contender: open the form fresh, take one snapshot for refs.
        await ad.nav(h, srv.url('forms.html'));
        const snap = await ad.snapshot(h);
        const refs = {};
        for (const [k, el] of Object.entries(FORM)) refs[k] = need(ad.ref(snap.text, el), k);
        srv.reset();
        const calls = await ad.fill(h, refs, i);
        const s = sum(calls);
        // The submit lands asynchronously; wait (untimed) up to 3 s for the record.
        const until = Date.now() + 3000;
        while (Date.now() < until && srv.submissions('full').length === 0) await new Promise((x) => setTimeout(x, 25));
        const subs = srv.submissions('full');
        const want = expectedSubmission(i);
        const got = subs.length === 1 ? Object.fromEntries(subs[0].fields) : null;
        const diff = got ? Object.keys(want).filter((k) => got[k] !== want[k]) : ['<no single submission>'];
        const ok = s.toolErrors === 0 && diff.length === 0;
        return {
          ...s,
          ok,
          why: ok ? null : `submissions=${subs.length} wrong=${diff.map((k) => `${k}:${JSON.stringify(got?.[k])}`).join(',')} errs=${calls.filter((x) => x.isError).map((x) => x.text.slice(0, 120)).join(' | ')}`,
        };
      });
      res.f.push(r);
      say('f', i, r);
    }

    await ad.nav(h, srv.url('forms.html'));
    for (let i = 0; i < RUNS; i += 1) {
      const r = await guard(async () => {
        const calls = await ad.shot(h);
        const s = sum(calls);
        const imgs = calls.flatMap((x) => x.imgs);
        const dims = imgs.map((x) => imageSize(x.bytes));
        const okImg = dims.length >= 1 && dims[0] && (dims[0].width === null || (dims[0].width > 0 && dims[0].height > 0));
        const ok = s.toolErrors === 0 && Boolean(okImg);
        return { ...s, ok, format: dims[0]?.format, width: dims[0]?.width, height: dims[0]?.height, why: ok ? null : `no decodable inline image (${imgs.length} images)` };
      });
      res.g.push(r);
      say('g', i, r);
    }
  } finally {
    const k = await h.close();
    if (k.killed) log(`  reaped ${k.killed} leftover process(es) of ${c.id}`);
  }
  return res;
}

const startState = machineState();
const srv = await startFixtureServer();
const results = {
  kind: 'micro',
  date: new Date().toISOString(),
  runs: RUNS,
  coldRuns: COLD,
  steps: STEPS,
  machine: { cpu: cpus()[0]?.model, cores: cpus().length, ramGB: Math.round(totalmem() / 2 ** 30), node: process.version },
  start: startState,
  contenders: {},
};
try {
  const only = opt.only ? new Set(opt.only.split(',')) : null;
  for (const c of CONTENDERS) {
    if (only && !only.has(c.id)) continue;
    const skip = c.skip ?? c.microSkip;
    if (skip) {
      results.contenders[c.id] = { version: c.version, mode: c.mode, skipped: skip };
      log(`${c.id}: SKIPPED (${skip})`);
      continue;
    }
    const ad = ADAPTERS[c.id];
    log(`${c.id}: ${c.version}`);
    const before = machineState();
    const cold = await coldRuns(c, ad, srv);
    const warm = await warmRuns(c, ad, srv);
    const { browser, ...warmSteps } = warm;
    const raw = { a: cold, ...warmSteps };
    const summary = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, summarise(v)]));
    results.contenders[c.id] = { version: c.version, mode: c.mode, args: c.args, browser, before, after: machineState(), summary, raw };
  }
} finally {
  await srv.close();
}
results.end = machineState();

mkdirSync(dirname(OUT_FILE), { recursive: true });
if (!opt.smoke) refuseOverwrite(OUT_FILE);
const file = OUT_FILE;
// Raw image bytes are not serialised; sizes and dimensions are.
writeFileSync(file, JSON.stringify(results, (k, v) => (k === 'imgs' || k === 'raw_result' ? undefined : v), 2));
log(`wrote ${file}`);
for (const [id, r] of Object.entries(results.contenders)) {
  if (r.skipped) continue;
  for (const [k, s] of Object.entries(r.summary)) {
    log(`${id.padEnd(12)} ${k} ok=${s.ok}/${s.n} p50=${s.p50_ms?.toFixed(1)} p95=${s.p95_ms?.toFixed(1)} calls=${s.calls} chars=${s.textChars} img=${s.imageBytes}${s.failures.length ? ` FAIL: ${s.failures[0]}` : ''}`);
  }
}
