// End-to-end smoke: the built server over stdio, headless + isolated, data: pages.
// Expectations come from PLAN.md forms or from page state read back, never from the tool's own output.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Smoke, chromePidsUnder, page, refOf } from './client.js';

const COUNTER = page(`<title>Counter</title>
<main><h1>Counter</h1>
<button id="inc" onclick="document.getElementById('n').textContent = String(Number(document.getElementById('n').textContent) + 1)">Add</button>
<span id="n">0</span>
<label>Name <input id="name"></label>
<label>Secret <input id="pw" type="password"></label>
</main>`);

const FORM = page(`<title>Form</title>
<form id="f" onsubmit="event.preventDefault(); document.title = 'submitted';">
<label>Email <input id="email" type="email"></label>
<label>Country <select id="country"><option value="at">Austria</option><option value="be">Belgium</option></select></label>
<label><input id="agree" type="checkbox"> Agree</label>
<button type="submit">Send</button>
</form>`);

const DIALOG = page(`<title>Dialog</title>
<button onclick="window.answer = confirm('Sure?')">Ask</button>`);

const TALL = page(`<title>Tall</title><button>Top</button><div style="height:3000px"></div><button>Bottom</button>`);

const PLAN = page(`<title>Plan</title>
<section aria-label="Notice"><p>Only text in a named region.</p></section>
<form><fieldset id="plan"><legend>Plan</legend>
<label><input type="radio" name="plan" value="basic"> Basic</label>
<label><input type="radio" name="plan" value="pro"> Pro</label>
</fieldset>
<label>Email <input id="email" type="email"></label>
<label><input id="agree" type="checkbox"> Agree</label></form>`);

const MIDDIALOG = page(`<title>Mid</title>
<input id="a"><input id="b" oninput="window.answer = confirm('Sure?')"><input id="c">
<button id="go" onclick="window.submitted = (window.submitted || 0) + 1">Go</button>
<input id="t" oninput="if (this.value === 'x') confirm('Typed?')" onkeydown="if (event.key === 'Enter') window.entered = 1">`);

const STALE = page(`<title>Stale</title>
<div id="box"><button onclick="window.clicks = (window.clicks || 0) + 1">Save</button></div>`);

describe('smoke: built server end to end', () => {
  const s = new Smoke();
  let leftovers: number[] = [];

  before(async () => {
    await s.start();
  });

  after(async () => {
    leftovers = await s.stop();
    assert.deepEqual(leftovers, [], 'no Chrome under the test TMPDIR may survive the server');
  });

  it('A1: initialize + tools/list answer fast and start no Chrome', async () => {
    const t0 = Date.now();
    const names = await s.listTools();
    assert.ok(Date.now() - t0 < 1000);
    for (const n of ['session', 'tabs', 'navigate', 'snapshot', 'screenshot', 'read', 'find', 'click', 'type', 'fill_form', 'press', 'hover', 'scroll', 'drag', 'upload', 'dialog', 'wait', 'evaluate', 'console', 'network', 'batch']) {
      assert.ok(names.includes(n), `tool ${n} registered`);
    }
    assert.deepEqual(chromePidsUnder(s.tmp), []);
  });

  it('contract Q10: the initial blank tab is t1 and the first tabs new reuses it', async () => {
    const r = await s.call('tabs', { action: 'new' });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /^\[t1\] /);
    const list = (await s.call('tabs', { action: 'list' })).text;
    assert.equal(list.split('\n').length, 1, list);
    assert.match(list, /^t1 .*\(active\)$/);
  });

  it('navigate + snapshot: header form and an element line with a ref', async () => {
    const r = await s.call('navigate', { url: COUNTER });
    assert.equal(r.isError, false, r.text);
    // PLAN: "[t1] navigated <url> "<title>" (<status>)" then the snapshot; data: URLs have no HTTP status.
    assert.match(r.text.split('\n')[0] ?? '', /^\[t1\] navigated data:text\/html,.* "Counter"/);
    assert.match(r.text, /^\[t1\] "Counter" data:text\/html,.* \(untrusted page content\)$/m);
    assert.match(r.text, /^ *- button "Add" e\d+$/m);
    assert.match(r.text, /^ *- heading "Counter" e\d+ level=1$/m);
  });

  it('viewport_only: only elements intersecting the viewport', async () => {
    await s.call('navigate', { url: TALL, snapshot: false });
    const all = (await s.call('snapshot')).text;
    assert.match(all, /- button "Top" e\d+/);
    assert.match(all, /- button "Bottom" e\d+/);
    const vp = (await s.call('snapshot', { viewport_only: true })).text;
    assert.match(vp, /- button "Top" e\d+/);
    assert.doesNotMatch(vp, /"Bottom"/);
    await s.call('navigate', { url: COUNTER, snapshot: false });
  });

  it('click: the page counter increments (read back from the page)', async () => {
    const snap = (await s.call('snapshot')).text;
    const r = await s.call('click', { target: refOf(snap, 'button', 'Add') });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /^\[t1\] clicked e\d+ button "Add"/);
    assert.equal(await s.read("document.getElementById('n').textContent"), '1');
    const r2 = await s.call('click', { target: '#inc' });
    assert.equal(r2.isError, false, r2.text);
    assert.equal(await s.read("document.getElementById('n').textContent"), '2');
  });

  it('type: replace, append, and a password value never echoed', async () => {
    const snap = (await s.call('snapshot')).text;
    const name = refOf(snap, 'textbox', 'Name');
    assert.equal((await s.call('type', { target: name, text: 'Ann' })).isError, false);
    assert.equal((await s.call('type', { target: name, text: ' Lee', append: true })).isError, false);
    assert.equal(await s.read("document.getElementById('name').value"), 'Ann Lee');
    const secret = 'hunter2-SMOKE-PW';
    const r = await s.call('type', { target: '#pw', text: secret });
    assert.equal(r.isError, false, r.text);
    const snap2 = (await s.call('snapshot')).text;
    assert.ok(!snap2.includes(secret) && !r.text.includes(secret), 'password literal must not appear');
    assert.match(snap2, /- textbox "Secret" e\d+ password( focused)? value=<redacted>/);
  });

  it('fill_form: text, select by label, checkbox, then submit', async () => {
    await s.call('navigate', { url: FORM, snapshot: false });
    const r = await s.call('fill_form', {
      fields: [
        { target: '#email', value: 'ann@example.com' },
        { target: '#country', value: 'Belgium' },
        { target: '#agree', value: true },
      ],
      submit: 'role=button[name="Send"]',
    });
    assert.equal(r.isError, false, r.text);
    assert.equal((r.text.match(/^ok e\d+ /gm) ?? []).length, 3, r.text);
    const state = await s.read("({ e: document.getElementById('email').value, c: document.getElementById('country').value, a: document.getElementById('agree').checked, t: document.title })");
    assert.deepEqual(state, { e: 'ann@example.com', c: 'be', a: true, t: 'submitted' });
  });

  it('fill_form: a bad option fails per field and submit is not clicked', async () => {
    await s.call('navigate', { url: FORM, snapshot: false });
    const r = await s.call('fill_form', {
      fields: [{ target: '#country', value: 'Narnia' }],
      submit: 'role=button[name="Send"]',
    });
    assert.equal(r.isError, true);
    assert.match(r.text, /^failed e\d+ combobox "Country": no option "Narnia" \(options: "Austria", "Belgium"\)/m);
    assert.equal(await s.read('document.title'), 'Form');
  });

  it('tabs: new, select, close; ids are not reused', async () => {
    const r1 = await s.call('tabs', { action: 'new', url: COUNTER });
    assert.equal(r1.isError, false, r1.text);
    assert.match(r1.text, /^\[t2\] navigated/);
    let list = (await s.call('tabs', { action: 'list' })).text;
    assert.match(list, /^t2 "Counter" .* \(active\)$/m);
    assert.equal((list.match(/\(active\)/g) ?? []).length, 1);
    await s.call('tabs', { action: 'select', tab: 't1' });
    list = (await s.call('tabs', { action: 'list' })).text;
    assert.match(list, /^t1 .*\(active\)$/m);
    await s.call('tabs', { action: 'select', tab: 't2' });
    const c = await s.call('tabs', { action: 'close' });
    assert.equal(c.isError, false, c.text);
    list = (await s.call('tabs', { action: 'list' })).text;
    assert.doesNotMatch(list, /^t2 /m);
    assert.match(list, /^t1 .*\(active\)$/m);
    const r3 = await s.call('tabs', { action: 'new' });
    assert.match(r3.text, /^\[t3\]/);
    await s.call('tabs', { action: 'close', tab: 't3' });
  });

  it('confirm dialog: pending, other tools fail fast, accept gives true', async () => {
    await s.call('navigate', { url: DIALOG, snapshot: false });
    const r = await s.call('click', { target: 'text=Ask' });
    assert.ok(r.ms < 2000, `returned in ${r.ms}ms`);
    assert.match(r.text, /→ dialog pending confirm "Sure\?" \(use dialog accept\|dismiss\)/);
    const blocked = await s.call('snapshot');
    assert.equal(blocked.isError, true);
    assert.ok(blocked.ms < 1000);
    assert.match(blocked.text, /Sure\?/);
    const list = (await s.call('tabs', { action: 'list' })).text;
    assert.match(list, /dialog=confirm/);
    const acc = await s.call('dialog', { action: 'accept' });
    assert.equal(acc.isError, false, acc.text);
    assert.equal(await s.read('window.answer'), true);
  });

  it('batch: steps run in order and a failure skips the rest', async () => {
    const r = await s.call('batch', {
      steps: [
        { tool: 'navigate', args: { url: COUNTER, snapshot: false } },
        { tool: 'click', args: { target: '#inc' } },
        { tool: 'click', args: { target: '#does-not-exist', timeout_ms: 300 } },
        { tool: 'click', args: { target: '#inc' } },
      ],
    });
    assert.match(r.text, /^## step 1: navigate/m);
    assert.match(r.text, /^## step 3: click \(error\)/m);
    assert.match(r.text, /^## step 4: click\nskipped$/m);
    assert.equal(await s.read("document.getElementById('n').textContent"), '1');
    const r2 = await s.call('batch', {
      stop_on_error: false,
      steps: [
        { tool: 'click', args: { target: '#does-not-exist', timeout_ms: 300 } },
        { tool: 'click', args: { target: '#inc' } },
      ],
    });
    assert.doesNotMatch(r2.text, /skipped/);
    assert.equal(await s.read("document.getElementById('n').textContent"), '2');
  });

  it('stale refs: unique re-render re-resolves; ambiguous gives the stale error', async () => {
    await s.call('navigate', { url: STALE, snapshot: false });
    let ref = refOf((await s.call('snapshot')).text, 'button', 'Save');
    await s.read("(() => { const b = document.querySelector('button'); const n = b.cloneNode(true); n.onclick = b.onclick; b.remove(); document.getElementById('box').append(n); return 1; })()");
    const r = await s.call('click', { target: ref });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, new RegExp(`\\(re-resolved ${ref} -> e\\d+ button "Save"\\)`));
    assert.equal(await s.read('window.clicks'), 1);

    ref = refOf((await s.call('snapshot')).text, 'button', 'Save');
    await s.read("(() => { document.getElementById('box').append(document.querySelector('button').cloneNode(true)); return 1; })()");
    ref = refOf((await s.call('snapshot')).text, 'button', 'Save');
    await s.read("(() => { const bs = document.querySelectorAll('button'); bs[0].remove(); const n = bs[1].cloneNode(true); document.getElementById('box').append(n); return 1; })()");
    const r2 = await s.call('click', { target: ref });
    assert.equal(r2.isError, true);
    assert.match(r2.text, new RegExp(`${ref} is stale \\(element removed\\)\nhint: take a new snapshot`));
    assert.equal(await s.read('window.clicks'), 1);
  });

  it('contract Q16: session launch says tabs not carried over', async () => {
    const r = await s.call('session', { action: 'launch', headless: true });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /tabs not carried over/);
    const st = (await s.call('session', { action: 'status' })).text;
    assert.match(st, /\bmode=launch\b.*\bheadless=true\b/);
  });

  it('fill_form: a fieldset target with a string value picks the radio by label or value (contract answer 11)', async () => {
    await s.call('navigate', { url: PLAN, snapshot: false });
    const r = await s.call('fill_form', { fields: [{ target: '#plan', value: 'Pro' }] });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /^ok e\d+ group "Plan"/m);
    assert.equal(await s.read("document.querySelector('input[name=plan]:checked')?.value"), 'pro');
    const v = await s.call('fill_form', { fields: [{ target: '#plan', value: 'basic' }] });
    assert.equal(v.isError, false, v.text);
    assert.equal(await s.read("document.querySelector('input[name=plan]:checked')?.value"), 'basic');
  });

  it('fill_form: one shared budget; a field that never gets a turn is "timed out (call budget)" (answers 1, 2)', async () => {
    await s.call('navigate', { url: PLAN, snapshot: false });
    const budget = 1500;
    const r = await s.call('fill_form', {
      timeout_ms: budget,
      fields: [
        { target: '#never-there', value: 'x' },
        { target: '#email', value: 'a@b.c' },
      ],
    });
    assert.equal(r.isError, true, r.text);
    assert.ok(r.ms <= budget + 2000, `returned in ${r.ms} ms`);
    const lines = r.text.split('\n');
    assert.match(lines[1] ?? '', /^hint: /, 'line 2 is the hint');
    assert.match(r.text, /^failed "#email": timed out \(call budget\)$/m);
    assert.equal(await s.read("document.getElementById('email').value"), '', 'the unreached field was not filled');
  });

  it('snapshot: a named landmark holding only text is kept in interactive mode (contract answer 12); type= on non-text inputs', async () => {
    await s.call('navigate', { url: PLAN, snapshot: false });
    const t = (await s.call('snapshot')).text;
    assert.match(t, /^- region "Notice" e\d+$/m);
    assert.match(t, /^ *- checkbox "Agree" e\d+ type=checkbox checked=false$/m);
    assert.match(t, /^ *- radio "Pro" e\d+ type=radio checked=(true|false)$/m);
  });
  it('fill_form stops at the first dialog: later fields not attempted, submit not clicked (PLAN item 10)', async () => {
    await s.call('navigate', { url: MIDDIALOG, snapshot: false });
    const r = await s.call('fill_form', {
      fields: [
        { target: '#a', value: 'A' },
        { target: '#b', value: 'B' },
        { target: '#c', value: 'C' },
      ],
      submit: '#go',
    });
    assert.match(r.text, /→ dialog pending confirm "Sure\?"/);
    assert.match(r.text, /not attempted \(dialog pending\)/);
    assert.match(r.text.split('\n')[0] ?? '', /filled 2\/2 fields/, 'the summary counts attempted fields');
    await s.call('dialog', { action: 'dismiss' });
    await new Promise((res) => setTimeout(res, 500));
    assert.equal(await s.read("document.getElementById('c').value"), '', 'field c was never filled');
    assert.equal(await s.read('window.submitted ?? 0'), 0, 'submit was never clicked');
  });

  it('type submit:true does not press Enter when a dialog opened while typing (PLAN item 10)', async () => {
    await s.call('navigate', { url: MIDDIALOG, snapshot: false });
    const r = await s.call('type', { target: '#t', text: 'x', submit: true });
    assert.match(r.text, /→ dialog pending confirm "Typed\?"/);
    await s.call('dialog', { action: 'dismiss' });
    await new Promise((res) => setTimeout(res, 500));
    assert.equal(await s.read('window.entered ?? 0'), 0, 'Enter was not pressed');
  });

  it('wait target=<ref from an earlier document> is an error, not a check on the new page (C5)', async () => {
    await s.call('navigate', { url: COUNTER, snapshot: false });
    const ref = refOf((await s.call('snapshot')).text, 'button', 'Add');
    await s.call('navigate', { url: COUNTER, snapshot: false });
    const r = await s.call('wait', { target: ref, state: 'visible', timeout_ms: 2000 });
    assert.equal(r.isError, true, r.text);
    assert.match(r.text, new RegExp(`${ref} is from an earlier document`));
  });
});
