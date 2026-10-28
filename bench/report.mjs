// Render the result JSON files into the generated blocks of bench/RESULTS.md.
// Usage: node bench/report.mjs [--prefix r2] [--csv out.csv] <micro.json and/or agent.json, either order>
// Only the text between <!-- gen:NAME:begin --> and <!-- gen:NAME:end --> is replaced; prose is kept.
// --prefix P writes the agent tables into the gen:P-agent-* blocks instead (round 2 keeps round 1's tables).
// --csv writes one row per agent run (tool, task, rep, ok, wall s, cost USD, calls, result chars, timed_out, invalid).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { median } from './lib.mjs';

const BENCH = new URL('.', import.meta.url).pathname;
const ORDER = ['motorika', 'playwright', 'playwright-vision', 'devtools', 'agent-infra', 'puppeteer', 'browsermcp', 'claude-in-chrome'];
// Until the 2026-10-28 rename to Motorika our contender id was `x2-browser`. The committed result files keep
// that id; normalizeIds() reads it as `motorika`. No other id is renamed.
export const LEGACY_IDS = { 'x2-browser': 'motorika' };
const canon = (id) => LEGACY_IDS[id] ?? id;
const TASK_NAMES = { T1: 'T1 form', T2: 'T2 Wikipedia', T3: 'T3 three tabs', T4: 'T4 shop checkout', T5: 'T5 long thread' };

const ms = (v) => (v == null ? 'n/a' : v >= 100 ? `${Math.round(v)}` : v.toFixed(1));
const num = (v) => (v == null ? 'n/a' : Math.round(v).toLocaleString('en-US'));
const kb = (v) => (v == null ? 'n/a' : v === 0 ? '0' : `${(v / 1024).toFixed(0)} KB`);
const STEP_NAMES = {
  a: '(a) cold first call',
  b: '(b) navigate + snapshot, form page',
  c: '(c) complete snapshot, big-1000',
  d: '(d) click, no navigation',
  e: '(e) type into an input',
  f: '(f) fill 8 fields + submit',
  g: '(g) viewport screenshot',
};

function microSummary(micro) {
  const rows = ['| Step | Fastest p50 (all runs passed) | motorika p50 | Output: motorika, then each other tool with the motorika difference from it (text chars, median; image bytes for g) |', '|---|---|---|---|'];
  for (const k of Object.keys(STEP_NAMES)) {
    const entries = Object.entries(micro.contenders).filter(([, r]) => !r.skipped);
    const passing = entries.filter(([, r]) => r.summary[k].ok === r.summary[k].n);
    passing.sort((a, b) => a[1].summary[k].p50_ms - b[1].summary[k].p50_ms);
    const best = passing[0];
    const x2 = micro.contenders.motorika?.summary[k];
    const x2ok = x2 && x2.ok === x2.n;
    const field = k === 'g' ? 'imageBytes' : 'textChars';
    const cmp = entries
      .filter(([id]) => id !== 'motorika')
      .map(([id, r]) => {
        const s = r.summary[k];
        const other = s.ok ? s[field] : null;
        if (!x2ok || other == null) return `${id}: ${s.ok ? 'n/a' : `failed (${s.ok}/${s.n})`}`;
        const pct = Math.round((1 - x2[field] / other) * 100);
        const unit = k === 'g' ? kb(other) : `${num(other)} chars`;
        return `${id} ${unit} (motorika ${pct >= 0 ? `${pct}% less` : `${-pct}% more`})`;
      })
      .join('; ');
    const x2Out = x2ok ? (k === 'g' ? kb(x2.imageBytes) : `${num(x2.textChars)} chars`) : 'failed';
    rows.push(
      `| ${STEP_NAMES[k]} | ${best ? `${best[0]} ${ms(best[1].summary[k].p50_ms)} ms` : 'none passed every run'} | ${x2ok ? `${ms(x2.p50_ms)} ms` : `failed ${x2?.ok}/${x2?.n}`} | motorika ${x2Out}; ${cmp} |`,
    );
  }
  return rows.join('\n');
}

function microDetail(micro) {
  const out = [];
  for (const k of Object.keys(STEP_NAMES)) {
    out.push(`\n**${STEP_NAMES[k]}**, ${micro.steps[k]}\n`);
    out.push('| Tool | passed | p50 ms | p95 ms | calls | text chars | image bytes | note |');
    out.push('|---|---|---|---|---|---|---|---|');
    for (const id of ORDER) {
      const r = micro.contenders[id];
      if (!r) continue;
      if (r.skipped) {
        out.push(`| ${id} | skipped | | | | | | ${r.skipped} |`);
        continue;
      }
      const s = r.summary[k];
      const note = s.ok < s.n ? `FAILED: ${s.failures[0] ?? ''} (all-runs p50 ${ms(s.p50_all_ms)} ms, ${num(s.calls_all)} calls, ${num(s.textChars_all)} chars)` : '';
      out.push(`| ${id} | ${s.ok}/${s.n} | ${ms(s.p50_ms)} | ${ms(s.p95_ms)} | ${s.ok ? num(s.calls) : 'n/a'} | ${s.ok ? num(s.textChars) : 'n/a'} | ${s.ok ? num(s.imageBytes) : 'n/a'} | ${note.replace(/\|/g, '\\|')} |`);
    }
  }
  return out.join('\n');
}

function microEnv(micro) {
  const rows = ['| Tool | Version | Mode | Browser binary | Load before | Load after |', '|---|---|---|---|---|---|'];
  const load = (s) => /load averages?: ([\d. ,]+)/.exec(s?.uptime ?? '')?.[1]?.trim() ?? 'n/a';
  for (const id of ORDER) {
    const r = micro.contenders[id];
    if (!r) continue;
    rows.push(`| ${id} | ${r.version} | ${r.mode} | ${r.browser ?? 'not run'} | ${r.skipped ? '' : load(r.before)} | ${r.skipped ? '' : load(r.after)} |`);
  }
  return [
    `Run ${micro.date}, ${micro.runs} warm runs per step, ${micro.coldRuns} cold starts. ${micro.machine.cpu}, ${micro.machine.cores} cores, ${micro.machine.ramGB} GB RAM, Node ${micro.machine.node}.`,
    `Start: \`${micro.start.uptime}\`; swap \`${micro.start.swap}\`.`,
    `End: \`${micro.end.uptime}\`; swap \`${micro.end.swap}\`.`,
    '',
    ...rows,
  ].join('\n');
}

/**
 * A result file with every legacy contender id (LEGACY_IDS) read as the current one: micro `contenders` keys (order
 * kept), agent `runs[].contender`, `skipped[].contender` and the `plan` orders. Prose fields are left as recorded.
 */
export function normalizeIds(j) {
  const out = { ...j };
  if (j.contenders) out.contenders = Object.fromEntries(Object.entries(j.contenders).map(([id, r]) => [canon(id), r]));
  if (Array.isArray(j.runs)) out.runs = j.runs.map((r) => ({ ...r, contender: canon(r.contender) }));
  if (Array.isArray(j.skipped)) out.skipped = j.skipped.map((x) => ({ ...x, contender: canon(x.contender) }));
  if (j.plan) {
    const orders = (list) => list?.map((o) => ({ ...o, order: o.order.map(canon) }));
    out.plan = { ...j.plan, ...(j.plan.planned_orders ? { planned_orders: orders(j.plan.planned_orders) } : {}), ...(j.plan.orders ? { orders: orders(j.plan.orders) } : {}) };
  }
  return out;
}

/** Task ids in the file, T1..Tn order. */
const tasksOf = (runs) => [...new Set(runs.map((r) => r.task))].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
const toolsOf = (runs) => [...ORDER.filter((id) => runs.some((r) => r.contender === id)), ...[...new Set(runs.map((r) => r.contender))].filter((id) => !ORDER.includes(id))];
const mean = (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);
const secs = (v) => (v / 1000).toFixed(1);
const usd = (v) => v.toFixed(3);
const range = (v, f) => (v.length ? `${f(median(v))} [${f(Math.min(...v))}–${f(Math.max(...v))}]` : 'n/a');
const DAGGER = '†';
export const COST_NOTE = `${DAGGER} Some runs have no recorded cost: they were killed at the hard timeout before \`claude\` wrote its result line. A run's own cost then shows n/a. A median, mean or total marked ${DAGGER} covers only the runs with a cost, and states how many were left out. A timed-out run usually costs more than the others, so the marked figure understates.`;

/** The cost a run's saved stream reports in its result line, or null (killed before it, or no file). */
function streamCost(file) {
  if (!file) return null;
  let text;
  try {
    text = readFileSync(join(BENCH, file), 'utf8');
  } catch {
    return null;
  }
  let cost = null;
  for (const line of text.split('\n')) {
    if (!line.includes('"type":"result"')) continue;
    try {
      const m = JSON.parse(line);
      if (m.type === 'result' && typeof m.total_cost_usd === 'number') cost = m.total_cost_usd;
    } catch {
      /* a line cut off by the kill */
    }
  }
  return cost;
}

/**
 * One view of every run for all tables: `cost` is the recorded cost, else the one in the saved stream, else null
 * (never 0); `ok` is false for a timeout whatever the oracle said. Invalid and interrupted runs are not data.
 */
export function prepareRuns(agent, readCost = streamCost) {
  const all = agent.runs.map((r) => ({ ...r, cost: r.total_cost_usd ?? (r.invalid || r.interrupted ? null : readCost(r.file)), ok: Boolean(r.success) && !r.timedOut }));
  return { valid: all.filter((r) => !r.invalid && !r.interrupted), invalid: all.filter((r) => r.invalid), interrupted: all.filter((r) => r.interrupted) };
}

/** A cost aggregate over the runs that have one, marked with † (and the count left out) when any has none. */
function costCell(runs, agg) {
  const known = runs.map((r) => r.cost).filter((c) => c != null);
  const missing = runs.length - known.length;
  if (!known.length) return `n/a${DAGGER}`;
  return missing ? `${agg(known)}${DAGGER} (${missing} of ${runs.length} without cost)` : agg(known);
}

export function agentTables(agent, readCost) {
  const { valid, invalid, interrupted } = prepareRuns(agent, readCost);
  const byKey = new Map();
  for (const r of valid) {
    const key = `${r.task}|${r.contender}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(r);
  }
  const summary = ['| Task | Tool | success | median wall s | median cost USD | median tool calls | median tool-result chars |', '|---|---|---|---|---|---|---|'];
  const detail = ['| Task | Tool | rep | ok | wall s | duration_ms | turns | tool calls | result chars | images | cost USD | oracle |', '|---|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const task of tasksOf(valid)) {
    for (const id of toolsOf(valid)) {
      const runs = byKey.get(`${task}|${id}`);
      if (!runs) continue;
      const ok = runs.filter((r) => r.ok).length;
      summary.push(
        `| ${task} | ${id} | ${ok}/${runs.length} | ${(median(runs.map((r) => r.wall_ms)) / 1000).toFixed(1)} | ${costCell(runs, (v) => median(v).toFixed(3))} | ${median(runs.map((r) => r.tool_calls))} | ${num(median(runs.map((r) => r.tool_result_chars)))} |`,
      );
      for (const r of [...runs].sort((a, b) => a.rep - b.rep)) {
        detail.push(
          `| ${task} | ${id} | ${r.rep} | ${r.ok ? 'yes' : 'NO'} | ${(r.wall_ms / 1000).toFixed(1)} | ${r.duration_ms ?? 'n/a'} | ${r.num_turns ?? 'n/a'} | ${r.tool_calls} | ${num(r.tool_result_chars)} | ${r.tool_result_images} | ${r.cost == null ? `n/a${DAGGER}` : r.cost.toFixed(3)} | ${(r.timedOut ? 'TIMEOUT; ' : '') + r.detail.replace(/\|/g, '\\|')}${r.ok ? '' : `; answer_ok=${r.answer_ok} evidence_ok=${r.evidence_ok}`} |`,
        );
      }
    }
  }
  // The header total is the tables' total: every valid run's cost as the tables show it (recovered costs included),
  // computed here, so a file saved mid-run (no total_cost_usd yet) still prints a real number.
  const anyMissing = valid.some((r) => r.cost == null);
  const known = valid.map((r) => r.cost).filter((c) => c != null);
  const sum = known.reduce((a, b) => a + b, 0);
  const total = anyMissing ? `$${sum.toFixed(2)}${DAGGER} + n/a for ${valid.length - known.length} run(s) without cost` : `$${sum.toFixed(2)}`;
  const stopped = agent.skipped.filter((s) => /T1 failed twice/.test(s.reason)).map((s) => s.contender);
  const skipped = agent.skipped.map((s) => `- ${s.contender}: ${s.reason}`).join('\n') || '- none';
  const inv = invalid.map((r) => `- ${r.task} ${r.contender} rep${r.rep}: ${r.invalid_reason}`).join('\n') || '- none';
  const intr = interrupted.map((r) => `- ${r.task} ${r.contender} rep${r.rep}: ${r.detail}`).join('\n');
  return {
    summary: [summary.join('\n'), ...(anyMissing ? ['', COST_NOTE] : [])].join('\n'),
    cross: agentCross(valid, { timeoutMin: agent.timeout_min, stopped }),
    detail: [
      `Run ${agent.date}, model \`${agent.model}\`, ${valid.length} runs${invalid.length ? ` (+${invalid.length} invalid, not run)` : ''}, total cost ${total}, hard timeout ${agent.timeout_min} min per run.`,
      `Start: \`${agent.start.uptime}\`. End: \`${agent.end?.uptime ?? 'n/a'}\`.${agent.resumed_at?.length ? ` Resumed ${agent.resumed_at.length}x: ${agent.resumed_at.map((x) => x.at).join(', ')}.` : ''}`,
      '',
      detail.join('\n'),
      ...(anyMissing ? ['', COST_NOTE] : []),
      '',
      'Skipped or stopped:',
      skipped,
      // Round-2 files (they carry a plan) list invalid runs; older files render exactly as before.
      ...(agent.plan || invalid.length ? ['', 'Invalid (page changed or precheck failed; no agent started, not counted as failures):', inv] : []),
      ...(interrupted.length ? ['', 'Interrupted (Ctrl-C or SIGTERM; not data; --resume re-runs them):', intr] : []),
    ].join('\n'),
  };
}

/**
 * Cross-tool view: one row per task, one cell per tool with passed/runs, wall s and cost USD as median [min–max].
 * The headline row is like-for-like: per tool, the mean of its per-task means over exactly the tasks that every
 * tool still in the comparison has valid runs for, each task weighted equally. A tool stopped by the T1 rule is
 * excluded and named, so it cannot shrink everyone's task set to T1. A timeout counts at the timeout value (‡);
 * a tool with any unknown cost in that set shows "n/a (k runs unknown)" instead of a mean of the rest.
 */
export function agentCross(valid, { timeoutMin = null, stopped = [] } = {}) {
  const tools = toolsOf(valid);
  const tasks = tasksOf(valid);
  const runsOf = (task, id) => valid.filter((r) => r.task === task && r.contender === id);
  const head = `| Task | ${tools.join(' | ')} |`;
  const sep = `|---|${tools.map(() => '---').join('|')}|`;
  const rows = [];
  for (const task of tasks) {
    const cells = tools.map((id) => {
      const runs = runsOf(task, id);
      if (!runs.length) return 'not run';
      return `${runs.filter((r) => r.ok).length}/${runs.length}; ${range(runs.map((r) => r.wall_ms), secs)} s; $${costCell(runs, (v) => range(v, usd))}`;
    });
    rows.push(`| ${TASK_NAMES[task] ?? task} | ${cells.join(' | ')} |`);
  }
  const compared = tools.filter((id) => !stopped.includes(id));
  const common = tasks.filter((t) => compared.every((id) => runsOf(t, id).length));
  const left = tasks.filter((t) => !common.includes(t)).map((t) => `${t} (no valid runs: ${compared.filter((id) => !runsOf(t, id).length).join(', ')})`);
  const timeoutMs = timeoutMin == null ? null : timeoutMin * 60_000;
  const notes = [];
  let anyTimeout = false;
  if (common.length && compared.length) {
    const overall = tools.map((id) => {
      if (stopped.includes(id)) return 'excluded: stopped by the T1 rule';
      const per = common.map((t) => runsOf(t, id));
      const all = per.flat();
      const timeouts = all.filter((r) => r.timedOut).length;
      anyTimeout ||= timeouts > 0;
      const wallOf = (r) => (r.timedOut && timeoutMs != null ? timeoutMs : r.wall_ms);
      const w = mean(per.map((rs) => mean(rs.map(wallOf))));
      const unknown = all.filter((r) => r.cost == null).length;
      const c = unknown ? `n/a (${unknown} runs unknown)` : usd(mean(per.map((rs) => mean(rs.map((r) => r.cost)))));
      return `${all.filter((r) => r.ok).length}/${all.length}; mean ${secs(w)} s${timeouts ? `‡ (${timeouts} timeout${timeouts > 1 ? 's' : ''})` : ''}; mean $${c}`;
    });
    rows.push(`| **Like-for-like mean over ${common.join(', ')}** | ${overall.join(' | ')} |`);
  } else {
    notes.push('No task has valid runs for every compared tool, so there is no like-for-like overall row.');
  }
  if (stopped.length) notes.push(`Excluded from the like-for-like row: ${stopped.map((id) => `${id} (stopped by the T1 rule after failing T1 twice)`).join(', ')}.`);
  if (left.length) notes.push(`Left out of the like-for-like row: ${left.join('; ')}.`);
  if (anyTimeout) notes.push(`‡ Includes timed-out runs; each timeout is counted at the full ${timeoutMin} min.`);
  if (valid.some((r) => r.cost == null)) notes.push(COST_NOTE);
  return [
    'Each cell: runs passed / runs (a timeout is a failure); wall seconds, median [min–max]; cost USD, median [min–max]. A tool missing a task shows "not run".',
    `The last row compares like with like. For each tool it is the mean of that tool's per-task means, over exactly the tasks named in the row, which every compared tool ran. Each task weighs the same. A tool with any unknown cost there shows "n/a (k runs unknown)".${common.length ? '' : ' (none here)'}`,
    '',
    head,
    sep,
    ...rows,
    ...(notes.length ? ['', ...notes] : []),
  ].join('\n');
}

/** One CSV row per run, for charts. Invalid and interrupted runs are kept, flagged, with empty measures. */
export function agentCsv(agent, readCost) {
  const { valid } = prepareRuns(agent, readCost);
  const byRun = new Map(valid.map((r) => [`${r.task}|${r.contender}|${r.rep}`, r]));
  const cols = ['tool', 'task', 'rep', 'ok', 'wall_s', 'cost_usd', 'calls', 'result_chars', 'timed_out', 'invalid'];
  const q = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const lines = [cols.join(',')];
  for (const raw of agent.runs) {
    const r = byRun.get(`${raw.task}|${raw.contender}|${raw.rep}`);
    const row = !r || raw.invalid || raw.interrupted
      ? [raw.contender, raw.task, raw.rep, '', '', '', '', '', '', 1]
      : [r.contender, r.task, r.rep, r.ok ? 1 : 0, (r.wall_ms / 1000).toFixed(1), r.cost == null ? '' : r.cost.toFixed(4), r.tool_calls, r.tool_result_chars, r.timedOut ? 1 : 0, 0];
    lines.push(row.map(q).join(','));
  }
  return `${lines.join('\n')}\n`;
}

function main() {
  const { values: o, positionals } = parseArgs({ options: { prefix: { type: 'string' }, csv: { type: 'string' } }, allowPositionals: true });
  let micro = null;
  let agent = null;
  for (const f of positionals.filter(Boolean)) {
    const j = normalizeIds(JSON.parse(readFileSync(f, 'utf8')));
    if (j.kind === 'agent') agent = j;
    else micro = j;
  }
  const file = join(BENCH, 'RESULTS.md');
  let md = readFileSync(file, 'utf8');
  const put = (name, body) => {
    const re = new RegExp(`(<!-- gen:${name}:begin -->)[\\s\\S]*?(<!-- gen:${name}:end -->)`);
    if (!re.test(md)) throw new Error(`RESULTS.md has no gen:${name} block`);
    // A function, not a replacement string: a body with "$23.84" would otherwise expand "$2" as a group.
    md = md.replace(re, (_, begin, end) => `${begin}\n${body}\n${end}`);
  };
  if (micro) {
    put('micro-summary', microSummary(micro));
    put('micro-env', microEnv(micro));
    put('micro-detail', microDetail(micro));
  }
  if (agent) {
    const p = o.prefix ? `${o.prefix}-` : '';
    const t = agentTables(agent);
    put(`${p}agent-summary`, t.summary);
    // The cross-tool block is new in round 2; round 1's section has none, so it is written only where it exists.
    if (o.prefix || md.includes('<!-- gen:agent-cross:begin -->')) put(`${p}agent-cross`, t.cross);
    put(`${p}agent-detail`, t.detail);
    if (o.csv) {
      writeFileSync(o.csv, agentCsv(agent));
      process.stderr.write(`wrote ${o.csv}\n`);
    }
  }
  writeFileSync(file, md);
  process.stderr.write(`updated ${file}\n`);
}

if (process.argv[1] === new URL(import.meta.url).pathname) main();
