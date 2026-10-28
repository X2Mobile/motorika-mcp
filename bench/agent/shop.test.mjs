// T4 redesign: the local shop fixture and the server-log oracle. No network, no real claude.
// Must-fail and must-pass sets come from the reviewer's scripts (t4.mjs, t4b.mjs, t4extra.mjs, shapes.mjs, 2026-10-26):
// the tool-output shapes are kept as they were, because the oracle must not depend on them at all.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { TASKS, summariseRun } from './run.mjs';
import { SHOP_PASSWORD, SHOP_USER, base32Id, startShop } from './shop-server.mjs';

const HERE = new URL('.', import.meta.url).pathname;
const BENCH = join(HERE, '..');

/** A browser-like HTTP client: one cookie jar, redirects followed by hand. */
function client() {
  const jar = new Map();
  async function req(url, { method = 'GET', form } = {}) {
    let target = url;
    let opts = { method, body: form ? new URLSearchParams(form).toString() : undefined };
    for (let hop = 0; hop < 5; hop += 1) {
      const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      const res = await fetch(target, { method: opts.method, body: opts.body, redirect: 'manual', headers: { ...(opts.body && { 'content-type': 'application/x-www-form-urlencoded' }), ...(cookie && { cookie }) } });
      const set = res.headers.get('set-cookie');
      if (set) {
        const [kv] = set.split(';');
        const [k, v] = kv.split('=');
        jar.set(k.trim(), v);
      }
      if (res.status === 303) {
        target = new URL(res.headers.get('location'), target).href;
        opts = { method: 'GET' };
        continue;
      }
      return { status: res.status, url: target, text: await res.text() };
    }
    throw new Error('too many redirects');
  }
  return { req, jar };
}

/** The genuine purchase, the way any browser would do it through the forms. Returns the confirmation page text. */
async function buy(c, url, { item = 'jacket', first = 'Ann', last = 'Bench', postcode = '10115' } = {}) {
  await c.req(`${url}login`, { method: 'POST', form: { username: SHOP_USER, password: SHOP_PASSWORD } });
  await c.req(`${url}cart/add`, { method: 'POST', form: { item } });
  await c.req(`${url}checkout`, { method: 'POST', form: { first_name: first, last_name: last, postcode } });
  const overview = await c.req(`${url}overview`);
  const done = await c.req(`${url}finish`, { method: 'POST' });
  return { overview: overview.text, done: done.text };
}
const idOn = (html) => /order number is <strong>([A-Z2-7]{8})<\/strong>/.exec(html)?.[1] ?? null;

function stream(calls, finalText) {
  const lines = [];
  calls.forEach((c, i) => {
    lines.push({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `t${i}`, name: c.name, input: c.input }] } });
    const content = [{ type: 'text', text: c.text ?? '' }, ...Array.from({ length: c.images ?? 0 }, () => ({ type: 'image', source: { data: 'x' } }))];
    lines.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `t${i}`, content, is_error: Boolean(c.err) }] } });
  });
  lines.push({ type: 'result', result: finalText, total_cost_usd: 0.2, duration_ms: 1, num_turns: 1 });
  return lines.map((l) => JSON.stringify(l)).join('\n');
}
const answer = (id) => `\`\`\`json\n{"order_id": ${JSON.stringify(id)}, "total": "$53.99"}\n\`\`\``;
const verdict = (calls, id, orders) => summariseRun('x', 'T4', 1, stream(calls, answer(id)), { shopOrders: orders });

// Reviewer's tool-output shapes (t4.mjs, t4extra.mjs). The oracle ignores them; what matters is what the shop logged.
const pp = (n) => `mcp__puppeteer__puppeteer_${n}`;
const pw = (n) => `mcp__playwright__${n}`;
const ai = (n) => `mcp__agent-infra__browser_${n}`;
const cic = (n) => `mcp__claude-in-chrome__${n}`;
const vis = (n) => `mcp__playwright-vision__${n}`;
const ov = { name: pp('click'), input: { selector: '#continue' }, text: 'Clicked: #continue' };
const shot = (n) => ({ name: pp('screenshot'), input: { name: n }, text: `Screenshot '${n}' taken`, images: 1 });
const BYPASSES = {
  'bare claim, no calls': [],
  'bare claim, overview screenshot only': [ov, shot('overview')],
  'puppeteer click #finish ERRORED + overview screenshot': [ov, shot('overview'), { name: pp('click'), input: { selector: '#finish' }, text: 'Failed to click #finish', err: true }],
  'screenshot NAMED before-finish': [ov, shot('before-finish')],
  'evaluate mentioning finish, never clicked': [ov, shot('o'), { name: pp('evaluate'), input: { script: '!!document.querySelector("#finish")' }, text: 'Execution result:\ntrue' }],
  'playwright wait_for heading TIMED OUT': [{ name: pw('browser_wait_for'), input: { text: 'Thank you for your order' }, text: 'TimeoutError', err: true }],
  'playwright click on Finish ERRORED': [{ name: pw('browser_click'), input: { element: 'Finish button', ref: 'e99' }, text: 'Error: Ref e99 not found', err: true }],
  'evaluate returns a hard-coded heading': [{ name: pp('evaluate'), input: { script: '"Thank you for your " + "order"' }, text: 'Execution result:\n"Thank you for your order"' }],
  'vision click on wrong coords + screenshot': [{ name: vis('browser_mouse_click_xy'), input: { x: 10, y: 10 }, text: 'clicked' }, { name: vis('browser_take_screenshot'), input: {}, text: 'shot', images: 1 }],
  'cic browser_batch navigate straight to the confirmation page': [{ name: cic('browser_batch'), input: { actions: [{ name: 'navigate', input: { url: 'complete' } }] }, text: '[navigate] ok' }],
  'puppeteer history.pushState to the confirmation page': [{ name: pp('evaluate'), input: { script: "history.pushState({}, '', 'complete')" }, text: 'Execution result:\nundefined' }],
};
const GENUINE_SHAPES = {
  'agent-infra, index clicks + screenshots': [
    { name: ai('click'), input: { index: 7 }, text: 'Clicked element: 7' },
    { name: ai('screenshot'), input: {}, text: 'Screenshot taken', images: 1 },
    { name: ai('click'), input: { index: 9 }, text: 'Clicked element: 9' },
    { name: ai('screenshot'), input: {}, text: 'Screenshot taken', images: 1 },
  ],
  'agent-infra, clickable elements after finish (no heading)': [
    { name: ai('click'), input: { index: 9 }, text: 'Clicked element: 9' },
    { name: ai('get_clickable_elements'), input: {}, text: '[0]<a>Back to products</a>' },
  ],
  'claude-in-chrome, coordinate clicks + screenshots': [
    { name: cic('computer'), input: { action: 'left_click', coordinate: [600, 700], tabId: 1 }, text: 'Clicked at (600, 700)' },
    { name: cic('computer'), input: { action: 'screenshot', tabId: 1 }, text: 'Successfully captured screenshot', images: 1 },
  ],
  'claude-in-chrome, ref click + get_page_text': [{ name: cic('computer'), input: { action: 'left_click', ref: 'ref_12', tabId: 1 }, text: 'Clicked on ref_12' }],
  'devtools click + screenshot': [{ name: 'mcp__devtools__click', input: { uid: '1_40' }, text: 'Successfully clicked on the element' }, { name: 'mcp__devtools__take_screenshot', input: {}, text: 'Took a screenshot', images: 1 }],
  'puppeteer click #finish + screenshot': [{ name: pp('click'), input: { selector: '#finish' }, text: 'Clicked: #finish' }, shot('done')],
};

describe('T4 shop fixture', () => {
  let shop;
  before(async () => {
    shop = await startShop();
  });
  after(async () => shop.close());

  it('a genuine purchase records exactly one order with the run id, item, name, postcode, total and an 8-char base32 id', async () => {
    const run = shop.newRun();
    const { overview, done } = await buy(client(), run.url);
    assert.match(overview, /Item total: \$49\.99/);
    assert.match(overview, /Tax: \$4\.00/);
    assert.match(overview, /Total: \$53\.99/);
    assert.match(done, /Thank you for your order!/);
    const orders = shop.orders(run.runId);
    assert.equal(orders.length, 1);
    assert.match(orders[0].order_id, /^[A-Z2-7]{8}$/);
    assert.equal(idOn(done), orders[0].order_id, 'the confirmation page shows the logged id');
    assert.deepEqual({ ...orders[0], at: undefined, order_id: undefined }, { run_id: run.runId, items: ['Canvas Field Jacket'], first_name: 'Ann', last_name: 'Bench', postcode: '10115', item_total: 49.99, tax: 4, total: 53.99, at: undefined, order_id: undefined });
  });
  it('the login page prints the demo credentials; the password is not a known demo password', async () => {
    const page = (await client().req(shop.newRun().url)).text;
    assert.ok(page.includes(SHOP_USER) && page.includes(SHOP_PASSWORD));
    assert.notEqual(SHOP_PASSWORD, 'secret_sauce');
  });
  it('a wrong password gets no session and no order', async () => {
    const run = shop.newRun();
    const c = client();
    await c.req(`${run.url}login`, { method: 'POST', form: { username: SHOP_USER, password: 'secret_sauce' } });
    await c.req(`${run.url}finish`, { method: 'POST' });
    assert.equal(shop.orders(run.runId).length, 0);
    assert.equal(c.jar.size, 0);
  });
  it('a direct visit to the confirmation page records nothing and shows no id (no session, and logged in without Finish)', async () => {
    const run = shop.newRun();
    const anon = await client().req(`${run.url}complete`);
    assert.equal(idOn(anon.text), null);
    assert.ok(!/[A-Z2-7]{8}<\/strong>/.test(anon.text));
    const c = client();
    await c.req(`${run.url}login`, { method: 'POST', form: { username: SHOP_USER, password: SHOP_PASSWORD } });
    await c.req(`${run.url}cart/add`, { method: 'POST', form: { item: 'jacket' } });
    const logged = await c.req(`${run.url}complete`);
    assert.equal(idOn(logged.text), null);
    assert.equal(shop.orders(run.runId).length, 0);
  });
  it('GET /finish and a Finish with an empty cart or no checkout info record nothing', async () => {
    const run = shop.newRun();
    const c = client();
    await c.req(`${run.url}login`, { method: 'POST', form: { username: SHOP_USER, password: SHOP_PASSWORD } });
    await c.req(`${run.url}finish`);
    await c.req(`${run.url}finish`, { method: 'POST' });
    await c.req(`${run.url}cart/add`, { method: 'POST', form: { item: 'jacket' } });
    await c.req(`${run.url}finish`, { method: 'POST' });
    assert.equal(shop.orders(run.runId).length, 0);
  });
  it('runs are isolated: one run\'s session and orders are invisible to another', async () => {
    const a = shop.newRun();
    const b = shop.newRun();
    const c = client();
    await buy(c, a.url);
    // The same client (cookie jar) at run b's path has no session there.
    const atB = await c.req(`${b.url}complete`);
    assert.equal(idOn(atB.text), null);
    await c.req(`${b.url}finish`, { method: 'POST' });
    assert.equal(shop.orders(b.runId).length, 0);
    assert.equal(shop.orders(a.runId).length, 1);
  });
  it('an unknown or guessed run path is 404', async () => {
    const r = await client().req(`${shop.origin}/r/${base32Id(16)}/`);
    assert.equal(r.status, 404);
  });
});

describe('T4 oracle: the server log, never the tool output', () => {
  let shop;
  before(async () => {
    shop = await startShop();
  });
  after(async () => shop.close());

  for (const [name, calls] of Object.entries(BYPASSES)) {
    it(`must fail: ${name} (the shop never saw Finish), with an invented id`, async () => {
      const run = shop.newRun();
      const r = verdict(calls, 'ABCDEFGH', shop.orders(run.runId));
      assert.equal(r.success, false);
      assert.match(r.detail, /no order recorded/);
    });
  }
  it('must fail: a shortcut URL to the confirmation page creates no order and no id to report', async () => {
    const run = shop.newRun();
    const page = await client().req(`${run.url}complete`);
    const r = verdict(BYPASSES['cic browser_batch navigate straight to the confirmation page'], idOn(page.text) ?? 'NONE', shop.orders(run.runId));
    assert.equal(r.success, false);
  });
  it('must fail: a hard-coded or invented id when a real order exists', async () => {
    const run = shop.newRun();
    await buy(client(), run.url);
    const r = verdict(GENUINE_SHAPES['agent-infra, index clicks + screenshots'], 'AAAAAAAA', shop.orders(run.runId));
    assert.equal(r.success, false);
    assert.match(r.detail, /is not the logged/);
  });
  it('must fail: an id copied from another run', async () => {
    const other = shop.newRun();
    const { done } = await buy(client(), other.url);
    const run = shop.newRun();
    const r = verdict([], idOn(done), shop.orders(run.runId));
    assert.equal(r.success, false);
  });
  it('must fail: the wrong item, name, postcode or an extra item in the logged order', async () => {
    for (const opts of [{ item: 'flask' }, { first: 'Laszl0' }, { last: 'Bnech' }, { postcode: '400002' }]) {
      const run = shop.newRun();
      const { done } = await buy(client(), run.url, opts);
      const r = verdict([], idOn(done), shop.orders(run.runId));
      assert.equal(r.success, false, JSON.stringify(opts));
      assert.match(r.detail, /order wrong/);
    }
    const run = shop.newRun();
    const c = client();
    await c.req(`${run.url}login`, { method: 'POST', form: { username: SHOP_USER, password: SHOP_PASSWORD } });
    await c.req(`${run.url}cart/add`, { method: 'POST', form: { item: 'mug' } });
    await c.req(`${run.url}cart/add`, { method: 'POST', form: { item: 'jacket' } });
    await c.req(`${run.url}checkout`, { method: 'POST', form: { first_name: 'Ann', last_name: 'Bench', postcode: '10115' } });
    const done = (await c.req(`${run.url}finish`, { method: 'POST' })).text;
    const r = verdict([], idOn(done), shop.orders(run.runId));
    assert.match(r.detail, /order wrong: items,total/);
  });
  it('must fail: more than one order in the run fails as "multiple orders", even quoting a real id', async () => {
    const run = shop.newRun();
    const c = client();
    const first = await buy(c, run.url);
    await buy(c, run.url);
    const r = verdict([], idOn(first.done), shop.orders(run.runId));
    assert.equal(r.success, false);
    assert.match(r.detail, /multiple orders \(2\)/);
  });
  for (const [name, calls] of Object.entries(GENUINE_SHAPES)) {
    it(`must pass: genuine ${name}, with no per-tool code`, async () => {
      const run = shop.newRun();
      const { done } = await buy(client(), run.url);
      const r = verdict(calls, idOn(done), shop.orders(run.runId));
      assert.equal(r.success, true, r.detail);
    });
  }
  it('must pass: the id in lower case or with spaces around it', async () => {
    const run = shop.newRun();
    const { done } = await buy(client(), run.url);
    assert.equal(verdict([], ` ${idOn(done).toLowerCase()} `, shop.orders(run.runId)).success, true);
  });
  it('the T4 oracle reads no tool output: no evidence parser is left in run.mjs', () => {
    const src = readFileSync(join(HERE, 'run.mjs'), 'utf8');
    assert.ok(!src.includes('t4Evidence'));
    assert.ok(!/shortcut/i.test(src));
    assert.ok(!src.includes('saucedemo'));
  });
});

describe('T5 unchanged since 41fd516', () => {
  it('T5 prompt, precheck and oracle are byte-identical', () => {
    // The 41fd516 block is frozen in fixtures/frozen-T5-41fd516.txt (block text plus one newline), so the guard
    // needs no git history: the published repo is a single commit.
    const base = readFileSync(join(HERE, 'fixtures', 'frozen-T5-41fd516.txt'), 'utf8');
    assert.ok(base.endsWith('\n'), 'frozen T5 fixture lost its trailing newline');
    const block = (s) => {
      const at = s.indexOf('  T5: {');
      assert.ok(at >= 0, 'T5 not found in run.mjs');
      return s.slice(at, s.indexOf('\n  },\n', at));
    };
    assert.equal(block(readFileSync(join(HERE, 'run.mjs'), 'utf8')), base.slice(0, -1), 'T5 changed');
  });
});

describe('T4 end to end through run.mjs (fake claude that shops over HTTP)', () => {
  // The fake claude reads the shop URL from its prompt and does what an agent's browser would do: the forms.
  // CHEAT=1: it visits the confirmation page directly and reports an invented id.
  const dir = mkdtempSync(join(tmpdir(), 'motorika-bench-shop-'));
  writeFileSync(
    join(dir, 'claude'),
    `#!/usr/bin/env node
const prompt = process.argv[process.argv.indexOf('-p') + 1];
const url = /Open the shop at (\\S+)/.exec(prompt)[1];
const jar = [];
async function req(u, method = 'GET', form) {
  for (let hop = 0; hop < 5; hop += 1) {
    const res = await fetch(u, { method, body: form && new URLSearchParams(form).toString(), redirect: 'manual', headers: { ...(form && { 'content-type': 'application/x-www-form-urlencoded' }), ...(jar.length && { cookie: jar.join('; ') }) } });
    const sc = res.headers.get('set-cookie'); if (sc) jar.push(sc.split(';')[0]);
    if (res.status === 303) { u = new URL(res.headers.get('location'), u).href; method = 'GET'; form = undefined; continue; }
    return res.text();
  }
}
(async () => {
  let id = 'ZZZZZZZZ';
  if (process.env.CHEAT === '1') {
    await req(url + 'complete');
  } else {
    const page = await req(url);
    const pw = /password <code>([^<]+)<\\/code>/.exec(page)[1];
    await req(url + 'login', 'POST', { username: 'shopper', password: pw });
    await req(url + 'cart/add', 'POST', { item: 'jacket' });
    await req(url + 'checkout', 'POST', { first_name: 'Ann', last_name: 'Bench', postcode: '10115' });
    const done = await req(url + 'finish', 'POST');
    id = /order number is <strong>([A-Z2-7]{8})/.exec(done)[1];
  }
  console.log(JSON.stringify({ type: 'result', result: '\`\`\`json\\n{"order_id": "' + id + '", "total": "$53.99"}\\n\`\`\`', total_cost_usd: 0.001, duration_ms: 1, num_turns: 1 }));
})();
`,
  );
  chmodSync(join(dir, 'claude'), 0o755);
  const date = new Date().toISOString().slice(0, 10);
  const tags = [];
  const run = (tag, extra = {}) => {
    tags.push(tag);
    return spawnSync(process.execPath, [join(HERE, 'run.mjs'), '--tag', tag, '--reps', '2', '--tasks', 'T4', '--only', 'motorika', '--shop-port', '0'], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ...extra }, encoding: 'utf8', timeout: 120_000 });
  };
  const file = (tag) => join(BENCH, 'results', `${date}-agent-${tag}.json`);
  after(() => {
    for (const t of tags) {
      rmSync(file(t), { force: true });
      rmSync(join(BENCH, 'results', 'agent', `${date}-${t}`), { recursive: true, force: true });
    }
    rmSync(dir, { recursive: true, force: true });
  });
  it('a genuine purchase passes; each rep gets its own shop run and logs exactly its own order', () => {
    const tag = `selftest-shop-${process.pid}`;
    const r = run(tag);
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(readFileSync(file(tag), 'utf8'));
    assert.equal(j.runs.length, 2);
    for (const x of j.runs) {
      assert.equal(x.success, true, x.detail);
      assert.equal(x.shop_orders.length, 1);
    }
    assert.notEqual(j.runs[0].shop_run_id, j.runs[1].shop_run_id);
    assert.notEqual(j.runs[0].shop_orders[0].order_id, j.runs[1].shop_orders[0].order_id);
  });
  it('a direct visit to the confirmation page with an invented id fails', () => {
    const tag = `selftest-shopcheat-${process.pid}`;
    const r = run(tag, { CHEAT: '1' });
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(readFileSync(file(tag), 'utf8'));
    for (const x of j.runs) {
      assert.equal(x.success, false);
      assert.match(x.detail, /no order recorded/);
    }
    assert.ok(existsSync(file(tag)));
  });
});
