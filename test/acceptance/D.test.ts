// Acceptance group D: actions. Oracles: fixture counters/event logs read back via `evaluate`, and what
// the fixture server recorded.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { findAll, parseEffects, parseElementLine, parseTabsList, refOf, tabIdOf, type Snapshot } from '../support/grammar.ts';
import {
  CONSOLE_PAGE,
  downloadBytes,
  FULL_FORM,
  sha256,
  UPLOAD_BYTES,
  UPLOAD_FILE,
  UPLOAD_NAME,
} from '../support/spec.ts';
import { until, useFileServer, type Counts } from '../support/suite.ts';

const ctx = useFileServer('D');

async function go(path: string): Promise<Snapshot> {
  await ctx.s.ok('navigate', { url: ctx.fx.url(path), snapshot: false });
  return ctx.s.snapshot();
}

const counts = (tab?: string) => ctx.s.state<Counts>('window.__counts', tab ? { tab } : {});
const events = (tab?: string) => ctx.s.state<string[]>('window.__events', tab ? { tab } : {});
const byName = (s: Snapshot, name: string) => {
  const hits = findAll(s, { name });
  assert.equal(hits.length, 1, `exactly one element named "${name}"`);
  return hits[0]!.ref;
};

describe('D1 click', () => {
  test('D1 plain, double, right and Shift clicks hit their counters', async () => {
    const s = await go('/click.html');
    await ctx.s.ok('click', { target: refOf(s, 'button', 'Plain') });
    await ctx.s.ok('click', { target: refOf(s, 'button', 'Double'), count: 2 });
    await ctx.s.ok('click', { target: refOf(s, 'button', 'Right'), button: 'right' });
    await ctx.s.ok('click', { target: refOf(s, 'button', 'Shift'), modifiers: ['Shift'] });
    assert.deepEqual(await counts(), { plain: 1, double: 1, right: 1, shift: 1 });
  });

  test('D1 auto-waits for an element that appears after 800 ms', async () => {
    const s = await go('/click.html');
    await ctx.s.ok('click', { target: refOf(s, 'button', 'Show delayed') });
    await ctx.s.ok('click', { target: 'role=button[name="Delayed target"]' });
    assert.deepEqual(await counts(), { delayed: 1 });
  });

  test('D1 scrolls an offscreen element into view and clicks it', async () => {
    const s = await go('/click.html');
    await ctx.s.ok('click', { target: refOf(s, 'button', 'Far below') });
    assert.deepEqual(await counts(), { far: 1 });
  });

  test('D1 waits for an overlay that disappears after 500 ms', async () => {
    const s = await go('/click.html');
    await ctx.s.ok('evaluate', { script: 'armTemp()' });
    await ctx.s.ok('click', { target: refOf(s, 'button', 'Under temporary overlay') });
    assert.deepEqual(await counts(), { underTemp: 1 });
    assert.ok((await ctx.s.state<number>('window.__underTempAt - window.__armedAt')) >= 450, 'the click landed after the overlay left');
  });

  test('D1 a permanent overlay: the error names the covering element', async () => {
    const s = await go('/click.html');
    const r = await ctx.s.err('click', { target: refOf(s, 'button', 'Under permanent overlay'), timeout_ms: 2000 });
    assert.match(r.text, /perm-overlay/);
    assert.deepEqual(await counts(), {});
  });

  test('D1 a disabled button: the error says disabled', async () => {
    const s = await go('/click.html');
    const r = await ctx.s.err('click', { target: refOf(s, 'button', 'Disabled action'), timeout_ms: 2000 });
    assert.match(r.text, /disabled/i);
    assert.deepEqual(await counts(), {});
  });
});

describe('D2 type', () => {
  test('D2 replace (default) and append', async () => {
    const s = await go('/type.html');
    await ctx.s.ok('type', { target: refOf(s, 'textbox', 'Replace me'), text: 'new' });
    await ctx.s.ok('type', { target: refOf(s, 'textbox', 'Append me'), text: 'def', append: true });
    assert.deepEqual(await ctx.s.state('[document.getElementById("replace").value, document.getElementById("append").value]'), ['new', 'abcdef']);
  });

  test('D2 slowly fires per-key events so the autocomplete shows suggestions', async () => {
    const s = await go('/type.html');
    await ctx.s.ok('type', { target: refOf(s, 'textbox', 'City'), text: 'Ber', slowly: true });
    assert.ok((await ctx.s.state<number>('window.__keydowns')) >= 3, 'one keydown per typed character');
    assert.deepEqual(await ctx.s.state('[...document.querySelectorAll("#suggestions li")].map((l) => l.textContent)'), ['Berlin', 'Bern', 'Bergen']);
  });

  test('D2 submit presses Enter (the fixture server records the search form)', async () => {
    ctx.fx.reset();
    const s = await go('/type.html');
    await ctx.s.ok('type', { target: refOf(s, 'textbox', 'Search query'), text: 'needle', submit: true });
    const rec = await until(() => ctx.fx.submissions('search')[0]);
    assert.deepEqual(rec?.fields, [['q', 'needle']]);
  });

  test('D2 types into a contenteditable', async () => {
    const s = await go('/type.html');
    await ctx.s.ok('type', { target: refOf(s, 'textbox', 'Editor'), text: 'rich text' });
    assert.equal(await ctx.s.state('document.getElementById("editor").textContent'), 'rich text');
  });

  test('D2 a controlled input that takes state only from input events receives the value', async () => {
    const s = await go('/type.html');
    await ctx.s.ok('type', { target: refOf(s, 'textbox', 'Controlled'), text: 'react-ish' });
    assert.equal(await ctx.s.state('window.__controlled'), 'react-ish');
    await ctx.s.ok('click', { target: refOf(s, 'textbox', 'City') }); // blur re-renders from state
    assert.equal(await ctx.s.state('document.getElementById("controlled").value'), 'react-ish');
  });
});

describe('D3 fill_form', () => {
  test('D3 fill_form fills the full form in one call and submits it; the server records the expected payload', async () => {
    ctx.fx.reset();
    const s = await go(FULL_FORM.path);
    const i = FULL_FORM.inputs;
    const fields = [
      { target: refOf(s, 'textbox', i.fullName.label), value: i.fullName.value },
      { target: refOf(s, 'textbox', i.email.label), value: i.email.value },
      { target: refOf(s, 'textbox', i.password.label), value: i.password.value },
      { target: refOf(s, 'textbox', i.comments.label), value: i.comments.value },
      { target: refOf(s, 'combobox', i.country.label), value: i.country.valueLabel },
      { target: refOf(s, 'listbox', i.toppings.label), value: [...i.toppings.valueLabels] },
      { target: refOf(s, 'checkbox', i.subscribe.label), value: true },
      { target: refOf(s, 'radio', i.plan.optionLabel), value: true },
      { target: byName(s, i.startDate.label), value: i.startDate.value },
      { target: refOf(s, 'slider', i.volume.label), value: i.volume.value },
      { target: byName(s, i.color.label), value: i.color.value },
      { target: refOf(s, 'file', i.attachment.label), value: UPLOAD_FILE },
      { target: refOf(s, 'textbox', i.bio.label), value: i.bio.value },
    ];
    const r = await ctx.s.ok('fill_form', { fields, submit: refOf(s, 'button', FULL_FORM.submitButton) });
    const lines = r.text.split('\n').filter((l) => /^(ok|failed) e\d+ /.test(l));
    assert.equal(lines.length, fields.length, `one line per field:\n${r.text}`);
    assert.ok(lines.every((l) => l.startsWith('ok ')), r.text);
    for (const f of fields) assert.ok(lines.some((l) => l.startsWith(`ok ${f.target} `)), `line for ${f.target}`);
    const rec = await until(() => ctx.fx.submissions('full')[0]);
    assert.ok(rec, 'the form was submitted');
    assert.deepEqual(rec.fields, FULL_FORM.expectedFields);
    assert.equal(rec.files.length, 1);
    assert.equal(rec.files[0]!.field, FULL_FORM.expectedFile.field);
    assert.equal(rec.files[0]!.name, FULL_FORM.expectedFile.name);
    assert.equal(rec.files[0]!.sha256, sha256(UPLOAD_BYTES()));
  });

  test('D3 a bad field gives a per-field error and the submit is not clicked', async () => {
    ctx.fx.reset();
    const s = await go(FULL_FORM.path);
    const name = refOf(s, 'textbox', 'Full name');
    const country = refOf(s, 'combobox', 'Country');
    const r = await ctx.s.call('fill_form', {
      fields: [
        { target: name, value: 'Ada' },
        { target: country, value: 'Narnia' },
      ],
      submit: refOf(s, 'button', FULL_FORM.submitButton),
    });
    assert.match(r.text, new RegExp(`^ok ${name} `, 'm'));
    assert.match(r.text, new RegExp(`^failed ${country} combobox "Country": .*Narnia`, 'm'));
    await sleep(1000);
    assert.deepEqual(ctx.fx.submissions('full'), [], 'nothing was submitted');
  });

  // CONTRACT-QUESTION: "Targeting a radio group with a string value picks the option by label or value" does
  // not say how a group is targeted (fieldset/radiogroup selector? a group ref from mode=full?). Literal
  // reading used here: a selector for the fieldset that groups the radios.
  test('D3 a radio group target with a string value picks the option by label', async () => {
    await go(FULL_FORM.path);
    const r = await ctx.s.ok('fill_form', { fields: [{ target: '#plan-group', value: 'Enterprise' }] });
    assert.match(r.text, /^ok e\d+ /m);
    assert.equal(await ctx.s.state('document.querySelector("input[name=plan]:checked")?.value'), 'enterprise');
  });
});

describe('D4 press', () => {
  test('D4 Tab moves focus, select-all selects, Enter submits, ArrowDown moves the listbox selection', async () => {
    const s = await go('/keys.html');
    await ctx.s.ok('press', { keys: ['Tab'], target: refOf(s, 'textbox', 'First field') });
    assert.equal(await ctx.s.state('document.activeElement.id'), 'second');
    const selectAll = process.platform === 'darwin' ? 'Meta+a' : 'Control+a';
    await ctx.s.ok('press', { keys: [selectAll], target: refOf(s, 'textbox', 'Select me') });
    assert.deepEqual(await ctx.s.state('[document.getElementById("selectme").selectionStart, document.getElementById("selectme").selectionEnd, document.getElementById("selectme").value.length]'), [0, 23, 23]);
    await ctx.s.ok('press', { keys: ['Enter'], target: refOf(s, 'textbox', 'Enter field') });
    assert.deepEqual(await events(), ['submitted:pressed']);
    await ctx.s.ok('press', { keys: ['ArrowDown'], target: refOf(s, 'listbox', 'Pick one') });
    assert.equal(await ctx.s.state('document.getElementById("pick").selectedIndex'), 1);
  });
});

describe('D5 hover', () => {
  test('D5 hover reveals a CSS :hover menu whose item is clickable afterwards', async () => {
    let s = await go('/hover.html');
    assert.equal(findAll(s, { name: 'Hidden item' }).length, 0, 'hidden before hover');
    await ctx.s.ok('hover', { target: refOf(s, 'button', 'Products') });
    s = await ctx.s.snapshot();
    await ctx.s.ok('click', { target: refOf(s, 'button', 'Hidden item') });
    assert.deepEqual(await counts(), { hiddenItem: 1 });
  });
});

describe('D6 scroll', () => {
  const SCROLLED = /^\[t\d+\] scrolled y=(\d+)\/(\d+) viewport=(\d+)/m;

  test('D6 down, up and to bottom change scrollY; the output reports y/scrollHeight/viewport', async () => {
    const s = await go('/scroll.html');
    const vh = await ctx.s.state<number>('innerHeight');
    let r = await ctx.s.ok('scroll', { direction: 'down' });
    let y = await ctx.s.state<number>('scrollY');
    assert.ok(Math.abs(y - Math.round(vh * 0.8)) <= 2, `default amount is 80% of the viewport: ${y}`);
    const m = SCROLLED.exec(r.text);
    assert.ok(m, r.text);
    assert.deepEqual([Number(m[1]), Number(m[2]), Number(m[3])], [y, 6000, vh]);
    await ctx.s.ok('scroll', { direction: 'up', amount: 200 });
    assert.equal(await ctx.s.state<number>('scrollY'), y - 200);
    r = await ctx.s.ok('scroll', { to: 'bottom' });
    y = await ctx.s.state<number>('scrollY');
    assert.equal(y, 6000 - vh);
    await ctx.s.ok('scroll', { to: 'top' });
    // a scroll container as target
    await ctx.s.ok('scroll', { target: refOf(s, 'region', 'Scroll box'), direction: 'down', amount: 300 });
    assert.deepEqual(await ctx.s.state('[document.getElementById("box").scrollTop, scrollY]'), [300, 0]);
  });

  test('D6 infinite scroll loads more and the height change is reported', async () => {
    await go('/infinite.html');
    const before = await ctx.s.state<number>('document.querySelectorAll("#feed li").length');
    const r = await ctx.s.ok('scroll', { to: 'bottom' });
    const h = / height (\d+) -> (\d+)/.exec(r.text);
    assert.ok(h, `height change reported:\n${r.text}`);
    assert.ok(Number(h[2]) > Number(h[1]));
    assert.ok((await ctx.s.state<number>('document.querySelectorAll("#feed li").length')) > before);
  });
});

describe('D7 drag', () => {
  test('D7 HTML5 drag-and-drop and a pointer-event drag both register the drop', async () => {
    const s = await go('/drag.html');
    // CONTRACT-QUESTION: is a named region with only text inside kept in interactive mode ("a container with
    // nothing included under it is omitted")? The drop targets are therefore given as selectors.
    await ctx.s.ok('drag', { from: refOf(s, 'button', 'Drag source'), to: '#dropzone' });
    await ctx.s.ok('drag', { from: refOf(s, 'button', 'Pointer handle'), to: '#ptarget' });
    const ev = await events();
    assert.ok(ev.includes('html5-drop:payload-42'), ev.join(','));
    assert.ok(ev.includes('pointer-drop'), ev.join(','));
  });
});

describe('D8 upload', () => {
  test('D8 a file input and a file-chooser button both deliver the file (name and bytes)', async () => {
    ctx.fx.reset();
    const s = await go('/upload.html');
    await ctx.s.ok('upload', { target: refOf(s, 'file', 'Upload file'), paths: [UPLOAD_FILE] });
    await ctx.s.ok('upload', { target: refOf(s, 'button', 'Choose file'), paths: [UPLOAD_FILE] });
    await until(() => ctx.fx.submissions('direct').length + ctx.fx.submissions('chooser').length >= 2);
    for (const form of ['direct', 'chooser']) {
      const f = ctx.fx.submissions(form)[0]?.files[0];
      assert.equal(f?.name, UPLOAD_NAME, form);
      assert.equal(f?.sha256, sha256(UPLOAD_BYTES()), form);
    }
  });

  test('D8 a path outside the roots and a dot-file are refused, naming the flag', async () => {
    ctx.fx.reset();
    const s = await go('/upload.html');
    const outside = join(ctx.s.root, 'outside.txt'); // not under cwd, output-dir, ~/Downloads|Desktop|Documents
    writeFileSync(outside, 'outside root');
    const dotDir = join(ctx.s.outputDir, 'uploads');
    mkdirSync(dotDir, { recursive: true });
    const dotFile = join(dotDir, '.env-secret'); // inside the output-dir root, refused only for the dot
    writeFileSync(dotFile, 'SECRET=1');
    const a = await ctx.s.err('upload', { target: refOf(s, 'file', 'Upload file'), paths: [outside] });
    assert.match(a.text, /--allow-file-root/);
    const b = await ctx.s.err('upload', { target: refOf(s, 'file', 'Upload file'), paths: [dotFile] });
    assert.match(b.text, /--allow-hidden-files/);
    await sleep(500);
    assert.deepEqual(ctx.fx.submissions('direct'), []);
  });
});

describe('D9 dialogs', () => {
  test('D9 an alert is auto-accepted and reported', async () => {
    const s = await go('/dialogs.html');
    const r = await ctx.s.ok('click', { target: refOf(s, 'button', 'Alert') });
    assert.ok(parseEffects(r.text).some((e) => e.kind === 'dialog accepted' && e.type === 'alert' && e.message === 'Hello alert'), r.text);
    assert.deepEqual(await events(), ['after-alert']);
  });

  test('D9 confirm: pending within 2 s, other tools fail fast, another tab works, accept gives true', async () => {
    const s = await go('/dialogs.html');
    const tab = s.header.tab;
    const r = await ctx.s.ok('click', { target: refOf(s, 'button', 'Confirm') });
    assert.ok(r.ms <= 2000, `returned in ${r.ms} ms`);
    assert.ok(parseEffects(r.text).some((e) => e.kind === 'dialog pending' && e.type === 'confirm' && e.message === 'Proceed with the test?'), r.text);
    const listed = parseTabsList((await ctx.s.ok('tabs', { action: 'list' })).text).find((t) => t.id === tab);
    assert.equal(listed?.dialog, 'confirm');
    await ctx.s.ok('session', { action: 'status' });
    for (const [tool, args] of [['snapshot', {}], ['click', { target: refOf(s, 'button', 'Alert') }], ['evaluate', { script: '1' }]] as const) {
      const e = await ctx.s.err(tool, { ...args, tab });
      assert.ok(e.ms <= 1000, `${tool} failed in ${e.ms} ms`);
      assert.ok(e.text.includes('Proceed with the test?'), `${tool} error carries the dialog text`);
    }
    const other = tabIdOf((await ctx.s.ok('tabs', { action: 'new', url: ctx.fx.url('/nav-a.html'), background: true })).text)!;
    await ctx.s.ok('snapshot', { tab: other });
    await ctx.s.ok('tabs', { action: 'close', tab: other });
    await ctx.s.ok('dialog', { action: 'accept', tab });
    assert.equal(await ctx.s.state('window.__confirm', { tab }), true);
  });

  test('D9 dismiss gives false/null; a prompt answered with text gives the page that text', async () => {
    const s = await go('/dialogs.html');
    await ctx.s.ok('click', { target: refOf(s, 'button', 'Confirm') });
    await ctx.s.ok('dialog', { action: 'dismiss' });
    assert.equal(await ctx.s.state('window.__confirm'), false);
    await ctx.s.ok('click', { target: refOf(s, 'button', 'Prompt') });
    await ctx.s.ok('dialog', { action: 'accept', text: 'Zed' });
    assert.equal(await ctx.s.state('window.__prompt'), 'Zed');
    await ctx.s.ok('click', { target: refOf(s, 'button', 'Prompt') });
    await ctx.s.ok('dialog', { action: 'dismiss' });
    assert.equal(await ctx.s.state('window.__prompt'), null);
  });
});

describe('D10 navigate', () => {
  // PLAN contract answer 13 (main 5e0f9db): localhost / 127.0.0.1 / [::1] without a scheme get http://;
  // every other scheme-less host gets https://.
  test('D10 a scheme-less goto: local hosts get http://, other hosts https://', async () => {
    const hostPort = ctx.fx.originA.replace('http://', '');
    const r = await ctx.s.ok('navigate', { url: `${hostPort}/nav-a.html`, snapshot: false });
    assert.ok(r.text.includes(`http://${hostPort}/nav-a.html`), r.text);
    assert.equal(await ctx.s.state('location.protocol'), 'http:');
    const e = await ctx.s.call('navigate', { url: 'nonexistent.invalid/x', snapshot: false });
    assert.ok(e.text.includes('https://nonexistent.invalid/x'), e.text);
  });

  test('D10 back, forward and reload', async () => {
    await go('/nav-a.html');
    await go('/nav-b.html');
    await ctx.s.ok('navigate', { action: 'back' });
    assert.equal(await ctx.s.state('location.pathname'), '/nav-a.html');
    await ctx.s.ok('navigate', { action: 'forward' });
    assert.equal(await ctx.s.state('location.pathname'), '/nav-b.html');
    await ctx.s.ok('navigate', { action: 'reload' });
    assert.equal(await ctx.s.state('performance.getEntriesByType("navigation")[0].type'), 'reload');
  });

  test('D10 a 404 is reported with its status, not as an error', async () => {
    const r = await ctx.s.ok('navigate', { url: ctx.fx.url('/status/404') });
    assert.match(r.text, /^\[t\d+\] navigated \S+\/status\/404 "Status 404" \(404\)/m);
  });

  test('D10 http://nonexistent.invalid gives isError with net::ERR_NAME_NOT_RESOLVED', async () => {
    const r = await ctx.s.err('navigate', { url: 'http://nonexistent.invalid' });
    assert.match(r.text, /net::ERR_NAME_NOT_RESOLVED/);
  });

  test('D10 a slow page honours timeout_ms with a clear timeout error', async () => {
    const r = await ctx.s.err('navigate', { url: ctx.fx.url('/slow?ms=15000'), timeout_ms: 1500 });
    assert.match(r.text, /time(d)?[ -]?out/i);
    assert.ok(r.ms <= 3500);
  });

  test('D10 an SPA pushState is reported as → url', async () => {
    const s = await go('/spa.html');
    const r = await ctx.s.ok('click', { target: refOf(s, 'button', 'Go to section') });
    const fx = parseEffects(r.text);
    assert.ok(fx.some((e) => e.kind === 'url' && e.url === ctx.fx.url('/spa/section-2')), r.text);
    assert.ok(!fx.some((e) => e.kind === 'navigated'));
  });
});

describe('D11 wait', () => {
  async function started(): Promise<void> {
    const s = await go('/wait.html');
    await ctx.s.ok('click', { target: refOf(s, 'button', 'Start timers') });
  }
  const fired = () => ctx.s.state<boolean>('window.__firedAt !== undefined');

  test('D11 text appearing after 1 s', async () => {
    await started();
    await ctx.s.ok('wait', { text: 'Appeared later' });
    assert.equal(await fired(), true);
  });

  test('D11 text gone', async () => {
    await started();
    await ctx.s.ok('wait', { text_gone: 'Vanishing text' });
    assert.equal(await ctx.s.state('document.getElementById("vanishing")'), null);
  });

  test('D11 target hidden and target visible', async () => {
    await started();
    await ctx.s.ok('wait', { target: '#hide-later', state: 'hidden' });
    assert.equal(await fired(), true);
    await started();
    await ctx.s.ok('wait', { target: '#show-later', state: 'visible' });
    assert.equal(await fired(), true);
  });

  test('D11 url substring and /regex/', async () => {
    await started();
    await ctx.s.ok('wait', { url: 'step=2' });
    assert.equal(await ctx.s.state('location.search'), '?step=2');
    await started();
    await ctx.s.ok('wait', { url: '/step=\\d$/' });
    assert.equal(await fired(), true);
  });

  test('D11 load_state and ms', async () => {
    await ctx.s.ok('navigate', { url: ctx.fx.url('/wait-load.html'), wait_until: 'domcontentloaded', snapshot: false });
    await ctx.s.ok('wait', { load_state: 'load' });
    assert.ok((await ctx.s.state<number>('performance.getEntriesByType("navigation")[0].loadEventEnd')) > 0);
    const r = await ctx.s.ok('wait', { ms: 500 });
    assert.ok(r.ms >= 490);
  });

  test('D11 a timeout gives isError naming the condition', async () => {
    await go('/wait.html');
    const r = await ctx.s.err('wait', { text: 'Never appears', timeout_ms: 1000 });
    assert.ok(r.text.includes('Never appears'), r.text);
  });
});

describe('D12 evaluate', () => {
  test('D12 an expression, a function with a target, a JSON result, an exception, a truncated large result', async () => {
    const s = await go('/click.html');
    assert.match((await ctx.s.ok('evaluate', { script: '6 * 7' })).text, /\b42\b/);
    const t = await ctx.s.ok('evaluate', { script: '(el) => el.textContent + "!"', target: refOf(s, 'button', 'Plain') });
    assert.ok(t.text.includes('"Plain!"'), t.text);
    const j = await ctx.s.ok('evaluate', { script: '({ a: 1, b: [true, null, "x"] })' });
    const body = j.text.slice(j.text.indexOf('{'), j.text.lastIndexOf('}') + 1);
    assert.deepEqual(JSON.parse(body), { a: 1, b: [true, null, 'x'] });
    const e = await ctx.s.err('evaluate', { script: '(() => { throw new Error("boom-d12"); })()' });
    assert.ok(e.text.includes('boom-d12'));
    const big = await ctx.s.ok('evaluate', { script: '"x".repeat(200000)' });
    assert.ok(big.text.length <= 20_000, `truncated to the output cap: ${big.text.length}`);
    assert.ok(big.text.includes('x'.repeat(1000)));
  });

  test('D12 a DOM element in the result is rendered as its snapshot line', async () => {
    await go('/click.html');
    const r = await ctx.s.ok('evaluate', { script: 'document.getElementById("plain")' });
    const line = r.text.split('\n').map((l) => parseElementLine(l.trim().startsWith('- ') ? l.trim() : `- ${l.trim()}`).el).find(Boolean);
    assert.ok(line && line.role === 'button' && line.name === 'Plain', r.text);
  });
});

describe('D13 download', () => {
  test('D13 a download link saves under <output-dir>/downloads; path, size and bytes match', async () => {
    const s = await go('/downloads.html');
    const r = await ctx.s.ok('click', { target: refOf(s, 'link', 'Download report') });
    let dl = parseEffects(r.text).find((e) => e.kind === 'download');
    if (!dl) {
      // Late downloads are reported at the top of the next result for the tab.
      await sleep(1500);
      dl = parseEffects((await ctx.s.ok('snapshot', {})).text).find((e) => e.kind === 'download');
    }
    assert.ok(dl && dl.kind === 'download', `download effect:\n${r.text}`);
    assert.ok(realpathSync(dl.path).startsWith(realpathSync(join(ctx.s.outputDir, 'downloads')) + '/'), dl.path);
    assert.match(dl.size, /\d/);
    assert.ok(readFileSync(dl.path).equals(downloadBytes('report.txt')), 'bytes equal the served file');
  });
});

describe('D14 batch', () => {
  const steps = (third: Record<string, unknown>) => [
    { tool: 'navigate', args: { url: ctx.fx.url('/batch.html'), snapshot: false } },
    { tool: 'fill_form', args: { fields: [{ target: '#bname', value: 'Batchy' }] } },
    { tool: 'click', args: third },
    { tool: 'wait', args: { text: 'Batch done: Batchy', timeout_ms: 3000 } },
    { tool: 'snapshot', args: {} },
  ];
  const sections = (text: string) => {
    const out = new Map<number, string>();
    const parts = text.split(/^## step (\d+): (\w+)\b[^\n]*$/m);
    for (let i = 1; i < parts.length; i += 3) out.set(Number(parts[i]), `${parts[i + 1]}\n${parts[i + 2] ?? ''}`);
    return out;
  };

  test('D14 a 5-step batch (navigate, fill_form, click, wait, snapshot) runs in one call', async () => {
    ctx.fx.reset();
    const r = await ctx.s.ok('batch', { steps: steps({ target: 'role=button[name="Batch submit"]' }) });
    const sec = sections(r.text);
    assert.deepEqual([...sec.keys()], [1, 2, 3, 4, 5]);
    assert.deepEqual([...sec.values()].map((v) => v.split('\n')[0]), ['navigate', 'fill_form', 'click', 'wait', 'snapshot']);
    assert.match(sec.get(5)!, /^\[t\d+\] "Batch form" \S+ \(untrusted page content\)$/m);
    assert.deepEqual(ctx.fx.submissions('batch')[0]?.json, { name: 'Batchy' });
  });

  test('D14 when step 3 fails, steps 4 and 5 are reported as skipped', async () => {
    const r = await ctx.s.call('batch', { steps: steps({ target: '#does-not-exist', timeout_ms: 1000 }) });
    const sec = sections(r.text);
    for (const n of [4, 5]) {
      const header = new RegExp(`^## step ${n}: \\w+[^\\n]*skipped`, 'm').test(r.text);
      const listed = header || (sec.get(n) ?? '').includes('skipped') || new RegExp(`step ${n}\\b[^\\n]*skipped|skipped[^\\n]*\\b${n}\\b`).test(r.text);
      assert.ok(listed, `step ${n} skipped:\n${r.text}`);
    }
    assert.ok(!/\(untrusted page content\)/.test(sec.get(5) ?? ''), 'step 5 did not run');
  });

  test('D14 stop_on_error false continues past the failure', async () => {
    const r = await ctx.s.call('batch', { steps: steps({ target: '#does-not-exist', timeout_ms: 1000 }), stop_on_error: false });
    const sec = sections(r.text);
    assert.deepEqual([...sec.keys()], [1, 2, 3, 4, 5]);
    assert.ok(!(sec.get(4) ?? '').includes('skipped'));
    assert.match(sec.get(5)!, /\(untrusted page content\)/);
  });
});

describe('D15 console and network', () => {
  test('D15 console levels and the uncaught exception; network fetch; Authorization redacted; failed_only', async () => {
    await go(CONSOLE_PAGE.path);
    await ctx.s.ok('wait', { ms: 800 });
    const LINE = (lvl: string, msg: string) => new RegExp(`^\\[${lvl}\\] \\d{2}:\\d{2}:\\d{2}\\.\\d{3} .*${msg}.*\\(\\S+:\\d+\\)$`, 'm');
    const err = (await ctx.s.ok('console', { level: 'error' })).text;
    assert.match(err, LINE('error', CONSOLE_PAGE.error));
    assert.ok(err.includes(CONSOLE_PAGE.uncaught), 'uncaught exception captured');
    assert.ok(!err.includes(CONSOLE_PAGE.log), 'log is not an error');
    const warn = (await ctx.s.ok('console', { level: 'warning' })).text;
    assert.match(warn, LINE('warn(?:ing)?', CONSOLE_PAGE.warning));
    const all = (await ctx.s.ok('console', { level: 'all' })).text;
    for (const m of [CONSOLE_PAGE.log, CONSOLE_PAGE.warning, CONSOLE_PAGE.error]) assert.ok(all.includes(m), m);

    const net = (await ctx.s.ok('network', {})).text;
    const api = /^(r\d+) GET 200 fetch \S*\/api\/data \d+ms \S+/m.exec(net);
    assert.ok(api, `fetch line:\n${net}`);
    const detail = (await ctx.s.ok('network', { request_id: api[1] })).text;
    assert.match(detail, /authorization/i);
    assert.ok(!detail.includes('fixture-secret-token-5521'), 'Authorization value redacted');

    const failed = (await ctx.s.ok('network', { failed_only: true })).text;
    assert.match(failed, /^r\d+ GET 500 \S+ \S*\/fail\/500 /m);
    assert.match(failed, /^r\d+ GET failed:\S+ \S+ \S*\/hang /m);
    assert.ok(!failed.includes('/api/data'));
  });
});
