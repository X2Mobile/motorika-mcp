// Fix round 7b, C1 (critical, security): `safeUrl` percent-encoded before it redacted, so a remembered secret
// next to a character it encodes (`'`, `\`, `"`, a space, a control) got a hex digit glued to it and the
// whole-token rule refused it (`#%27Hunter2xZ%27`). Chrome's own escapes (`%60`, `%3C`) did the same on
// every build. Source: docs/reviews/recheck-r7.md and the reviewer's ~/x2b-r7rc-sec/sec-unit*.mjs.
//
// Oracle (from the review and the AC, never from this code's output):
//   - the review's leak test: the secret is in neither the output nor its percent-decoding;
//   - expected strings built here from the AC: the neighbours stay as they were (a raw unsafe character
//     percent-encoded, an escape kept), the secret becomes `<redacted>`, readable and unencoded;
//   - the output is one token, and no `%` or `%X` is glued to a marker (an escape is never split).
// The scenario table is every character round 7 encodes, plus backtick, `<`, `>` and a literal `%`, next to
// the secret (before, after, both) and inside it, in the query, fragment, path and userinfo, raw or
// pre-encoded (upper- and lower-case hex).
// Red-first: MOTORIKA_TEST_SRC=<old checkout>/src runs the same tests against another source tree.
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

const SRC = process.env.MOTORIKA_TEST_SRC ?? new URL('../../src', import.meta.url).pathname;
const S = (await import(`${SRC}/util/secrets.ts`)) as typeof import('../../src/util/secrets.ts');
const F = (await import(`${SRC}/util/format.ts`)) as typeof import('../../src/util/format.ts');

const R = '<redacted>';
const cp = (n: number): string => String.fromCodePoint(n);
const range = (a: number, b: number): number[] => Array.from({ length: b - a }, (_, i) => a + i);
const show = (c: string): string => `U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`;

/**
 * What a printed URL never carries raw (PLAN round 7, item 7): whitespace (every Unicode space and line
 * separator), quotes, angle brackets, backslash, backtick and the C0/DEL/C1 controls. Code points, written out.
 */
const ENCODED = [
  ...range(0x00, 0x21), // C0 and the space
  0x22, 0x27, 0x3c, 0x3e, 0x5c, 0x60, // " ' < > \ `
  ...range(0x7f, 0xa1), // DEL, C1, NBSP
  0x1680, ...range(0x2000, 0x200b), 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff, // the other Unicode spaces
].map(cp);
/** AC1: every one of those, plus backtick, `<`, `>` (in the list already) and a literal `%`. */
const NEIGHBOURS = [...ENCODED, '%'];

/** A character percent-encoded (its UTF-8 bytes), upper-case hex as Chrome writes it. */
const pctU = (c: string): string => [...Buffer.from(c, 'utf8')].map((b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join('');
const pctL = (c: string): string => pctU(c).toLowerCase();
/** How the AC says a raw neighbour prints: an encoded character percent-encoded, a literal `%` as is. */
const printed = (c: string): string => (ENCODED.includes(c) ? pctU(c) : c);

/** Lenient percent-decoding (decodeURIComponent throws on a stray `%`): valid %XX runs as UTF-8. */
function decode(s: string, plusIsSpace = false): string {
  const t = plusIsSpace ? s.replace(/\+/g, ' ') : s;
  return t.replace(/(?:%[0-9a-fA-F]{2})+/g, (m) => Buffer.from(m.slice(1).split('%').map((h) => parseInt(h, 16))).toString('utf8'));
}

/** The review's oracle (sec-unit.mjs): the secret, or a spelling that decodes to it, survives. */
function leaks(out: string, secret: string): boolean {
  const bare = out.split(R).join('');
  return out.includes(secret) || decode(bare).includes(secret) || decode(bare, true).includes(secret);
}

/** A `%` that does not head a complete `%XX` escape. */
const STRAY_PCT = /%(?![0-9a-fA-F]{2})/;
/**
 * AC2: one token, and `<` and `>` only in markers. When every `%` of the input heads an escape, every `%` of
 * the output must too: a redaction that split an escape leaves `%<redacted>` or `%4<redacted>`. (A literal
 * `%` in the input prints as itself, so then the exact expected string is the check.)
 */
function tokenProblems(out: string, input: string): string[] {
  const p: string[] = [];
  const bare = out.split(R).join('');
  if (/[\s"'<>\\`\u0000-\u001f\u007f-\u009f]/.test(bare)) p.push('a raw character the URL must not carry');
  if (!STRAY_PCT.test(input) && STRAY_PCT.test(out)) p.push('an escape split by the marker');
  return p;
}

const SECRET = 'Hunter2xZ'; // no hex digit at either end, not a grammar word
/** URL parts around `<left><secret><right>`; each part is followed by more URL. */
const POSITIONS: Record<string, [string, string]> = {
  query: ['http://h.test/p?a=1&q=', '&n=1#f'],
  fragment: ['http://h.test/p?a=1#', '/end'],
  path: ['http://h.test/a/', '/b?q=1'],
  userinfo: ['http://user:', '@h.test/p'],
};
const SOURCES: Record<string, (c: string) => string> = {
  raw: (c) => c, // Chrome kept it raw; round 7's encoder made the escape
  'pre-encoded': pctU, // Chrome's URL already carried the escape
  'pre-encoded, lower-case hex': pctL,
};
const SIDES = ['before', 'after', 'both'] as const;

beforeEach(() => S.resetSecretsForTest());

describe('C1: a remembered secret next to any percent-escape is redacted (scenario table)', () => {
  for (const [source, spell] of Object.entries(SOURCES)) {
    for (const [pos, [pre, post]] of Object.entries(POSITIONS)) {
      test(`${source} neighbours in the ${pos}: ${NEIGHBOURS.length} characters x before/after/both`, () => {
        S.rememberSecret(SECRET);
        const bad: string[] = [];
        for (const c of NEIGHBOURS) {
          for (const side of SIDES) {
            const l = side === 'after' ? '' : c;
            const r = side === 'before' ? '' : c;
            const url = `${pre}${spell(l)}${SECRET}${spell(r)}${post}`;
            const out = S.safeUrl(url);
            const want = `${pre}${source === 'raw' ? printed(l) : spell(l)}${R}${source === 'raw' ? printed(r) : spell(r)}${post}`;
            const why = [...(leaks(out, SECRET) ? ['LEAK'] : []), ...(out !== want ? [`want ${JSON.stringify(want)}`] : []), ...tokenProblems(out, url)];
            if (why.length > 0) bad.push(`${show(c)} ${side}: ${JSON.stringify(out)} (${why.join('; ')})`);
          }
        }
        assert.deepEqual(bad, [], `${bad.length} of ${NEIGHBOURS.length * SIDES.length} rows:\n${bad.slice(0, 40).join('\n')}`);
      });
    }
  }
});

describe('C1: a secret that contains such a character, in any spelling Chrome or a page gives it', () => {
  for (const [source, spell] of Object.entries(SOURCES)) {
    for (const [pos, [pre, post]] of Object.entries(POSITIONS)) {
      test(`${source} inside the secret, in the ${pos}`, () => {
        const bad: string[] = [];
        for (const c of NEIGHBOURS) {
          S.resetSecretsForTest();
          const secret = `Hu${c}nter2xZ`;
          S.rememberSecret(secret);
          const url = `${pre}Hu${spell(c)}nter2xZ${post}`;
          const out = S.safeUrl(url);
          const want = `${pre}${R}${post}`;
          const why = [...(leaks(out, secret) ? ['LEAK'] : []), ...(out !== want ? [`want ${JSON.stringify(want)}`] : []), ...tokenProblems(out, url)];
          if (why.length > 0) bad.push(`${show(c)}: ${JSON.stringify(out)} (${why.join('; ')})`);
        }
        assert.deepEqual(bad, [], `${bad.length} of ${NEIGHBOURS.length} rows:\n${bad.slice(0, 40).join('\n')}`);
      });
    }
  }
});

describe('C1: named rows (the review, Chrome 155 as measured, escapes that must not split)', () => {
  const rows: [label: string, secret: string, url: string, want: string][] = [
    // ~/x2b-r7rc-sec/sec-unit.mjs and sec-unit2.mjs, the URLs as Chrome reported them
    ["sec-unit: ' raw in a fragment", 'Hunter2x', "http://h/p#'Hunter2x'", `http://h/p#%27${R}%27`],
    ['sec-unit: backtick raw in a query', 'Hunter2x', 'http://h/p?q=`Hunter2x`', `http://h/p?q=%60${R}%60`],
    ['sec-unit: backslash raw in a query', 'Hunter2x', 'http://h/p?q=\\Hunter2x\\', `http://h/p?q=%5C${R}%5C`],
    ['sec-unit: data: body raw', 'Hunter2x', 'data:text/html,<b>Hunter2x</b>', `data:text/html,%3Cb%3E${R}%3C/b%3E`],
    ['sec-unit: spaces around', 'Hunter2x', 'data:text/html,a Hunter2x b', `data:text/html,a%20${R}%20b`],
    ['sec-unit: quotes around', 'Hunter2x', 'data:text/html,"Hunter2x"', `data:text/html,%22${R}%22`],
    ["sec-unit: a secret holding ' and !", "O'Brien!26", "http://h/p#O'Brien!26", `http://h/p#${R}`],
    ['sec-unit: a secret holding @ and a space', 'p@ss word', 'data:text/html,p@ss word', `data:text/html,${R}`],
    ['sec-unit: a secret holding a space, tags around', 'Hunter 2x', 'data:text/html,<b>Hunter 2x</b>', `data:text/html,%3Cb%3E${R}%3C/b%3E`],
    ['sec-unit: Chrome-encoded quotes (leaked on every build)', 'Hunter2x', 'http://h/p?q=%22Hunter2x%22', `http://h/p?q=%22${R}%22`],
    ['sec-unit2: userinfo', 'Hunter2xZ', 'http://Hunter2xZ:x@h/', `http://${R}:x@h/`],
    ['sec-unit2: form + for a space', 'Hunter 2xZ', 'http://h/?q=Hunter+2xZ', `http://h/?q=${R}`],
    ['sec-unit2: raw spaces around a spaced secret', 'Hunter 2xZ', 'http://h/?q=a Hunter 2xZ b', `http://h/?q=a%20${R}%20b`],
    ['sec-unit2: double-quote adjacency', 'Hunter2xZ', 'http://h/?q="Hunter2xZ"', `http://h/?q=%22${R}%22`],
    ['secret-e2e: <b> in a fragment, Chrome-encoded', 'Hunter2xZ', 'http://h/login#%3Cb%3EHunter2xZ%3C/b%3E', `http://h/login#%3Cb%3E${R}%3C/b%3E`],
    // Chrome 155 (measured): a query encodes ' and keeps !, a fragment encodes a space and keeps @
    ["Chrome query spelling of O'Brien!26", "O'Brien!26", 'http://h/p?q=O%27Brien!26', `http://h/p?q=${R}`],
    ['Chrome fragment spelling of p@ss word', 'p@ss word', 'http://h/p#p@ss%20word', `http://h/p#${R}`],
    ["Chrome userinfo spelling of us'er", "us'erHunter", 'http://us%27erHunter:x@h/', `http://${R}:x@h/`],
    ['a mixed spelling', 'Hunter2xZ', 'http://h/p?q=%48unter2xZ', `http://h/p?q=${R}`],
    // never split an escape: a match inside one takes the whole escape (sec-unit2 "split-escape")
    ["split-escape: '27Hunter2xZ raw", '27Hunter2xZ', "http://h/p#'27Hunter2xZ", `http://h/p#%27${R}`],
    ['split-escape: %2727Hunter2xZ', '27Hunter2xZ', 'http://h/p#%2727Hunter2xZ', `http://h/p#%27${R}`],
    ['a secret that starts inside an escape takes the escape', '7Hunter2xZ', 'http://h/p#%27Hunter2xZ', `http://h/p#${R}`],
    ['a secret that ends inside an escape takes the escape', 'Hunter2x%', 'http://h/p?q=Hunter2x%41', `http://h/p?q=${R}`],
    ['a hex-led secret after a literal %', 'aBcDef12', 'http://h/p#%aBcDef12', `http://h/p#${R}`],
    // the whole-token rule still holds against raw letters and digits
    ['a raw letter before: left alone', 'Hunter2xZ', 'http://h/p?q=xHunter2xZ', 'http://h/p?q=xHunter2xZ'],
    ['a raw digit after: left alone', 'Hunter2xZ', 'http://h/p?q=Hunter2xZ9', 'http://h/p?q=Hunter2xZ9'],
    // a `<redacted>` in a printed URL is always ours: the page's own text is encoded
    ['a page-planted <redacted> is encoded', 'Hunter2xZ', 'data:text/html,<redacted> Hunter2xZ', `data:text/html,%3Credacted%3E%20${R}`],
  ];
  for (const [label, secret, url, want] of rows) {
    test(label, () => {
      S.rememberSecret(secret);
      const out = S.safeUrl(url);
      assert.equal(out, want);
      if (want.includes(R)) assert.equal(leaks(out, secret), false, out);
      assert.deepEqual(tokenProblems(out, url), [], out);
    });
  }

  test('a href= in a snapshot line follows the printed-URL rules (it was scrubbed by the text rule only)', () => {
    S.rememberSecret(SECRET);
    const attrs = F.formatAttrs({ href: `/p?q=%27${SECRET}%27#%60${SECRET}%60` }, 'http://h.test/x');
    assert.equal(attrs, ` href="/p?q=%27${R}%27#%60${R}%60"`);
  });

  test('a lone surrogate in a secret builds and matches', () => {
    const lone = `${cp(0xd800)}Hunter`;
    S.rememberSecret(lone);
    assert.equal(S.safeUrl(`data:text/html,a ${lone} b`), `data:text/html,a%20${R}%20b`);
  });
});

describe('C1 AC3: secret-named parameters are redacted as before', () => {
  /** Round 7's safeUrl with no remembered secret: encode first, then the parameter rule. */
  const UNSAFE = /[\s"'<>\\`\u0000-\u001f\u007f-\u009f]/g;
  const round7 = (u: string): string => S.redactUrlParams(u.replace(UNSAFE, pctU));
  const urls = [
    'https://x.test/?accessToken=a&apiKey=b&APIKey=c&clientSecret=d&author=ann&passengerCount=2',
    'https://x.test/cb#access_token=abc&state=1',
    'https://x.test/#/cb?idToken=abc',
    'https://x.test/a?q=1#frag',
    'http://x.example/cb?x=(1)&user[password]=SECRETA&q=a]&refresh_token=SECRETC',
    'http://x.example/cb?user%5Bpassword%5D=SECRETB',
    'https://x.test/?author=ann&passengers=2&user_token=a&password=b&x.auth=c&passwd=d&API-Key=e',
    `https://x.test/a b?pass word=x y&token=a"b'c<d>&q=\`t\`#t=1&password=${cp(0x2028)}z;api_key=k\\v`,
    'https://x.test/?password=&token=&q=1',
    'data:text/html,<redacted>?password=<redacted>&q="x"',
    'https://x.test/?%zz my Token=v&my%20Token=w&a=%41%42',
    'https://x.test/p;token=a;b=1?x=1;secret=s',
  ];
  for (const u of urls) {
    test(JSON.stringify(u).slice(0, 90), () => {
      assert.equal(S.safeUrl(u), round7(u));
    });
  }
});

// Round 7b's AC4 kept text outside printed URLs on the old rule; its residual (`- text "%27Hunter2xZ%27"` printed
// in clear) is what "secrets in text paths" (PLAN, 2026-10-26) fixes. The glued-letter row still holds.
describe('C1 AC4, reversed on 2026-10-26 ("secrets in text paths"): text follows the escape rule too', () => {
  test('in text an escape is a token edge and URL spellings are matched; a glued letter still is not', () => {
    S.rememberSecret(SECRET);
    S.rememberSecret("O'Brien!26");
    assert.equal(S.scrubSecrets(`- text "%27${SECRET}%27"`), `- text "%27${R}%27"`);
    assert.equal(S.scrubSecrets('- text "O%27Brien!26"'), `- text "${R}"`);
    assert.equal(S.scrubSecrets('- text "%48unter2xZ"'), `- text "${R}"`);
    assert.equal(S.scrubSecrets(`- text "x${SECRET}"`), `- text "x${SECRET}"`);
    assert.equal(S.scrubSecrets(`- text "'${SECRET}'"`), `- text "'${R}'"`);
  });
  test('a literal equal to a role word or a ref id is still not remembered, in text or in a URL', () => {
    S.rememberSecret('button');
    S.rememberSecret('e12345');
    S.rememberSecret('t123456');
    const url = 'http://h.test/p?q=%27button%27&r=e12345#t123456';
    assert.equal(S.safeUrl(url), url);
    assert.equal(S.scrubSecrets('- button "button" e12345'), '- button "button" e12345');
  });
});
