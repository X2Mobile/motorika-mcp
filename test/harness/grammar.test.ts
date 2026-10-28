// Harness: the grammar parser accepts PLAN.md's own sample and rejects contract violations.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  descendants,
  parseEffects,
  parseElementLine,
  parseFindHits,
  parseFrameLabels,
  parseSnapshot,
  parseTabsList,
  refOf,
} from '../support/grammar.ts';

// Verbatim from PLAN.md "Snapshot grammar".
const PLAN_SAMPLE = `[t1] "Sign in – Example" https://example.com/login (untrusted page content)
- banner e1
  - link "Example" e2 href="/"
  - navigation "Main" e3
    - link "Pricing" e4 href="/pricing"
- main e5
  - heading "Sign in" e6 level=1
  - form "Login" e7
    - textbox "Email" e8 type=email required value="ann@example.com"
    - textbox "Password" e9 password value=<redacted>
    - checkbox "Remember me" e10 checked=false
    - combobox "Country" e11 value="Romania" options=["Austria","Belgium","…+240"]
    - button "Sign in" e12 disabled
  - alert "Wrong password" e13
  - iframe "Payment" e14 frame=f2
    - textbox "Card number" e15
… 120 more lines (offset=40 to continue; or narrow with scope, find or viewport_only)`;

describe('snapshot grammar', () => {
  test('the PLAN sample parses completely', () => {
    const s = parseSnapshot(PLAN_SAMPLE);
    assert.deepEqual(s.errors, []);
    assert.deepEqual(s.header, { tab: 't1', title: 'Sign in – Example', url: 'https://example.com/login' });
    assert.equal(s.elements.length, 15);
    assert.deepEqual(s.footer, { more: 120, offset: 40 });
    assert.equal(refOf(s, 'textbox', 'Email'), 'e8');
    const email = s.elements.find((e) => e.ref === 'e8')!;
    assert.deepEqual(email.attrs, { type: 'email', required: true, value: 'ann@example.com' });
    assert.equal(s.elements.find((e) => e.ref === 'e9')!.attrs.value, '<redacted>');
    assert.deepEqual(s.elements.find((e) => e.ref === 'e11')!.attrs.options, ['Austria', 'Belgium', '…+240']);
    const iframe = s.elements.find((e) => e.ref === 'e14')!;
    assert.equal(iframe.attrs.frame, 'f2');
    assert.deepEqual(descendants(s, iframe).map((l) => (l.kind === 'element' ? l.ref : '')), ['e15']);
    assert.equal(s.elements.find((e) => e.ref === 'e5')!.name, null);
  });

  test('the viewport footer of the attached snapshot parses (PLAN "Decisions from the bench")', () => {
    const head = '[t1] "T" https://x/ (untrusted page content)\n- button "a" e1\n';
    const off = parseSnapshot(`${head}… viewport only: 12 more off-screen (find or read for text; snapshot for the whole page)`);
    assert.deepEqual(off.errors, []);
    assert.deepEqual(off.footer, { viewport: true, offscreen: 12, more: 0, offset: null });
    const cut = parseSnapshot(
      `${head}… viewport only: 3 more off-screen, 40 more lines (find or read for text; snapshot for the whole page; offset=1 with viewport_only to continue)`,
    );
    assert.deepEqual(cut.errors, []);
    assert.deepEqual(cut.footer, { viewport: true, offscreen: 3, more: 40, offset: 1 });
    const half = parseSnapshot(`${head}… viewport only: 3 more off-screen, 40 more lines (find or read for text; snapshot for the whole page)`);
    assert.equal(half.errors.length, 1);
    const empty = parseSnapshot(`${head}… viewport only: 0 more off-screen (find or read for text; snapshot for the whole page)`);
    assert.equal(empty.errors.length, 1);
  });

  test('rejects out-of-order attributes, unknown roles, odd indents, duplicate refs, missing header', () => {
    assert.match(parseElementLine('- textbox "x" e1 required type=email').error ?? '', /out of order/);
    assert.match(parseElementLine('- widget "x" e1').error ?? '', /vocabulary/);
    assert.match(parseElementLine('   - button "x" e1').error ?? '', /multiple of 2/);
    assert.match(parseElementLine('- button "x" e1 bogus').error ?? '', /unknown attribute/);
    assert.match(parseElementLine('- button "" e1').error ?? '', /empty name/);
    assert.match(parseElementLine('- button "x"').error ?? '', /not an element line/);
    const dup = parseSnapshot('[t1] "T" https://x/ (untrusted page content)\n- button "a" e1\n- button "b" e1');
    assert.deepEqual(dup.errors, ['duplicate ref e1']);
    const junk = parseSnapshot('[t1] "T" https://x/ (untrusted page content)\n- button "a" e1\nsome prose');
    assert.equal(junk.errors.length, 1);
    assert.throws(() => parseSnapshot('- button "a" e1'), /no snapshot header/);
  });

  test('text lines carry no ref', () => {
    const s = parseSnapshot('[t2] "T" http://x/ (untrusted page content)\n- main e1\n  - text "hello \\"world\\""');
    assert.deepEqual(s.errors, []);
    assert.equal(s.lines[1]!.kind, 'text');
    assert.equal(s.lines[1]!.kind === 'text' && s.lines[1]!.text, 'hello "world"');
  });

  test('effect lines parse into their fixed forms', () => {
    const text = [
      '[t1] clicked e12 button "Sign in"',
      '→ navigated https://app.example.com/home "Home" (200)',
      '→ url https://app.example.com/home#x',
      '→ new tab t3 https://docs.example.com/',
      '→ tab closed t2',
      '→ dialog pending confirm "Leave page?" (use dialog accept|dismiss)',
      '→ dialog accepted alert "Hello"',
      '→ download /Users/x/.motorika/output/downloads/report.pdf (52.1 KB)',
      '→ alert "Invalid password"',
      '→ console 2 new errors: TypeError: x is undefined',
    ].join('\n');
    const e = parseEffects(text);
    assert.deepEqual(e.map((x) => x.kind), ['navigated', 'url', 'new tab', 'tab closed', 'dialog pending', 'dialog accepted', 'download', 'alert', 'console']);
    assert.deepEqual(e[0], { kind: 'navigated', url: 'https://app.example.com/home', title: 'Home', status: '200' });
    assert.deepEqual(e[2], { kind: 'new tab', tab: 't3', url: 'https://docs.example.com/' });
    assert.deepEqual(e[4], { kind: 'dialog pending', type: 'confirm', message: 'Leave page?' });
    assert.equal(parseEffects('→ something else')[0]!.kind, 'unknown');
  });

  test('tabs list, find hits, frame labels', () => {
    const tabs = parseTabsList('t1 "A" http://a/ (active)\nt2 "B \\"q\\"" http://b/ dialog=confirm\nnoise');
    assert.equal(parseTabsList('t4 "C" http://c/ crashed')[0]!.crashed, true);
    assert.equal(parseTabsList('t5 "D" http://d/ (active)')[0]!.crashed, false);
    assert.deepEqual(tabs.map((t) => [t.id, t.title, t.active, t.dialog]), [['t1', 'A', true, null], ['t2', 'B "q"', false, 'confirm']]);
    const hits = parseFindHits('- button "Save" e4  in - heading "Doc" e2 level=1\n- button "Save draft" e9\n  in - iframe "F" e8 frame=f2');
    assert.deepEqual(hits.map((h) => [h.el.ref, h.el.name, h.context !== null]), [['e4', 'Save', true], ['e9', 'Save draft', true]]);
    const frames = parseFrameLabels('frame 1/3 @ 00:00.50\n<img>\nframe 2/3 @ 00:02.50\nframe 3/3 @ 01:04.25');
    assert.deepEqual(frames.map((f) => f.seconds), [0.5, 2.5, 64.25]);
  });
});
