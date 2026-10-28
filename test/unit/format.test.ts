import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ARROW, capText, cutLine, effect, elementLine, formatBytes, pageChars, pageLines, readFooter, redactBody, redactHeaders, snapshotFooter, snapshotHeader, textLine,
} from '../../src/util/format.js';
import { pageCount } from '../../src/page/snapshot.js';
import { parseSnapshot } from '../support/grammar.ts';

// The grammar from PLAN "Snapshot grammar", as a parser independent of the formatter.
const ELEMENT = /^( *)- ([a-z]+)(?: ("(?:[^"\\]|\\.)*"))? e(\d+)((?: [^ ].*)?)$/;
const ATTR_ORDER = ['level', 'type', 'password', 'checked', 'selected', 'pressed', 'expanded', 'disabled', 'readonly', 'required', 'invalid', 'focused', 'value', 'options', 'href', 'frame'];

function attrNames(rest: string): string[] {
  const names: string[] = [];
  const re = / ([a-z]+)(?:=("(?:[^"\\]|\\.)*"|\[.*?\](?= |$)|<redacted>|[^ ]+))?/g;
  for (let m = re.exec(rest); m; m = re.exec(rest)) names.push(m[1] ?? '');
  return names;
}

describe('snapshot lines (PLAN grammar)', () => {
  it('element line: indent, role, JSON name, ref, attributes', () => {
    const l = elementLine(2, 'textbox', 'Email', 8, { type: 'email', required: true, value: 'ann@example.com' }, 'https://example.com/login');
    assert.equal(l, '    - textbox "Email" e8 type=email required value="ann@example.com"');
    assert.match(l, ELEMENT);
  });
  it('name omitted when empty', () => {
    assert.equal(elementLine(0, 'main', '', 5, undefined, 'https://e.com/'), '- main e5');
  });
  it('attributes follow the fixed order', () => {
    const l = elementLine(
      0,
      'combobox',
      'X',
      1,
      { href: 'https://e.com/a', options: ['a'], value: 'v', focused: true, invalid: true, required: true, readonly: true, disabled: true, expanded: false, pressed: 'mixed', selected: true, checked: 'true', password: false, type: 'email', level: 2 },
      'https://e.com/',
      'f2',
    );
    const m = ELEMENT.exec(l);
    assert.ok(m, l);
    const names = attrNames(m[5] ?? '');
    const idx = names.map((n) => ATTR_ORDER.indexOf(n));
    assert.deepEqual([...idx].sort((a, b) => a - b), idx, `order: ${names.join(',')}`);
    assert.ok(names.includes('frame'));
  });
  it('type is omitted for text and password inputs', () => {
    assert.doesNotMatch(elementLine(0, 'textbox', 'a', 1, { type: 'text' }, 'x:'), /type=/);
    assert.doesNotMatch(elementLine(0, 'textbox', 'a', 1, { type: 'password', password: true, valueRedacted: true }, 'x:'), /type=/);
  });
  it('password: value=<redacted> only when non-empty, never the literal', () => {
    const filled = elementLine(0, 'textbox', 'Password', 9, { password: true, valueRedacted: true, value: 'hunter2' }, 'x:');
    assert.equal(filled, '- textbox "Password" e9 password value=<redacted>');
    const empty = elementLine(0, 'textbox', 'Password', 9, { password: true }, 'x:');
    assert.equal(empty, '- textbox "Password" e9 password');
  });
  it('name and value truncated at 100 chars with …', () => {
    const long = 'n'.repeat(150);
    const l = elementLine(0, 'button', long, 3, { value: long }, 'x:');
    const name = JSON.parse(ELEMENT.exec(l)?.[3] ?? '""') as string;
    assert.ok(name.length <= 100 && name.endsWith('…'));
    const v = /value=("(?:[^"\\]|\\.)*")/.exec(l)?.[1] ?? '""';
    assert.ok((JSON.parse(v) as string).length <= 100);
  });
  it('options: at most 10 labels, then "…+N"', () => {
    const opts = Array.from({ length: 250 }, (_, i) => `o${i}`);
    const l = elementLine(0, 'combobox', 'Country', 11, { value: 'o0', options: opts.slice(0, 10), optionsTotal: 250 }, 'x:');
    const arr = JSON.parse(/options=(\[.*\])/.exec(l)?.[1] ?? '[]') as string[];
    assert.equal(arr.length, 11);
    assert.equal(arr[10], '…+240');
  });
  it('href: same-origin shown as path, cross-origin as URL', () => {
    assert.match(elementLine(0, 'link', 'P', 4, { href: 'https://example.com/pricing?x=1#a' }, 'https://example.com/login'), /href="\/pricing\?x=1#a"$/);
    assert.match(elementLine(0, 'link', 'D', 4, { href: 'https://docs.example.com/' }, 'https://example.com/login'), /href="https:\/\/docs\.example\.com\/"$/);
  });
  it('text lines have no ref and are at most 200 chars', () => {
    const t = textLine(1, 'x'.repeat(500));
    assert.match(t, /^ {2}- text "x+…"$/);
    assert.doesNotMatch(t, / e\d+/);
    assert.ok((JSON.parse(t.slice(t.indexOf('"'))) as string).length <= 200);
  });
  it('header line', () => {
    assert.equal(snapshotHeader('t1', 'Sign in – Example', 'https://example.com/login'), '[t1] "Sign in – Example" https://example.com/login (untrusted page content)');
  });
});

describe('snapshot paging (PLAN: cut at a line boundary, footer, no gaps, no overlaps)', () => {
  const header = '[t1] "T" https://e.com/ (untrusted page content)';
  const mk = (n: number, seed: number) => Array.from({ length: n }, (_, i) => `${'  '.repeat(i % 4)}- button "b${i}-${'z'.repeat((i * seed) % 37)}" e${i + 1}`);
  const FOOTER = /^… (\d+) more lines \(offset=(\d+) to continue; or narrow with scope, find or viewport_only\)$/;

  for (const [n, max, seed] of [[5000, 20000, 7], [300, 1000, 3], [40, 500, 11], [10, 100000, 1]] as const) {
    it(`${n} lines at max_chars ${max}: pages concatenate to the original`, () => {
      const lines = mk(n, seed);
      const seen: string[] = [];
      let offset = 0;
      for (let guard = 0; guard < 10000; guard++) {
        const p = pageLines(header, lines, offset, max);
        const out = p.text.split('\n');
        assert.equal(out[0], header, 'header on every page');
        assert.ok(p.text.length <= max, `page within max_chars (${p.text.length} > ${max})`);
        const last = out[out.length - 1] ?? '';
        const f = FOOTER.exec(last);
        const body = f ? out.slice(1, -1) : out.slice(1);
        seen.push(...body);
        if (!f) break;
        assert.equal(Number(f[1]), n - (offset + body.length), 'footer counts the remaining lines');
        assert.equal(Number(f[2]), offset + body.length, 'footer offset continues exactly after the page');
        offset = Number(f[2]);
      }
      assert.deepEqual(seen, lines);
    });
  }
  it('a single line longer than max_chars is cut to fit and stays in the grammar (review SEC-3)', () => {
    const long = `- link "Long" e7 href=${JSON.stringify(`/x?q=${'a'.repeat(12000)}`)}`;
    const p = pageLines(header, [long, '- button "After" e8'], 0, 6000);
    assert.ok(p.text.length <= 6000, `${p.text.length} chars`);
    assert.ok(p.end >= 1, 'the cut line counts as shown: the page makes progress');
    const line = p.text.split('\n')[1]!;
    assert.ok(line.endsWith('…"'), line.slice(-20));
    assert.equal(parseSnapshot(p.text).errors.length, 0);
    // An escape is never split, and a cut outside a string drops whole tokens.
    assert.ok(!cutLine(`- link "L" e1 href="${'\\n'.repeat(50)}"`, 40).match(/\\…/));
    assert.equal(cutLine('- button "B" e1 disabled required', 30), '- button "B" e1 disabled');
  });
  it('page-reported counts: only finite non-negative integers (review SEC-2)', () => {
    for (const bad of [Number.NaN, -1, 2.5, 'abc', '3', null, undefined, Infinity, 2 ** 60]) assert.equal(pageCount(bad), 0, String(bad));
    assert.equal(pageCount(0), 0);
    assert.equal(pageCount(42), 42);
  });
  it('an offset past the end returns the header only', () => {
    assert.equal(pageLines(header, mk(3, 1), 10, 1000).text, header);
  });
  it('footer text form', () => {
    assert.equal(snapshotFooter(120, 40), '… 120 more lines (offset=40 to continue; or narrow with scope, find or viewport_only)');
  });
  it('read paging by characters has no gaps or overlaps', () => {
    const body = Array.from({ length: 400 }, (_, i) => `para ${i} ${'w'.repeat(i % 50)}`).join('\n');
    let offset = 0;
    let acc = '';
    for (let g = 0; g < 1000; g++) {
      const p = pageChars(body, offset, 700);
      assert.ok(p.text.length <= 700);
      acc += p.text;
      if (p.next === undefined) break;
      offset = p.next;
    }
    assert.equal(acc, body);
  });
  it('read pages requested at offset 0, k, 2k, ... reproduce the content exactly (contract answer 9)', () => {
    const body = Array.from({ length: 300 }, (_, i) => `PARA-${i} ${'w'.repeat(i % 70)}`).join('\n\n');
    for (const k of [1, 97, 3000]) {
      let acc = '';
      for (let off = 0; off < body.length; off += k) {
        const p = pageChars(body, off, k);
        assert.ok(p.text.length <= k);
        if (off + k < body.length) assert.equal(p.next, off + k, 'the footer offset is exactly where the next page starts');
        else assert.equal(p.next, undefined);
        acc += p.text;
      }
      assert.equal(acc, body, `stride ${k}: no gaps, no overlaps`);
    }
  });
  it('read footer form', () => {
    assert.equal(readFooter(4500, 3000), '… 4500 more chars (offset=3000 to continue)');
  });
  it('capText: --max-output-chars is a hard ceiling on the whole text, note included', () => {
    for (const [len, max] of [[30000, 20000], [200000, 20000], [20001, 20000], [10, 5], [999_999, 1000]] as const) {
      const src = 'x'.repeat(len);
      const s = capText(src, max);
      assert.ok(s.length <= max, `${len} -> ${s.length} > ${max}`);
      const m = /\n… truncated (\d+) chars$/.exec(s);
      if (max > 40) {
        assert.ok(m, s.slice(-60));
        assert.equal(s.length - m[0].length + Number(m[1]), len, 'the note counts exactly the cut chars');
      }
    }
    assert.equal(capText('short', 20000), 'short');
  });
});

describe('effect lines (PLAN fixed forms, U+2192 + space)', () => {
  it('arrow is U+2192 followed by a space', () => assert.equal(ARROW, '→ '));
  it('forms', () => {
    assert.equal(effect.navigated('https://app.example.com/home', 'Home', 200), '→ navigated https://app.example.com/home "Home" (200)');
    assert.equal(effect.url('https://e.com/#x'), '→ url https://e.com/#x');
    assert.equal(effect.newTab('t3', 'https://docs.example.com/'), '→ new tab t3 https://docs.example.com/');
    assert.equal(effect.tabClosed('t2'), '→ tab closed t2');
    assert.equal(effect.dialogPending('confirm', 'Leave page?'), '→ dialog pending confirm "Leave page?" (use dialog accept|dismiss)');
    assert.equal(effect.dialogAccepted('alert', 'hi'), '→ dialog accepted alert "hi"');
    assert.equal(effect.download('/Users/x/.motorika/output/downloads/report.pdf', 53350), '→ download /Users/x/.motorika/output/downloads/report.pdf (52.1 KB)');
    assert.equal(effect.alert('Invalid password'), '→ alert "Invalid password"');
    // Round 7: the page's error text is JSON-quoted.
    assert.equal(effect.console(2, 'TypeError: x is undefined'), '→ console 2 new errors: "TypeError: x is undefined"');
    assert.equal(effect.console(1, 'boom'), '→ console 1 new error: "boom"');
  });
  it('sizes', () => {
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(53350), '52.1 KB');
    assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
  });
});

describe('body redaction (C7: no password literal in any output)', () => {
  it('urlencoded', () => {
    const r = redactBody('name=Ann&password=hunter2&pw2=x&user_pwd=y', 'application/x-www-form-urlencoded');
    assert.equal(r, 'name=Ann&password=<redacted>&pw2=x&user_pwd=<redacted>');
  });
  it('multipart', () => {
    const b = '--B\r\nContent-Disposition: form-data; name="name"\r\n\r\nAnn\r\n--B\r\nContent-Disposition: form-data; name="pass"\r\n\r\nhunter2\r\n--B--\r\n';
    const r = redactBody(b, 'multipart/form-data; boundary=B');
    assert.ok(!r.includes('hunter2'));
    assert.ok(r.includes('Ann'));
  });
  it('json', () => {
    const r = redactBody('{"user":"ann","password":"hunter2","token":123,"nested":{"apiKey":"k"}}', 'application/json');
    assert.ok(!r.includes('hunter2') && !r.includes('123') && !r.includes('"k"'));
    assert.ok(r.includes('"user":"ann"'));
  });
  it('other content is unchanged', () => {
    assert.equal(redactBody('<p>password: shown in prose</p>', 'text/html'), '<p>password: shown in prose</p>');
  });
});

describe('header redaction (PLAN network)', () => {
  it('redacts the six credential headers, case-insensitively, and keeps the rest', () => {
    const h = redactHeaders({
      Authorization: 'Bearer abc',
      'proxy-authorization': 'Basic x',
      Cookie: 'sid=1',
      'set-cookie': 'sid=2',
      'X-API-Key': 'k',
      'x-auth-token': 't',
      'content-type': 'application/json',
    });
    for (const k of ['Authorization', 'proxy-authorization', 'Cookie', 'set-cookie', 'X-API-Key', 'x-auth-token']) assert.equal(h[k], '<redacted>');
    assert.equal(h['content-type'], 'application/json');
    assert.ok(!JSON.stringify(h).includes('abc'));
  });
});
