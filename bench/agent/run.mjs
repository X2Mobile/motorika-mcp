// B2 agent-level benchmark: a real `claude -p` drives one contender per run on live-web tasks (T1-T5).
// Run: node bench/agent/run.mjs [--reps 2] [--only motorika,playwright] [--tasks T1,T2] [--probe-chrome] [--warmup]
//      [--probe <id>] [--tag <name>] [--balanced [--seed N]] [--resume <result.json>] [--budget-usd 3]
// Writes bench/results/<date>-agent[-<tag>].json and its logs dir; refuses to run when either already exists
// (the logs dir when non-empty), so old logs that a result's `file` fields point at are never overwritten.
// --resume <file> is the one exception: it continues that file and its logs dir, skipping every run it already
// records (task|contender|rep), and keeps the file's own model, tasks, reps, order and contender list.
// --rescore <file> rewrites the file it is given. Probes write to bench/.tmp/probes/, never the logs dir.
//
// Contenders are interleaved (rep 1: T1 for all, T2 for all, T3 for all; then rep 2), one run at a time.
// --balanced orders each (rep, task) block by a seeded Williams Latin square: every tool takes every position and
// follows every other tool equally often over each square (25 blocks of 8 tools: 3-4 times each). The seed, the
// planned order (plan.planned_orders) and the order the runs actually ran in (plan.orders) are recorded.
// Every run's full stream-json is kept in bench/results/agent/<date>[-<tag>]/; the table derives from those files.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { CONTENDERS } from '../contenders.mjs';
import { startShop } from './shop-server.mjs';
import { TMP_ROOT, descendants, machineState, refuseOverwrite, resultName } from '../lib.mjs';

const { values: opt } = parseArgs({
  options: {
    reps: { type: 'string', default: '2' },
    only: { type: 'string' },
    tasks: { type: 'string', default: 'T1,T2,T3' },
    model: { type: 'string', default: 'claude-opus-5-5' },
    'probe-chrome': { type: 'boolean', default: false },
    probe: { type: 'string' },
    'timeout-min': { type: 'string', default: '6' },
    warmup: { type: 'boolean', default: false },
    rescore: { type: 'string' },
    tag: { type: 'string' },
    balanced: { type: 'boolean', default: false },
    seed: { type: 'string' },
    resume: { type: 'string' },
    'budget-usd': { type: 'string', default: '3' },
    // Fixed, so a one-time Claude in Chrome site permission for http://127.0.0.1:47823 holds; 0 = any free port.
    'shop-port': { type: 'string', default: '47823' },
  },
});
const BENCH = new URL('..', import.meta.url).pathname;
// A resumed run keeps the file it continues, whatever today's date is.
const RESUME = opt.resume ? JSON.parse(readFileSync(opt.resume, 'utf8')) : null;
if (RESUME && !RESUME.plan) {
  process.stderr.write(`--resume: ${opt.resume} has no "plan" (written before resume support); cannot replay its schedule\n`);
  process.exit(2);
}
const DATE = RESUME ? RESUME.plan.date : new Date().toISOString().slice(0, 10);
if (RESUME) {
  // The recorded plan wins over the command line, so the replayed schedule is the original one.
  const p = RESUME.plan;
  Object.assign(opt, { tag: p.tag ?? undefined, model: p.model, reps: String(p.reps), tasks: p.tasks.join(','), only: p.only ?? undefined, balanced: p.balanced, seed: p.seed == null ? undefined : String(p.seed), warmup: p.warmup, 'timeout-min': String(p.timeout_min), 'budget-usd': String(p.budget_usd) });
  process.stderr.write(`resuming ${opt.resume} with its recorded plan: ${JSON.stringify(p)}\n`);
}
resultName(DATE, 'agent', opt.tag); // validates --tag before it names a directory
const OUT_DIR = join(BENCH, 'results', 'agent', opt.tag === undefined ? DATE : `${DATE}-${opt.tag}`);
const TIMEOUT_MS = Number(opt['timeout-min']) * 60_000;
const PROBE_DIR = join(BENCH, '.tmp', 'probes');
const log = (s) => process.stderr.write(`${s}\n`);
// OUT_DIR is created only after the overwrite checks in main(), so a refused run leaves nothing behind.

const JSON_TAIL = 'End your reply with the answer as one fenced ```json block and nothing after it.';

export const TASKS = {
  T1: {
    prompt:
      'Use only the browser tools. Open https://httpbin.org/forms/post and fill in the form: Customer name "Ann H1", ' +
      'Telephone "+1 555 0100", E-mail "h1@example.com", Pizza Size Medium, Pizza Toppings Bacon and Onion, ' +
      'Preferred delivery time 19:30, Delivery instructions "x2-browser H1 check". Submit the order, then report the ' +
      `"form" object that httpbin echoes back on the response page, exactly as shown. ${JSON_TAIL} Shape: {"form": {...}}`,
    check(answer, evidence) {
      const f = answer?.form ?? {};
      const top = [].concat(f.topping ?? []);
      const want = {
        custname: f.custname === 'Ann H1',
        custtel: f.custtel === '+1 555 0100',
        custemail: f.custemail === 'h1@example.com',
        size: f.size === 'medium',
        topping: top.includes('bacon') && top.includes('onion') && top.length === 2,
        delivery: f.delivery === '19:30',
        comments: f.comments === 'x2-browser H1 check',
      };
      const wrong = Object.keys(want).filter((k) => !want[k]);
      // Evidence: a browser tool result actually carried the echoed JSON (not recalled or invented).
      const seen = evidence.resultText.includes('custemail') && evidence.resultText.includes('h1@example.com');
      return { answerOk: wrong.length === 0, evidenceOk: seen, detail: wrong.length ? `wrong: ${wrong.join(',')}` : 'all 7 fields echoed' };
    },
  },
  T2: {
    prompt:
      'Use only the browser tools. Open https://en.wikipedia.org, use the site search to search for "Model Context Protocol", ' +
      `open the article, and report who introduced it and in which year, as stated in the article. ${JSON_TAIL} ` +
      'Shape: {"introduced_by": "...", "year": 0}',
    check(answer, evidence) {
      const by = String(answer?.introduced_by ?? '');
      const year = String(answer?.year ?? '');
      const answerOk = /anthropic/i.test(by) && year.includes('2024');
      // The article was reached, and the fact came back through the browser: as text, or (for tools that
      // read pixels) as an image taken there, which this oracle cannot read and labels as such.
      const reached = /model[_ ]context[_ ]protocol/i.test(evidence.urls.join(' ') + evidence.resultText);
      const inText = /anthropic/i.test(evidence.resultText);
      const seen = reached && (inText || evidence.images > 0);
      const how = !reached ? 'article not reached' : inText ? 'fact seen in tool text' : evidence.images ? 'fact only in a screenshot (not text-verifiable)' : 'fact not in any tool result';
      return { answerOk, evidenceOk: seen, detail: `introduced_by=${JSON.stringify(by)} year=${JSON.stringify(year)}; ${how}` };
    },
  },
  T3: {
    prompt:
      'Use only the browser tools. Open these three pages in three separate browser tabs (one page per tab, all three ' +
      'tabs open at the same time): https://example.com , https://httpbin.org/html and ' +
      'https://en.wikipedia.org/wiki/Main_Page . Then report the document title of each tab. ' +
      `${JSON_TAIL} Shape: {"tabs": [{"url": "...", "title": "..."}, ...]}`,
    check(answer, evidence) {
      const tabs = Array.isArray(answer?.tabs) ? answer.tabs : [];
      const by = (re) => tabs.find((t) => re.test(String(t?.url ?? '')));
      const ex = by(/example\.com/);
      const hb = by(/httpbin\.org\/html/);
      const wp = by(/wikipedia\.org/);
      // httpbin.org/html has no <title>: its document.title is "". Accept "", a "no title" wording or the URL.
      const hbTitle = String(hb?.title ?? 'MISSING');
      const hbOk = hb && (hbTitle.trim() === '' || /no title|untitled|empty|none|httpbin\.org\/html/i.test(hbTitle));
      const ok = {
        example: ex?.title === 'Example Domain',
        httpbin: Boolean(hbOk),
        wikipedia: wp?.title === 'Wikipedia, the free encyclopedia',
      };
      const wrong = Object.keys(ok).filter((k) => !ok[k]);
      // Evidence of real multi-tab use: at least two tab-opening calls (the first page may reuse the start tab).
      const seen = evidence.tabOpens >= 2;
      return {
        answerOk: wrong.length === 0,
        evidenceOk: seen,
        detail: `${wrong.length ? `wrong: ${wrong.join(',')}` : 'three titles right'}; tab-opening calls=${evidence.tabOpens}; httpbin title=${JSON.stringify(hbTitle)}`,
      };
    },
  },
  // A local shop (bench/agent/shop-server.mjs) that mirrors a demo-store checkout. Each run gets its own shop under a
  // random run path; Finish records the order with an unguessable 8-character id. The oracle reads only that run's
  // order log, never the tool output: the answer must carry the id of the run's one order, and that order must hold
  // exactly the expected item, name, postcode and total ($49.99 + 8% tax $4.00 = $53.99).
  T4: {
    shop: true,
    prompt: (url) =>
      `Use only the browser tools. Open the shop at ${url} and log in with the demo credentials printed on the login ` +
      'page. Add the "Canvas Field Jacket" to the cart; the cart must hold only that one item when you check out. Check ' +
      'out with first name "Ann", last name "Bench" and postal code "10115", look over the order overview, then ' +
      `finish the order and report the order number shown on the confirmation page. ${JSON_TAIL} ` +
      'Shape: {"order_id": "...", "total": "$0.00"}',
    expected: { items: ['Canvas Field Jacket'], first_name: 'Ann', last_name: 'Bench', postcode: '10115', total: 53.99 },
    check(answer, evidence) {
      const e = TASKS.T4.expected;
      const orders = evidence.shopOrders ?? [];
      const id = String(answer?.order_id ?? '').trim().toUpperCase();
      if (!orders.length) return { answerOk: false, evidenceOk: false, detail: `no order recorded by the shop (answer order_id=${JSON.stringify(id)})` };
      if (orders.length > 1) return { answerOk: false, evidenceOk: false, detail: `multiple orders (${orders.length}): ${orders.map((o) => o.order_id).join(',')}` };
      const o = orders[0];
      const ok = {
        items: JSON.stringify(o.items) === JSON.stringify(e.items),
        first_name: o.first_name === e.first_name,
        last_name: o.last_name === e.last_name,
        postcode: o.postcode === e.postcode,
        total: o.total === e.total,
      };
      const wrong = Object.keys(ok).filter((k) => !ok[k]);
      const idOk = id === o.order_id;
      const detail = `${idOk ? 'order id matches the shop log' : `order id ${JSON.stringify(id)} is not the logged ${o.order_id}`}; ${wrong.length ? `order wrong: ${wrong.join(',')} (${JSON.stringify(o)})` : 'logged order right'}`;
      return { answerOk: idOk, evidenceOk: wrong.length === 0, detail };
    },
  },
  // A long, archived Hacker News thread (2010, 115 comments, locked): "Why GNU grep is Fast". All three facts sit in
  // the last ~7% of the page HTML, in top-level comments near the bottom and one reply. Verified on the live page
  // 2026-10-26. The questions name neither the answer strings nor the commenters, so memory cannot supply them.
  T5: {
    url: 'https://news.ycombinator.com/item?id=1626305',
    prompt:
      'Use only the browser tools. Open the Hacker News thread https://news.ycombinator.com/item?id=1626305 and answer ' +
      'these three questions from the thread page itself (read the comments; do not use any other site or search): ' +
      '(1) A top-level comment says everybody should read a certain blog post about grep. What is the commenter\'s ' +
      'username, and what is the post\'s title as quoted in that comment? (2) A top-level comment mentions a podcast ' +
      'that did an episode on the Boyer-Moore algorithm. What is the commenter\'s username, and what is the podcast ' +
      'called? (3) A top-level comment says Plan 9\'s grep is competitive with GNU grep in the commenter\'s simple test. ' +
      `Who wrote it, and who wrote the direct reply to it? ${JSON_TAIL} ` +
      'Shape: {"blog_post": {"user": "...", "title": "..."}, "podcast": {"user": "...", "name": "..."}, "plan9": {"user": "...", "reply_by": "..."}}',
    expected: { blogUser: 'Qerub', blogTitle: /treacherous optimization/i, podUser: 'frou_dh', podName: /security now/i, planUser: 'konad', planReply: 'kragen' },
    // Cheap start-of-run check that the live page still holds these facts, deep in the page. A mismatch marks the
    // run invalid (not failed) and no agent is started.
    // HN answers 419 "Sorry" to a made-up "Mozilla/5.0 (...)" user agent (seen 2026-10-26); an honest one gets 200.
    // One retry, so a single transient error does not void a run.
    async precheck({ retryMs = 5000 } = {}) {
      let res;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          res = await fetch(TASKS.T5.url, { headers: { 'user-agent': 'x2-browser-bench/1.0 (precheck)' }, signal: AbortSignal.timeout(20_000) });
          if (res.ok) break;
        } catch (e) {
          if (attempt === 2) return `precheck unavailable: ${e?.message ?? e}`;
        }
        if (attempt === 1) await new Promise((r) => setTimeout(r, retryMs));
      }
      if (!res.ok) return `precheck unavailable: HTTP ${res.status}`;
      const html = await res.text();
      const miss = [];
      if (!html.includes('<title>Why GNU grep is Fast | Hacker News')) miss.push('title');
      if (!html.includes('115&nbsp;comments')) miss.push('115 comments header');
      for (const s of ['Qerub', 'frou_dh', 'konad', 'kragen', 'id="1629048"']) if (!html.includes(s)) miss.push(s);
      for (const s of ['Treacherous Optimization', 'Security Now', 'Plan9 grep']) {
        const at = html.indexOf(s);
        if (at < 0) miss.push(s);
        else if (at < html.length * 0.6) miss.push(`${s} no longer deep (at ${Math.round((100 * at) / html.length)}%)`);
      }
      return miss.length ? `page changed: ${miss.join(', ')}` : null;
    },
    check(answer, evidence) {
      const e = TASKS.T5.expected;
      // Usernames compare case-insensitively: no two usernames on the page differ only by case (checked 2026-10-26).
      const s = (v) => String(v ?? '').trim().replace(/^@/, '');
      const u = (v) => s(v).toLowerCase();
      const ok = {
        blog_user: u(answer?.blog_post?.user) === e.blogUser.toLowerCase(),
        blog_title: e.blogTitle.test(s(answer?.blog_post?.title)),
        podcast_user: u(answer?.podcast?.user) === e.podUser.toLowerCase(),
        podcast_name: e.podName.test(s(answer?.podcast?.name)),
        plan9_user: u(answer?.plan9?.user) === e.planUser.toLowerCase(),
        plan9_reply: u(answer?.plan9?.reply_by) === e.planReply.toLowerCase(),
      };
      const wrong = Object.keys(ok).filter((k) => !ok[k]);
      // The three deep commenters came back through a tool (they are not guessable), or, for pixel-only tools,
      // the thread was opened and images were taken.
      const lowText = evidence.resultText.toLowerCase();
      const users = [e.blogUser, e.podUser, e.planUser].filter((name) => lowText.includes(name.toLowerCase()));
      const reached = /1626305/.test(evidence.urls.join(' ') + evidence.resultText);
      const inText = users.length === 3;
      const seen = inText || (reached && evidence.images > 0);
      const how = inText ? 'all three commenters seen in tool text' : reached && evidence.images ? `thread reached, ${users.length}/3 commenters in text, rest only in screenshots (not text-verifiable)` : `thread ${reached ? 'reached' : 'not reached'}, ${users.length}/3 commenters in tool text`;
      return { answerOk: wrong.length === 0, evidenceOk: seen, detail: `${wrong.length ? `wrong: ${wrong.join(',')}` : 'three answers right'}; ${how}` };
    },
  },
};

/** How each contender opens a new tab, for the T3 evidence count. Batch tools are looked into. */
function tabOpens(name, input) {
  const n = name.replace(/^mcp__[^_]+(?:-[^_]+)*__/, '');
  if (n === 'tabs' || n === 'browser_tabs') return input?.action === 'new' ? 1 : 0;
  if (n === 'new_page' || n === 'browser_new_tab') return 1;
  if (/tabs_create|new_tab|create_tab/.test(n)) return 1;
  // x2 `batch` {steps: [{tool, args}]}; Claude in Chrome `browser_batch` {actions: [{name, input}]}.
  if (n === 'batch' && Array.isArray(input?.steps)) return input.steps.reduce((k, st) => k + tabOpens(String(st?.tool ?? ''), st?.args), 0);
  if (n === 'browser_batch' && Array.isArray(input?.actions)) return input.actions.reduce((k, a) => k + tabOpens(String(a?.name ?? ''), a?.input), 0);
  return 0;
}

function agentContenders() {
  const list = CONTENDERS.map((c) => ({ ...c, name: c.id }));
  list.push({
    id: 'claude-in-chrome',
    name: 'claude-in-chrome',
    version: 'Claude in Chrome (claude --chrome), extension version unknown',
    mode: "HEADED: the user's real Chrome via the Claude extension",
    chrome: true,
  });
  return list;
}

function mcpConfigFor(c, runDir) {
  const args = [...c.args];
  if (c.outputDirFlag) args.push(c.outputDirFlag, join(runDir, 'out'));
  if (c.freshProfileFlag) args.push(c.freshProfileFlag, join(runDir, 'profile'));
  const file = join(runDir, 'mcp.json');
  const server = { type: 'stdio', command: c.command, args, ...(c.env && { env: c.env }) };
  writeFileSync(file, JSON.stringify({ mcpServers: { [c.name]: server } }, null, 2));
  return file;
}

export function parseStream(text) {
  const calls = new Map();
  const order = [];
  let result = null;
  let init = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.type === 'system' && m.subtype === 'init') init = m;
    if (m.type === 'assistant') {
      for (const c of m.message?.content ?? []) {
        if (c.type === 'tool_use') {
          calls.set(c.id, { name: c.name, input: c.input, chars: 0, images: 0, isError: false, text: '' });
          order.push(c.id);
        }
      }
    } else if (m.type === 'user') {
      for (const c of m.message?.content ?? []) {
        if (c.type === 'tool_result' && calls.has(c.tool_use_id)) {
          const rec = calls.get(c.tool_use_id);
          const parts = Array.isArray(c.content) ? c.content : [{ type: 'text', text: String(c.content ?? '') }];
          rec.text = parts.filter((p) => p.type === 'text').map((p) => p.text ?? '').join('\n');
          rec.chars = rec.text.length;
          rec.images = parts.filter((p) => p.type === 'image').length;
          rec.isError = Boolean(c.is_error);
        }
      }
    } else if (m.type === 'result') {
      result = m;
    }
  }
  const list = order.map((id) => calls.get(id));
  return { init, result, calls: list };
}

function extractAnswer(final) {
  if (!final) return null;
  const blocks = [...final.matchAll(/```json\s*([\s\S]*?)```/g)];
  const last = blocks.at(-1)?.[1];
  if (!last) return null;
  try {
    return JSON.parse(last);
  } catch {
    return null;
  }
}

/** The T4 shop, started on first use and closed at the end of main(). */
let SHOP = null;
async function shopServer() {
  SHOP ??= await startShop({ port: Number(opt['shop-port']) });
  return SHOP;
}

/** The claude process running now (one at a time), so SIGINT/SIGTERM can kill it and its browser. */
let LIVE = null;

/** Kills a run's detached process group and every descendant seen while it ran (its MCP server and browser). */
function killRun(live) {
  if (!live) return;
  for (const p of descendants(live.child.pid)) live.tree.add(p);
  try {
    process.kill(-live.child.pid, 'SIGKILL');
  } catch {
    /* gone */
  }
  for (const p of live.tree) {
    try {
      process.kill(p, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
}

function runClaude(args, cwd) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const child = spawn('claude', args, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const tree = new Set();
    LIVE = { child, tree };
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const watch = setInterval(() => {
      for (const p of descendants(child.pid)) tree.add(p);
    }, 2000);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }, TIMEOUT_MS);
    child.on('close', async (code, signal) => {
      clearTimeout(timer);
      clearInterval(watch);
      const wall = performance.now() - t0;
      // Reap only what this run started: its own process tree, remembered while it was alive.
      await new Promise((r) => setTimeout(r, 3000));
      let reaped = 0;
      for (const p of tree) {
        try {
          process.kill(p, 0);
          process.kill(p, 'SIGKILL');
          reaped += 1;
        } catch {
          /* already gone */
        }
      }
      LIVE = null;
      resolve({ out, err, code, signal, wall, timedOut, reaped });
    });
  });
}

/** The claude -p arguments of one run: the same for a B2 task run and for a --probe of that contender. */
function claudeArgs(c, prompt, runDir, budgetUsd) {
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--model', opt.model];
  args.push('--settings', JSON.stringify({ disableAllHooks: true }));
  // Per-contender forbidden tools (playwright-vision: its snapshot tools), as full MCP tool names.
  const deny = ['WebFetch', 'WebSearch', 'Bash', ...(c.disallowedTools ?? []).map((t) => `mcp__${c.name}__${t}`)];
  args.push('--strict-mcp-config', '--tools', '', '--disallowedTools', deny.join(','));
  args.push('--max-budget-usd', String(budgetUsd));
  if (c.chrome) {
    args.push('--chrome', '--allowedTools', 'mcp__claude-in-chrome');
  } else {
    args.push('--mcp-config', mcpConfigFor(c, runDir), '--allowedTools', `mcp__${c.name}`);
  }
  return args;
}

async function runOne(c, taskId, rep) {
  const task = TASKS[taskId];
  const tag = `${taskId}-${c.id}-rep${rep}`;
  if (task.precheck) {
    // A task on a page that must not have changed: check it first; a changed page makes the run invalid, not failed.
    let why;
    try {
      why = await task.precheck();
    } catch (e) {
      why = `precheck error: ${e?.message ?? e}`;
    }
    // "page changed" is permanent; "unavailable" (network, HTTP error) is retried by --resume.
    if (why) return { contender: c.id, task: taskId, rep, invalid: true, invalid_kind: invalidKind(why), invalid_reason: why, success: false, total_cost_usd: 0, tool_calls: 0, tool_result_chars: 0, wall_ms: 0, detail: `INVALID: ${why}`, file: null };
  }
  // A shop task gets a fresh shop run (its own path, sessions and order log) and a prompt with its URL.
  const shopRun = task.shop ? (await shopServer()).newRun() : null;
  const prompt = typeof task.prompt === 'function' ? task.prompt(shopRun.url) : task.prompt;
  const runDir = join(TMP_ROOT, `agent-${tag}-${process.pid}`);
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const args = claudeArgs(c, prompt, runDir, Number(opt['budget-usd']));
  if (c.realChrome || c.chrome) log(`>>> ${tag}: about to use the user's REAL Chrome (visible browser, real profile)`);
  const r = await runClaude(args, runDir);
  const file = join(OUT_DIR, `${tag}.jsonl`);
  writeFileSync(file, r.out);
  if (r.err.trim()) writeFileSync(join(OUT_DIR, `${tag}.stderr.txt`), r.err);
  rmSync(runDir, { recursive: true, force: true });
  const shopOrders = shopRun ? SHOP.orders(shopRun.runId) : undefined;
  const sum = summariseRun(c.id, taskId, rep, r.out, { shopOrders });
  if (r.timedOut) sum.success = false; // killed at the hard timeout: a failure in every table
  return { ...sum, ...(shopRun && { shop_run_id: shopRun.runId, shop_orders: shopOrders }), wall_ms: Math.round(r.wall), exit: r.code, signal: r.signal, timedOut: r.timedOut, reaped: r.reaped, file: file.slice(BENCH.length) };
}

export function summariseRun(contender, taskId, rep, streamText, ctx = {}) {
  const s = parseStream(streamText);
  const final = s.result?.result ?? null;
  const answer = extractAnswer(final);
  const urls = s.calls.map((c) => JSON.stringify(c.input ?? {}));
  const evidence = {
    resultText: s.calls.map((c) => c.text).join('\n'),
    urls,
    tabOpens: s.calls.reduce((k, c) => k + tabOpens(c.name, c.input), 0),
    images: s.calls.reduce((k, c) => k + c.images, 0),
    // T4: the run's order log from the shop server (not tool output).
    shopOrders: ctx.shopOrders ?? [],
  };
  const check = answer ? TASKS[taskId].check(answer, evidence) : { answerOk: false, evidenceOk: false, detail: 'no parseable ```json answer' };
  return {
    contender,
    task: taskId,
    rep,
    model: s.init?.model ?? null,
    mcp_servers: s.init?.mcp_servers ?? null,
    browser_tools_available: (s.init?.tools ?? []).filter((t) => t.startsWith('mcp__')).length,
    duration_ms: s.result?.duration_ms ?? null,
    num_turns: s.result?.num_turns ?? null,
    tool_calls: s.calls.length,
    tool_errors: s.calls.filter((c) => c.isError).length,
    tool_result_chars: s.calls.reduce((n, c) => n + c.chars, 0),
    tool_result_images: s.calls.reduce((n, c) => n + c.images, 0),
    total_cost_usd: s.result?.total_cost_usd ?? null,
    is_error: s.result?.is_error ?? null,
    success: check.answerOk && check.evidenceOk,
    answer_ok: check.answerOk,
    evidence_ok: check.evidenceOk,
    detail: check.detail,
    tools_used: [...new Set(s.calls.map((c) => c.name))],
  };
}

async function main() {
  const only = opt.only ? new Set(opt.only.split(',')) : null;
  const tasks = opt.tasks.split(',');
  const unknownTasks = tasks.filter((t) => !TASKS[t]);
  if (unknownTasks.length) throw new Error(`--tasks: unknown ${unknownTasks.join(',')}; known ${Object.keys(TASKS).join(',')}`);
  // An opt-in contender (BrowserMCP) runs only when named in --only: it drives the real Chrome and stops
  // whatever BrowserMCP server already listens on its port.
  const contenders = agentContenders().filter((c) => (only ? only.has(c.id) : !c.optIn));
  if (only) {
    const unknown = [...only].filter((id) => !contenders.some((c) => c.id === id));
    if (unknown.length) throw new Error(`--only: unknown contender ${unknown.join(',')}`);
  }
  // The plan is everything a --resume needs to replay the same schedule.
  const plan = { date: DATE, tag: opt.tag ?? null, model: opt.model, tasks, reps: Number(opt.reps), only: opt.only ?? null, balanced: opt.balanced, seed: opt.balanced ? Number(opt.seed ?? Math.floor(Math.random() * 2 ** 31)) : null, warmup: opt.warmup, timeout_min: Number(opt['timeout-min']), budget_usd: Number(opt['budget-usd']) };
  const results = RESUME ?? { kind: 'agent', date: new Date().toISOString(), model: opt.model, timeout_min: Number(opt['timeout-min']), plan, start: machineState(), skipped: [], runs: [] };
  // A resume writes back to exactly the file it was given, wherever it lives.
  const resultFile = RESUME ? opt.resume : join(BENCH, 'results', `${resultName(DATE, 'agent', opt.tag)}.json`);
  // plan.orders is what actually happened: results.runs is in execution order (a resume moves retried records
  // out and appends the re-runs), so it is re-derived from the recorded runs at every save.
  const save = () => {
    if (results.plan) results.plan.orders = blockOrders(results.runs);
    writeFileSync(resultFile, JSON.stringify(results, null, 2));
  };

  if (opt.rescore) {
    // Re-derive every run from its saved stream (oracle fixes only; nothing is re-run). Invalid runs have no stream.
    const prev = JSON.parse(readFileSync(opt.rescore, 'utf8'));
    for (const [i, r] of prev.runs.entries()) {
      if (r.invalid || !r.file) continue;
      const fresh = summariseRun(r.contender, r.task, r.rep, readFileSync(join(BENCH, r.file), 'utf8'), { shopOrders: r.shop_orders });
      const keep = { wall_ms: r.wall_ms, exit: r.exit, signal: r.signal, timedOut: r.timedOut, reaped: r.reaped, file: r.file, ...(r.shop_run_id && { shop_run_id: r.shop_run_id, shop_orders: r.shop_orders }) };
      const before = r.first_verdict ?? { success: r.success, detail: r.detail };
      prev.runs[i] = { ...fresh, ...keep, first_verdict: before };
      if (before.success !== fresh.success) log(`rescored ${r.task} ${r.contender} rep${r.rep}: ${before.success} -> ${fresh.success} (${fresh.detail})`);
    }
    prev.rescored_at = new Date().toISOString();
    writeFileSync(opt.rescore, JSON.stringify(prev, null, 2));
    return;
  }

  if (opt['probe-chrome']) {
    const c = agentContenders().find((x) => x.chrome);
    log(">>> probe: about to start claude --chrome, which uses the user's REAL Chrome");
    mkdirSync(TMP_ROOT, { recursive: true, mode: 0o700 });
    const r = await runClaude(['-p', 'Reply with the single word ok.', '--output-format', 'stream-json', '--verbose', '--model', opt.model, '--settings', JSON.stringify({ disableAllHooks: true }), '--strict-mcp-config', '--tools', '', '--chrome'], TMP_ROOT);
    mkdirSync(PROBE_DIR, { recursive: true });
    writeFileSync(join(PROBE_DIR, 'probe-claude-in-chrome.jsonl'), r.out);
    const s = parseStream(r.out);
    log(`probe: mcp_servers=${JSON.stringify(s.init?.mcp_servers)} tools=${JSON.stringify((s.init?.tools ?? []).filter((t) => t.startsWith('mcp__')))} cost=${s.result?.total_cost_usd} c=${c.id}`);
    return;
  }

  if (opt.probe) {
    // Wiring check: one cheap prompt with the exact MCP config and tool rules a B2 run of that contender uses.
    const c = agentContenders().find((x) => x.id === opt.probe && !x.chrome);
    if (!c) throw new Error(`--probe: unknown stdio contender ${opt.probe}`);
    const runDir = join(TMP_ROOT, `agent-probe-${c.id}-${process.pid}`);
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const r = await runClaude(claudeArgs(c, 'Reply with the single word ok.', runDir, 0.1), runDir);
    rmSync(runDir, { recursive: true, force: true });
    mkdirSync(PROBE_DIR, { recursive: true });
    writeFileSync(join(PROBE_DIR, `probe-${c.id}.jsonl`), r.out);
    const s = parseStream(r.out);
    log(`probe ${c.id}: mcp_servers=${JSON.stringify(s.init?.mcp_servers)} tools=${JSON.stringify((s.init?.tools ?? []).filter((t) => t.startsWith('mcp__')))} reply=${JSON.stringify(s.result?.result)} cost=${s.result?.total_cost_usd} reaped=${r.reaped}`);
    return;
  }

  // Checked before any run, so a refused run costs nothing (the --rescore and probe paths above are exempt).
  // The logs dir too: re-running after moving the old JSON away must not overwrite the logs it points at.
  // --resume is the one deliberate exception: it continues exactly that file and its logs dir. A stale .jsonl for a
  // run the JSON does not record (killed mid-run) is overwritten when that run is redone; the JSON is the truth.
  if (!RESUME) {
    refuseOverwrite(resultFile);
    if (existsSync(OUT_DIR) && readdirSync(OUT_DIR).length > 0) {
      log(`refusing to run: ${OUT_DIR} already holds agent logs. Pass --tag <name> for a new run, or move the old logs.`);
      process.exit(1);
    }
  } else {
    results.resumed_at = [...(results.resumed_at ?? []), { at: new Date().toISOString(), recorded_runs: results.runs.length, machine: machineState() }];
  }
  mkdirSync(OUT_DIR, { recursive: true });
  for (const c of contenders) {
    if (c.skip && !results.skipped.some((s) => s.contender === c.id && s.reason === c.skip)) {
      results.skipped.push({ contender: c.id, reason: c.skip });
      log(`${c.id}: SKIPPED (${c.skip})`);
    }
  }
  const active = contenders.filter((c) => !c.skip);
  if (RESUME) {
    // Retryable records leave runs (kept in results.retried for the audit trail) and are run again: a precheck
    // that could not reach the page, and a run cut short by SIGINT/SIGTERM. A "page changed" void stays.
    const retry = results.runs.filter(isRetryable);
    if (retry.length) {
      results.retried = [...(results.retried ?? []), ...retry.map((r) => ({ ...r, retried_at: new Date().toISOString() }))];
      results.runs = results.runs.filter((r) => !isRetryable(r));
      log(`retrying ${retry.length} run(s): ${retry.map(runKey).join(', ')}`);
    }
  }
  const done = new Set(results.runs.map(runKey));
  const t1Fails = new Map();
  const stopped = new Map();
  // Rebuilt from the recorded runs, so a resumed run applies the T1 budget rule exactly as an unbroken one would.
  for (const r of results.runs) if (r.task === 'T1' && !r.success && !r.invalid) t1Fails.set(r.contender, (t1Fails.get(r.contender) ?? 0) + 1);
  for (const [id, n] of t1Fails) if (n >= 2) stopped.set(id, T1_STOP);
  const order = schedule(Number(opt.reps), tasks, active.map((c) => c.id), results.plan.balanced ? results.plan.seed : null);
  // The planned order of every (rep, task) block, kept apart from plan.orders (what actually ran).
  results.plan.planned_orders ??= blockOrders(order);
  const todo = order.filter((s) => !done.has(runKey(s)));
  log(`${todo.length} runs to do${RESUME ? `, ${done.size} already recorded` : ''}`);
  // SIGINT/SIGTERM: kill the running claude, its MCP server and browser; record the run as interrupted (a resume
  // re-runs it); save and exit. Installed for the warm-ups too (no run record then).
  let current = null;
  const onSignal = (sig) => {
    killRun(LIVE);
    if (current) {
      results.runs.push({ ...current, interrupted: true, success: false, total_cost_usd: null, tool_calls: 0, tool_result_chars: 0, wall_ms: 0, detail: `INTERRUPTED by ${sig}`, file: null });
    }
    results.end = machineState();
    save();
    log(`${sig}: killed the running agent and its browser${current ? `; ${runKey(current)} recorded as interrupted (--resume re-runs it)` : ''}`);
    process.exit(sig === 'SIGINT' ? 130 : 143);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  if (opt.warmup && todo.length) {
    // A contender's first run writes its own prompt prefix to the cache and pays for it (RESULTS.md, re-run notes).
    // One untimed run per contender, with its exact args, so no measured run starts cold. Not counted in runs.
    // A resumed run warms up again: the cache has likely expired during the break.
    results.warmups = results.warmups ?? [];
    for (const c of active) {
      if (stopped.has(c.id) || !todo.some((s) => s.contender === c.id)) continue;
      const runDir = join(TMP_ROOT, `agent-warmup-${c.id}-${process.pid}`);
      mkdirSync(runDir, { recursive: true, mode: 0o700 });
      const r = await runClaude(claudeArgs(c, 'Reply with the single word ok.', runDir, 0.5), runDir);
      rmSync(runDir, { recursive: true, force: true });
      const s = parseStream(r.out);
      const u = s.result?.usage ?? {};
      results.warmups.push({ contender: c.id, cost_usd: s.result?.total_cost_usd, cache_write: u.cache_creation_input_tokens, cache_read: u.cache_read_input_tokens, ...(RESUME && { resumed: true }) });
      log(`warmup ${c.id}: cost=${s.result?.total_cost_usd} cache_write=${u.cache_creation_input_tokens} cache_read=${u.cache_read_input_tokens}`);
    }
    save();
  }
  const byId = new Map(active.map((c) => [c.id, c]));
  for (const { rep, task: taskId, contender } of todo) {
    const c = byId.get(contender);
    if (stopped.has(c.id)) continue;
    log(`run ${taskId} ${c.id} rep${rep} ...`);
    current = { contender: c.id, task: taskId, rep };
    const r = await runOne(c, taskId, rep);
    current = null;
    results.runs.push(r);
    save();
    if (r.invalid) {
      log(`  INVALID (not a failure, no agent started): ${r.invalid_reason}`);
      continue;
    }
    log(`  ${r.success ? 'PASS' : 'FAIL'} wall=${r.wall_ms}ms turns=${r.num_turns} calls=${r.tool_calls} chars=${r.tool_result_chars} cost=${r.total_cost_usd} ${r.timedOut ? 'TIMEOUT ' : ''}${r.detail}`);
    if (taskId === 'T1' && !r.success) {
      t1Fails.set(c.id, (t1Fails.get(c.id) ?? 0) + 1);
      if (t1Fails.get(c.id) >= 2) {
        stopped.set(c.id, T1_STOP);
        results.skipped.push({ contender: c.id, reason: T1_STOP });
      }
    }
  }
  results.end = machineState();
  results.total_cost_usd = results.runs.reduce((n, r) => n + (r.total_cost_usd ?? 0), 0);
  save();
  log(`wrote ${resultFile}; total cost $${results.total_cost_usd.toFixed(2)} over ${results.runs.length} runs`);
  await SHOP?.close();
}

const T1_STOP = 'T1 failed twice; remaining agent runs stopped per the budget rule';
export const runKey = (r) => `${r.task}|${r.contender}|${r.rep}`;
/** A precheck void is permanent only when the page itself changed; anything else (network, HTTP) is retried. */
export const invalidKind = (why) => (/^page changed/.test(why) ? 'page-changed' : 'unavailable');
export const isRetryable = (r) => Boolean(r.interrupted) || (Boolean(r.invalid) && (r.invalid_kind ?? invalidKind(String(r.invalid_reason ?? ''))) === 'unavailable');

/** mulberry32: a small seeded PRNG, so a recorded seed reproduces the order exactly. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(list, rnd) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Williams design: n rows (2n when n is odd) of 0..n-1 in which every value takes every position equally often
 * and every ordered pair of values is adjacent equally often. Row r is the base row 0, 1, n-1, 2, n-2, ... plus r.
 */
export function williams(n) {
  const base = [0];
  for (let i = 1; i < n; i += 1) base.push(i % 2 ? (i + 1) / 2 : n - i / 2);
  const rows = Array.from({ length: n }, (_, r) => base.map((v) => (v + r) % n));
  return n % 2 ? [...rows, ...rows.map((row) => [...row].reverse())] : rows;
}

/**
 * The run order: rep by rep, task by task, every contender once per (rep, task) block. Without a seed, every
 * block uses the given contender order (round 1). With a seed, block b uses Williams row b (mod the row count),
 * with the rows and the tool labels shuffled by the seed: across the run each tool is first, last and next to
 * each other tool equally often, so load or site-latency drift within a block cannot favour one tool. A pure
 * function of its arguments, so --resume replays the same order.
 */
export function schedule(reps, tasks, contenderIds, seed = null) {
  const out = [];
  const n = contenderIds.length;
  let rows = null;
  let labels = contenderIds;
  if (seed != null && n > 1) {
    const rnd = prng(Number(seed));
    labels = shuffle(contenderIds, rnd);
    rows = shuffle(williams(n), rnd);
  }
  let b = 0;
  for (let rep = 1; rep <= reps; rep += 1) {
    for (const task of tasks) {
      const row = rows ? rows[b % rows.length] : contenderIds.map((_, i) => i);
      for (const i of row) out.push({ rep, task, contender: labels[i] });
      b += 1;
    }
  }
  return out;
}

/** The contender order of each (rep, task) block, in the order of the given list (planned or recorded runs). */
export function blockOrders(order) {
  const m = new Map();
  for (const s of order) {
    const k = `${s.rep}|${s.task}`;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(s.contender);
  }
  return [...m].map(([k, ids]) => ({ block: k, order: ids }));
}

if (process.argv[1] === new URL(import.meta.url).pathname) await main();
