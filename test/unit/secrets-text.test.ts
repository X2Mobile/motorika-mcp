// Secrets in text paths (PLAN.md "2026-10-26: secrets in text paths"). Source: the round-7b re-check backlog and
// the reviewer's scripts in ~/x2b-r7brc-sec/ (text-paths.mjs, unit-pairs.mjs, unit-fuzz.mjs, perf*.mjs).
//
// Oracle (from the AC and the reviewer's scripts, never from this code's output):
//   - a leak is the secret as a whole token in a piece of a result line (lines split on all 7 separators, JSON
//     strings decoded, pieces split on <redacted>), read raw or percent-decoded (+ as a space too). A whole token has
//     no letter or digit directly before or after it; a `%XX` escape next to it counts as an edge whatever it decodes
//     to (AC1);
//   - AC2: the glued, role-word and no-secret rows are written out here (identity for text, round 7's formula for
//     printed URLs, which 7b's AC3 test showed equal to fba6f4f);
//   - AC3: the same pipeline with no secret remembered is the reference: a line whose JSON strings parse there must
//     still parse, and a stray `%` (not heading `%XX`) may appear only where the reference has one;
//   - AC5: wall time measured in a child process with a timeout and an RSS watchdog (a reproduction of a CPU bug
//     never runs in-process on unfixed code).
// Red-first: MOTORIKA_TEST_SRC=<old checkout>/src runs the same tests against another source tree.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { beforeEach, describe, test } from 'node:test';
import { leak, R, splitQuoted, structureProblems } from '../support/leak-oracle.ts';

const SRC = process.env.MOTORIKA_TEST_SRC ?? new URL('../../src', import.meta.url).pathname;
const S = (await import(`${SRC}/util/secrets.ts`)) as typeof import('../../src/util/secrets.ts');
const F = (await import(`${SRC}/util/format.ts`)) as typeof import('../../src/util/format.ts');
const C = (await import(`${SRC}/tools/console.ts`)) as typeof import('../../src/tools/console.ts');
const E = (await import(`${SRC}/tools/evaluate.ts`)) as typeof import('../../src/tools/evaluate.ts');
const D = (await import(`${SRC}/dispatch.ts`)) as typeof import('../../src/dispatch.ts');

const PAGE = 'http://h.test/page';

// ---- spellings, as a page or Chrome writes them ----

const pctU = (c: string): string => [...Buffer.from(c, 'utf8')].map((b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join('');
const pctL = (c: string): string => pctU(c).toLowerCase();
const encSet = (set: (c: string) => boolean) => (s: string): string => [...s].map((c) => (set(c) ? pctU(c) : c)).join('');
const wide = (c: string): boolean => (c.codePointAt(0) as number) < 0x21 || (c.codePointAt(0) as number) > 0x7e;
/** unit-fuzz.mjs SPELL, plus the JSON-escaped spelling. */
const SPELL: Record<string, (s: string) => string> = {
  raw: (s) => s,
  encodeURIComponent: (s) => encodeURIComponent(s),
  'encodeURIComponent, lower-case hex': (s) => encodeURIComponent(s).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()),
  'form (+ for a space)': (s) => encodeURIComponent(s).replace(/[!'()~]/g, pctU).replace(/%20/g, '+'),
  'every character encoded': (s) => [...s].map(pctU).join(''),
  'every other character encoded, mixed case': (s) => [...s].map((c, i) => (i % 2 ? (i % 4 === 1 ? pctL(c) : pctU(c)) : c)).join(''),
  "Chrome's fragment": encSet((c) => wide(c) || ' "<>`'.includes(c)),
  "Chrome's query": encSet((c) => wide(c) || ' "#<>\''.includes(c)),
  "Chrome's path": encSet((c) => wide(c) || ' "#<>?`{}^'.includes(c)),
  'JSON-escaped': (s) => JSON.stringify(s).slice(1, -1),
};

// ---- the output paths (AC1), each ending in the dispatcher's final pass ----

let reply = '';
const tab = {
  id: 't1',
  crashed: false,
  closed: false,
  dialog: undefined,
  guardBlanks: 0,
  page: { url: () => PAGE },
  drainEvents: () => [],
  dialogOpened: () => new Promise(() => undefined),
  enqueue: <T>(fn: () => Promise<T>) => fn(),
};
const Sess = (await import(`${SRC}/browser/session.ts`)) as typeof import('../../src/browser/session.ts');
const Tabs = (await import(`${SRC}/browser/tabs.ts`)) as typeof import('../../src/browser/tabs.ts');
const Cfg = (await import(`${SRC}/config.ts`)) as typeof import('../../src/config.ts');
const Types = (await import(`${SRC}/tools/types.ts`)) as typeof import('../../src/tools/types.ts');
const client = Tabs.newClient('local');
client.owned.add('t1');
client.active = 't1';
const session = {
  client: () => client,
  lock: new Sess.RWLock(),
  ensure: async () => undefined,
  getTab: () => tab,
  activeTab: async () => tab,
  refs: { get: () => undefined, whyMissing: () => ({ reason: 'unknown' }) },
};
const probe = Types.defineTool({ name: 'probe', description: 'echo', shape: {}, scope: 'tab', handler: async () => reply });
const dispatcher = new D.Dispatcher(session as never, Cfg.parseConfig(['--max-output-chars', '1000000'], {}, '/tmp'), new Map([[probe.name, probe]]));
/** A tool result text through the real dispatcher (its final pass over every result). */
async function through(text: string): Promise<string> {
  reply = text;
  const r = await dispatcher.dispatch('probe', {});
  return r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
}

const header = (): string => F.snapshotHeader('t1', 'Doc', PAGE);
/** Each path prints page text `t` the way its tool does (the tool's own scrub included). */
const PATHS: Record<string, (t: string) => string> = {
  'read body': (t) => `${header()}\n${F.escapeServerLines(S.scrubSecrets(`## Links\n\n[go](${t}) and more`))}`,
  'console message': (t) => `[t1] console: 1 message (untrusted page content)\n[warning] 12:00:00.000 ${C.messageText(`href ${t}`)} (${S.safeUrl(PAGE)}:11)`,
  'evaluate result': (t) =>
    `[t1] evaluate result (untrusted page content):\n${F.escapeJsonBreaks(S.scrubSecrets(E.safeEngineJson(JSON.stringify({ href: t, list: [t, 1] }))))}`,
  'snapshot text': (t) => `${header()}\n${F.textLine(1, `see ${t} now`)}`,
  'snapshot value': (t) => `${header()}\n${F.elementLine(0, 'textbox', 'Search', 5, { value: t }, PAGE)}`,
  'find hit': (t) => `[t1] find "go": 1 hit (untrusted page content)\n${F.elementLine(0, 'link', `go ${t}`, 7, undefined, PAGE)}`,
  'tabs title': (t) => `t1 ${F.titleQ(t)} ${S.safeUrl(PAGE)} (active)`,
  'effect lines': (t) => `[t1] clicked e2 button "go"\n${F.effect.alert(t)}\n${F.effect.console(1, t)}\n${F.effect.dialogPending('alert', t)}`,
  'error message': (t) => D.errorText(`[t1] page exception: ${F.jsonQuote(`Error: ${t}`)}`, 'fix the script and retry'),
  'network body': (t) => S.scrubSecrets(`[t1] r1 POST 200 fetch ${S.safeUrl(PAGE)} 5ms 10 B (untrusted page content)\nrequest body: ${F.escapeServerLines(`next=${t}`)}`),
};

/** Remember `secrets`, print `t` through `path` and the final pass; also the reference with nothing remembered. */
async function run(path: string, t: string, secrets: string[]): Promise<{ out: string; ref: string }> {
  S.resetSecretsForTest();
  const ref = await through((PATHS[path] as (x: string) => string)(t));
  for (const s of secrets) S.rememberSecret(s);
  const out = await through((PATHS[path] as (x: string) => string)(t));
  S.resetSecretsForTest();
  return { out, ref };
}

beforeEach(() => S.resetSecretsForTest());

// ---------------------------------------------------------------------------------------------------------
// AC1 + AC3: a remembered secret next to a percent-escape is redacted on every output path, in every spelling.

const SECRETS = ['Hunter2xZ', "O'Brien!26", 'pa ss w0rd', 'Ünïcødé9', 'Hu"nt\\er2!'];
/** Escapes next to the secret: Chrome's own and a page's, either hex case, multi-byte, and one that decodes to a letter. */
const ESCAPES = ['%27', '%3C', '%3c', '%20', '%22', '%60', '%C3%A9', '%25', '%41', '%2f'];
const SIDES: [string, string][] = ESCAPES.flatMap((e): [string, string][] => [[e, e], [e, ''], ['', e]]);

describe('AC1: a secret next to a %XX escape is redacted on every output path, in every spelling', () => {
  for (const path of Object.keys(PATHS)) {
    test(path, async () => {
      const bad: string[] = [];
      let rows = 0;
      for (const secret of SECRETS) {
        for (const [sp, spell] of Object.entries(SPELL)) {
          const x = spell(secret);
          for (const [l, r] of SIDES) {
            const t = `http://h.test/r?q=${l}${x}${r}&n=1`;
            rows++;
            const { out, ref } = await run(path, t, [secret]);
            const why: string[] = [];
            const at = leak(out, secret);
            if (at !== null) why.push(`LEAK in ${JSON.stringify(at.slice(0, 220))}`);
            why.push(...structureProblems(out, ref));
            if (leak(ref, secret) !== null && !out.includes(R)) why.push('no <redacted> marker');
            if (why.length > 0) bad.push(`${JSON.stringify(secret)} ${sp} ${JSON.stringify([l, r])}: ${why.join('; ')}`);
          }
        }
      }
      assert.deepEqual(bad, [], `${bad.length} of ${rows} rows:\n${bad.slice(0, 30).join('\n')}`);
    });
  }

  test("text-paths.mjs: the reviewer's leaking lines, verbatim shapes", async () => {
    const rows: [secret: string, text: string][] = [
      ['Hunter2xZ', '[query-quote](http://127.0.0.1:54912/r?q=%27Hunter2xZ%27)'],
      ['Hunter2xZ', '[hash-angle](http://127.0.0.1:54912/r#%3CHunter2xZ%3E)'],
      ['Hunter2xZ', '[warning] 16:27:36.139 href http://127.0.0.1:54912/r?q=%27Hunter2xZ%27 (http://127.0.0.1:54912/tp:11)'],
      ['Hunter2xZ', '"http://127.0.0.1:54912/tp?q=%27Hunter2xZ%27"'],
      ["O'Brien!26", '[query-quote](http://127.0.0.1:54912/r?q=%27O%27Brien!26%27)'],
      ["O'Brien!26", '[query-plain](http://127.0.0.1:54912/r?q=O%27Brien!26)'],
      ["O'Brien!26", "[hash-angle](http://127.0.0.1:54912/r#%3CO'Brien!26%3E)"],
      ["O'Brien!26", '"http://127.0.0.1:54912/tp?q=%27O%27Brien!26%27"'],
    ];
    const bad: string[] = [];
    for (const [secret, text] of rows) {
      S.resetSecretsForTest();
      S.rememberSecret(secret);
      for (const out of [S.scrubSecrets(text), await through(text)]) {
        const at = leak(out, secret);
        if (at !== null || !out.includes(R)) bad.push(`${JSON.stringify(text)} -> ${JSON.stringify(out)}`);
      }
    }
    assert.deepEqual(bad, [], bad.join('\n'));
  });

  test('the final pass still redacts secret-named parameters after a redacted secret in a URL (advisor review)', async () => {
    // The dispatcher's safety net (redactPrintedUrls) reads a URL up to a `<`; a `<redacted>` mid-URL must not end it.
    S.rememberSecret('Hunter2xZ');
    const rows: [text: string, want: string][] = [
      ['see http://h.test/r?q=%27Hunter2xZ%27&token=abc now', `see http://h.test/r?q=%27${R}%27&token=${R} now`],
      ['see http://h.test/r?q=Hunter2xZ&token=abc now', `see http://h.test/r?q=${R}&token=${R} now`],
      [
        `[t1] evaluate result (untrusted page content):\n${JSON.stringify('http://h.test/r?q=%27Hunter2xZ%27&api_key=k1#access_token=t2')}`,
        `[t1] evaluate result (untrusted page content):\n"http://h.test/r?q=%27${R}%27&api_key=${R}#access_token=${R}"`,
      ],
      [
        F.elementLine(0, 'link', 'go', 5, { href: 'http://h.test/r?q=%27Hunter2xZ%27&api_key=k1#access_token=t2' }, 'http://h.test/x'),
        `- link "go" e5 href="/r?q=%27${R}%27&api_key=${R}#access_token=${R}"`,
      ],
      ['[warning] 12:00:00.000 href http://h.test/r#%3CHunter2xZ%3E&password=pw9 (http://h.test/:1)', `[warning] 12:00:00.000 href http://h.test/r#%3C${R}%3E&password=${R} (http://h.test/:1)`],
    ];
    const bad: string[] = [];
    for (const [text, want] of rows) {
      const out = await through(text);
      if (out !== want) bad.push(`${JSON.stringify(text)} -> ${JSON.stringify(out)}, want ${JSON.stringify(want)}`);
    }
    assert.deepEqual(bad, [], bad.join('\n'));
  });
  test('named rows: the exact text a path prints (escapes kept, the secret one marker)', () => {
    const rows: [label: string, secret: string, text: string, want: string][] = [
      ['quote escapes around', 'Hunter2xZ', 'q=%27Hunter2xZ%27&n=1', `q=%27${R}%27&n=1`],
      ['lower-case escapes around', 'Hunter2xZ', 'q=%3cHunter2xZ%3e', `q=%3c${R}%3e`],
      ['an escape that decodes to a letter is still an edge', 'Hunter2xZ', 'q=%41Hunter2xZ%42', `q=%41${R}%42`],
      ['multi-byte escapes', 'Hunter2xZ', '#%C3%A9Hunter2xZ%C3%A9', `#%C3%A9${R}%C3%A9`],
      ["Chrome's query spelling", "O'Brien!26", 'q=O%27Brien!26)', `q=${R})`],
      ['a mixed spelling next to an escape', 'Hunter2xZ', '%27%48unter%32xZ%27', `%27${R}%27`],
      ['form spelling of a spaced secret', 'pa ss w0rd', 'q=%22pa+ss+w0rd%22', `q=%22${R}%22`],
      ['a %20/+ mix of a spaced secret', 'pa ss w0rd', 'q=%22pa+ss%20w0rd%22', `q=%22${R}%22`],
      ['JSON-escaped, in a JSON string, next to an escape', 'Hu"nt\\er2!', '"x=%27Hu\\"nt\\\\er2!%27"', `"x=%27${R}%27"`],
      ['a Chrome URL inside a JSON string (%22 and \\\\ mixed)', 'Hu"nt\\er2!', '"?q=%27Hu%22nt\\\\er2!%27"', `"?q=%27${R}%27"`],
      ['two copies', 'Hunter2xZ', '%27Hunter2xZ%27 and %3CHunter2xZ%3E', `%27${R}%27 and %3C${R}%3E`],
      // never split an escape: a match that starts or ends inside one takes the whole escape (as in printed URLs)
      ['a secret that starts inside an escape takes it', '7Hunter2xZ', 'q=%27Hunter2xZ ok', `q=${R} ok`],
      ['a secret that ends inside an escape takes it', 'Hunter2x%', 'q=Hunter2x%41 ok', `q=${R} ok`],
      ['a hex-led secret after a % takes the escape', '25Hunter', '100%25Hunter ok', `100${R} ok`],
    ];
    const bad: string[] = [];
    for (const [label, secret, text, want] of rows) {
      S.resetSecretsForTest();
      S.rememberSecret(secret);
      const out = S.scrubSecrets(text);
      if (out !== want) bad.push(`${label}: ${JSON.stringify(text)} -> ${JSON.stringify(out)}, want ${JSON.stringify(want)}`);
    }
    assert.deepEqual(bad, [], bad.join('\n'));
  });
});

// ---------------------------------------------------------------------------------------------------------
// Fix round 2 (security review of ee4c863, docs/reviews/review-secret-text-paths.md, C1): the URL safety net was
// armed only when final()'s own scrub changed the text, but read, console and evaluate scrub first, so a
// secret-named parameter after a redacted secret printed in clear. The reviewer's shapes (~/x2b-st-review/
// prescrub.mjs, urlnet.mjs) go through each tool's own pipeline (its scrub first; console through its real
// handler), then the real final(): neither the password nor a secret-named parameter value may print.

const C1_SHAPES: [label: string, url: (x: string) => string][] = [
  ['incident: %27 secret %27 then &token', (x) => `http://h.test/r?q=%27${x}%27&token=TOKVAL1`],
  ['plain: the secret then &token (fba6f4f printed this token too)', (x) => `http://h.test/r?q=${x}&token=TOKVAL2`],
  ['fragment: %27 secret %27 then &access_token', (x) => `http://h.test/r#q=%27${x}%27&access_token=TOKVAL3`],
  ['a URL glued after the secret, query', (x) => `http://a.test/?q=!${x}!http://b.test/?token=TOKVAL4`],
  ['a URL glued after the secret, fragment', (x) => `http://a.test/#!${x}!http://b.test/#access_token=TOKVAL5`],
  ['a URL glued after a %27-wrapped secret (fba6f4f printed both)', (x) => `http://a.test/?q=%27${x}%27http://b.test/?token=TOKVAL6`],
  ['the outer URL goes on after an inner URL (fba6f4f hid this token)', (x) => `http://a.test/?q=%27${x}%27&next=http://b.test/&token=TOKVAL7`],
  ['secret-named parameters around the secret', (x) => `http://h.test/r?password=%27${x}%27&api_key=TOKVAL8#access_token=TOKVAL9`],
];
const C1_SECRETS = ['Hunter2xZ', "O'Brien!26", 'pa ss w0rd', 'Hu"nt\\er2!'];

/** The console tool's real handler over one stored message (its scrub, clip and continuation lines). */
async function consoleTool(t: string): Promise<string> {
  const ctx = { tab: { id: 't1', console: [{ level: 'warning', time: Date.UTC(2026, 9, 27, 12), text: `href ${t}`, url: PAGE, line: 11 }] }, config: { maxOutputChars: 1_000_000 } };
  const r = await C.console_.run({ level: 'all' }, ctx as never);
  return r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
}

describe('C1 (round 2): a secret-named parameter after a redacted secret never prints, on every output path', () => {
  const paths: [string, (t: string) => Promise<string>][] = [
    ...Object.entries(PATHS).map(([k, f]): [string, (t: string) => Promise<string>] => [k, async (t) => f(t)]),
    ['console tool (real handler)', consoleTool],
  ];
  for (const [path, print] of paths) {
    test(path, async () => {
      const bad: string[] = [];
      let rows = 0;
      for (const secret of C1_SECRETS) {
        for (const [sp, spell] of Object.entries(SPELL)) {
          // A JSON-escaped spelling inside a JSON-quoted path is escaped twice: the README's documented gap, where the
          // net also stops at the backslash (fba6f4f the same).
          if (sp === 'JSON-escaped' && (path === 'evaluate result' || path === 'error message')) continue;
          for (const [label, shape] of C1_SHAPES) {
            const t = shape(spell(secret));
            rows++;
            S.resetSecretsForTest();
            const ref = await through(await print(t));
            S.rememberSecret(secret);
            const out = await through(await print(t));
            S.resetSecretsForTest();
            const why: string[] = [];
            const tok = /TOKVAL\d/.exec(out);
            if (tok) why.push(`${tok[0]} printed`);
            const at = leak(out, secret);
            if (at !== null) why.push(`secret in ${JSON.stringify(at.slice(0, 200))}`);
            why.push(...structureProblems(out, ref));
            if (why.length > 0) bad.push(`${JSON.stringify(secret)} ${sp} [${label}]: ${why.join('; ')} -> ${JSON.stringify(out.split('\n').pop()?.slice(0, 220))}`);
          }
        }
      }
      assert.deepEqual(bad, [], `${bad.length} of ${rows} rows:\n${bad.slice(0, 25).join('\n')}`);
    });
  }

  test("prescrub.mjs's rows, exact output through read, console and evaluate", async () => {
    S.rememberSecret('Hunter2xZ');
    const rows: [label: string, out: string, want: string][] = [
      ['read', await through(PATHS['read body']!('http://h.test/r?q=%27Hunter2xZ%27&token=TOKVAL1')), `[go](http://h.test/r?q=%27${R}%27&token=${R}) and more`],
      ['console', await consoleTool('http://h.test/r#q=%27Hunter2xZ%27&access_token=TOKVAL3'), `href http://h.test/r#q=%27${R}%27&access_token=${R}`],
      ['evaluate', await through(PATHS['evaluate result']!('http://h.test/r?q=Hunter2xZ&token=TOKVAL2')), `"http://h.test/r?q=${R}&token=${R}"`],
    ];
    const bad = rows.filter(([, out, want]) => !out.includes(want)).map(([l, out, want]) => `${l}: ${JSON.stringify(out)} lacks ${JSON.stringify(want)}`);
    assert.deepEqual(bad, [], bad.join('\n'));
  });

  test('with no secret remembered, the same URLs print as on fba6f4f (the net is unchanged there)', async () => {
    for (const [, shape] of C1_SHAPES) {
      const t = shape('plainword');
      assert.equal(await through(PATHS['console message']!(t)), D.redactPrintedUrls(PATHS['console message']!(t)));
    }
  });
});

// ---------------------------------------------------------------------------------------------------------
// Fix round 2, W1: a `\uXXXX` escape was decoded on its own, so an escaped surrogate pair (as Python's json.dumps
// writes an emoji) read as two U+FFFD and a secret holding it printed in clear.

describe('W1 (round 2): a secret with an astral character, shown as JSON surrogate escapes, is redacted', () => {
  /** An astral character as two `\\uXXXX` escapes (hex in lower or upper case); everything else as it is. */
  const esc = (v: string, upper = false): string =>
    [...v].map((ch) => (ch.length === 2 ? [ch.charCodeAt(0), ch.charCodeAt(1)].map((u) => `\\u${upper ? u.toString(16).toUpperCase() : u.toString(16)}`).join('') : ch)).join('');
  const SMILE = `Smile${String.fromCodePoint(0x1f600)}42`;
  const TWO = `ab${String.fromCodePoint(0x1f600)}${String.fromCodePoint(0x1f600)}cd`;
  test('raw paths (read body, console, network body, the real console handler), lower- and upper-case hex', async () => {
    const bad: string[] = [];
    for (const secret of [SMILE, TWO]) {
      for (const spelled of [esc(secret), esc(secret, true)]) {
        const t = `{"pw":"${spelled}","n":1}`;
        for (const [path, print] of [
          ['read body', async (x: string) => PATHS['read body']!(x)],
          ['console message', async (x: string) => PATHS['console message']!(x)],
          ['network body', async (x: string) => PATHS['network body']!(x)],
          ['console tool (real handler)', consoleTool],
        ] as const) {
          S.resetSecretsForTest();
          S.rememberSecret(secret);
          const out = await through(await print(t));
          const at = leak(out, secret);
          if (at !== null || !out.includes(R)) bad.push(`${path} ${JSON.stringify(spelled)}: ${JSON.stringify(out.split('\n').pop())}`);
        }
      }
    }
    assert.deepEqual(bad, [], bad.join('\n'));
  });
  test('exact text; a lone or reversed surrogate escape still reads as U+FFFD and matches nothing else', () => {
    S.rememberSecret(SMILE);
    assert.equal(S.scrubSecrets('{"pw":"Smile\\ud83d\\ude0042"}'), `{"pw":"${R}"}`);
    for (const t of ['x Smile\\ud83d42 y', 'x Smile\\ude00\\ud83d42 y', 'x Smile\\ud83d\\u004142 y']) assert.equal(S.scrubSecrets(t), t);
  });
});

// ---------------------------------------------------------------------------------------------------------
// AC2: otherwise the plain-text whole-token rule is unchanged.

describe('AC2: the whole-token rule is otherwise unchanged', () => {
  test('a secret glued to a letter or digit is left alone, also when an escape is on its other side', () => {
    S.rememberSecret('Hunter2xZ');
    for (const line of ['- text "xHunter2xZ"', '- text "Hunter2xZ9"', 'q=xHunter2xZ%27', 'q=%27Hunter2xZb', 'aHunter2xZ ok', 'C%27Hunter2xZ9', '"x%48unter2xZ"']) {
      assert.equal(S.scrubSecrets(line), line);
    }
  });
  test('a literal equal to a role word or a ref id is not scrubbed, next to escapes either', async () => {
    for (const s of ['button', 'textbox', 'e12345', 't123456']) S.rememberSecret(s);
    S.rememberSecret('Hunter2xZ'); // a real secret too, so the matcher runs
    for (const line of ['- button "button" e12345', '- textbox "%27button%27" e7', 'q=%27e12345%27&t=%3Ct123456%3E', '[t123456] %22textbox%22']) {
      assert.equal(S.scrubSecrets(line), line);
      assert.equal(await through(line), line);
    }
  });
  test('two secrets glued to each other with no edge between them stay as they are (README)', () => {
    S.rememberSecret('Hunter2xZ');
    S.rememberSecret('Zebra99!');
    for (const line of ['Hunter2xZebra99!', '%27Hunter2xZebra99!%27', '- text "Hunter2xZebra99!"']) assert.equal(S.scrubSecrets(line), line);
  });
  // The decoded view reads `+` as a space; a form that trims to a role word is dropped, so `+button` never matches the
  // grammar's ` button`. (A literal with real spaces, ` textbox `, still does in the raw view, as on fba6f4f: PLAN
  // backlog.)
  test('a secret that is a role word after a + never matches the grammar (+button vs - button)', async () => {
    S.rememberSecret('+button');
    for (const line of ['- button "x" e5', '- button "button" e12']) {
      assert.equal(S.scrubSecrets(line), line);
      assert.equal(await through(line), line);
    }
    assert.equal(S.scrubSecrets('q=+button&n=1'), `q=${R}&n=1`);
  });
  test('a + and a space count as the same character in a secret (README)', () => {
    S.rememberSecret('pa+ss12x');
    assert.equal(S.scrubSecrets('is pa ss12x.'), `is ${R}.`);
    assert.equal(S.scrubSecrets('q=pa%2Bss12x&n=1'), `q=${R}&n=1`);
  });
  test('the plain spelling still needs a non-letter-or-digit or an escape on both sides', () => {
    S.rememberSecret('Hunter2!x');
    assert.equal(S.scrubSecrets('You typed Hunter2!x.'), `You typed ${R}.`);
    assert.equal(S.scrubSecrets('line\\nHunter2!x'), `line\\n${R}`);
    assert.equal(S.scrubSecrets('C:\\\\Hunter2!x'), `C:\\\\${R}`);
    assert.equal(S.scrubSecrets('aHunter2!x'), 'aHunter2!x');
  });

  /** Round 7's safeUrl with no secret remembered (7b AC3): encode first, then the parameter rule. */
  const UNSAFE = /[\s"'<>\\`\u0000-\u001f\u007f-\u009f]/g;
  const round7 = (u: string): string => S.redactUrlParams(u.replace(UNSAFE, pctU));
  const CORPUS = [
    'plain text, nothing to do',
    '%27Hunter2xZ%27 and %3c%3E %zz %4 % \\n \\"q\\" \\u2028 \\ud800',
    '- text "%27Hunter2xZ%27"',
    '[t1] "T" http://h.test/a?token=abc&q=%27x%27#frag (untrusted page content)',
    `- link "a\\"b" e5 href="/p?q=%27x%27&password=s3cret"`,
    '{"a":"\\u0000\\"","b":[1,"%C3%A9"]}',
    `lone ${String.fromCharCode(0xd800)} surrogate, NEL\u0085, LS\u2028 and ${'%'.repeat(9)}`,
    '<redacted> already, and %3Credacted%3E',
  ];
  const URLS = [
    'https://x.test/?accessToken=a&apiKey=b&q=%27x%27#access_token=c',
    "http://h.test/p?q='x' y\"z<a>`b`\\c#f g",
    'data:text/html,<b>%27Hunter2xZ%27</b>',
    'http://u:p@h.test/%zz/%4/%25?x=%2B+y',
  ];
  test('with no secret remembered, every text is returned unchanged and every URL prints as before (byte-identical)', async () => {
    for (const t of CORPUS) {
      assert.equal(S.scrubSecrets(t), t);
      assert.equal(await through(t), D.redactPrintedUrls(t));
      for (const path of Object.keys(PATHS)) {
        const printed = (PATHS[path] as (x: string) => string)(t);
        assert.equal(await through(printed), D.redactPrintedUrls(printed), path);
      }
    }
    for (const u of URLS) {
      assert.equal(S.safeUrl(u), round7(u));
      assert.equal(S.redactUrl(u), S.redactUrlParams(u));
    }
  });
  test('with no secret remembered, a page-planted <redacted> inside a URL ends it as on fba6f4f (byte-identical)', async () => {
    // fba6f4f's safety net read a URL up to a `<`: the parameters after a page's own `<redacted>` text were not checked.
    for (const t of ['see http://h.test/?a=<redacted>&token=abc now', '[warning] 12:00:00.000 http://h.test/#x=<redacted>&password=p (http://h.test/:1)']) {
      assert.equal(await through(t), t);
    }
  });
  test('with secrets remembered that do not occur, every text is returned unchanged', () => {
    for (const s of ['Hunter2xZ', "O'Brien!26", 'pa ss w0rd', 'p%41ss+wd9', 'Hu"nt\\er2!']) S.rememberSecret(s);
    for (const t of CORPUS.filter((x) => !x.includes('Hunter2xZ'))) assert.equal(S.scrubSecrets(t), t);
  });
});

// ---------------------------------------------------------------------------------------------------------
// AC3: never split an escape or a quoted string.

describe('AC3: a redaction never splits an escape or a quoted string', () => {
  test('a secret ending in a quote does not eat the closing quote of a JSON string (page text stays inside quotes)', async () => {
    S.rememberSecret('Hunter2"');
    const line = `- button ${F.jsonQuote('Hunter2')} e5 href=${F.jsonQuote('/x?q=e99999')}`;
    const out = await through(line);
    const q = splitQuoted(out);
    assert.equal(q.bad, false, out);
    assert.ok(!/(^|\s)e99999(\s|$)/.test(q.outside), `a page token outside quotes: ${out}`);
    const ev = await through(`[t1] evaluate result (untrusted page content):\n${S.scrubSecrets(JSON.stringify(['Hunter2', 'e99999 FORGED']))}`);
    for (const l of ev.split('\n')) assert.equal(splitQuoted(l).bad, false, ev);
    assert.doesNotThrow(() => JSON.parse(ev.split('\n')[1] ?? ''), ev);
  });
  test('a secret starting with a quote keeps the opening quote of a JSON string', async () => {
    S.rememberSecret('"Hunter2xZ');
    const out = await through(`- button ${F.jsonQuote('Hunter2xZ')} e5`);
    assert.equal(splitQuoted(out).bad, false, out);
  });
  test('a whole value that is a secret is one marker (rememberedIn relies on it), quotes and all', () => {
    for (const s of ['"Hunter2xZ"', 'Hu"nt\\er2!', "O'Brien!26", '%27Hunter%27']) {
      S.resetSecretsForTest();
      S.rememberSecret(s);
      assert.equal(S.scrubSecrets(s), R, s);
    }
  });
  test('JSON escapes are never split: a secret inside one is refused, one right after it is redacted', async () => {
    S.rememberSecret('nopass12');
    S.rememberSecret('Hunter2!x');
    for (const text of ['x\\nopass12 y', 'line\\nHunter2!x', '"a\\u2028Hunter2!x"', '"\\"Hunter2!x\\""']) {
      const out = await through(text);
      assert.ok(!/\\<redacted>/.test(out), `an escape split: ${out}`);
      if (text.startsWith('"')) assert.doesNotThrow(() => JSON.parse(out), out);
    }
    assert.equal(S.scrubSecrets('line\\nHunter2!x'), `line\\n${R}`);
    assert.equal(S.scrubSecrets('"\\"Hunter2!x\\""'), `"\\"${R}\\""`);
  });
  test('a match inside a JSON escape is left alone (README: `\\nopass12` for the secret `nopass12`)', () => {
    S.rememberSecret('nopass12');
    assert.equal(S.scrubSecrets('x\\nopass12 y'), 'x\\nopass12 y');
  });
  test('the marker prints as <redacted>, never encoded, in text, JSON strings and printed URLs', async () => {
    S.rememberSecret('Hunter2xZ');
    assert.equal(await through(`a %27Hunter2xZ%27 b`), `a %27${R}%27 b`);
    assert.equal(await through(`- text ${F.jsonQuote('%27Hunter2xZ%27')}`), `- text "%27${R}%27"`);
    assert.equal(S.safeUrl("http://h.test/p#'Hunter2xZ'"), `http://h.test/p#%27${R}%27`);
  });
});

describe('README "Not covered": the documented gaps stay as documented (a change here changes the README too)', () => {
  test('base64, a changed case, double encoding, a twice-escaped quote or backslash, a non-UTF-8 charset are not matched', () => {
    S.rememberSecret('Hunter2xZ!');
    S.rememberSecret('Pässwörd1');
    S.rememberSecret('Hu"nt\\er2!');
    // A JSON string inside a JSON string, as printed: the secret's `"` and `\\` are escaped twice.
    const nested = JSON.stringify(JSON.stringify({ pw: 'Hu"nt\\er2!' })).slice(1, -1);
    for (const line of [
      `b64 ${Buffer.from('Hunter2xZ!').toString('base64')}`,
      'case HUNTER2XZ!',
      'double %2527Hunter2xZ%2521%2527',
      `nested ${nested}`,
      'charset ?q=P%E4ssw%F6rd1&n=1',
    ]) {
      assert.equal(S.scrubSecrets(line), line);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------
// AC4: two touching or overlapping secrets are both redacted, in any order of remembering (unit-pairs.mjs).

describe('AC4: touching or overlapping secrets are all redacted, in any order', () => {
  const PAIRS: [string, string, string][] = [
    ['Hunter2xZ', '2xZ!Pass99', 'Hunter2xZ!Pass99'], // overlap at 2xZ
    ['Hunter2xZ!', 'Hunter2xZ', 'Hunter2xZ!'], // one contains the other
    ["O'Brien!26", 'Brien!26xy', "O'Brien!26xy"], // overlap, quote inside
    ['Hunter2xZ', 'Zebra99!', 'Hunter2xZebra99!'], // overlap at Z
    ['Hunter2é', 'Zebra99!', 'Hunter2éZebra99!'], // touch; Chrome encodes é
    ['Hunter2xZ', 'Pass99!x', "Hunter2xZ'Pass99!x"], // touch through a quote
    ['pa ss w0rd', 'w0rd 2b', 'pa ss w0rd 2b'], // overlap with spaces
  ];
  const WRAP = ["'", '%27', ' ', '<', '%3C', ''];
  const PREFIX = ['http://h/p?q=', 'http://h/p#', 'data:text/html,'];
  for (const order of ['first', 'second'] as const) {
    test(`printed URLs and text, remembered ${order === 'first' ? 'in pair order' : 'in reverse order'}`, async () => {
      const bad: string[] = [];
      let n = 0;
      for (const [a, b, body] of PAIRS) {
        const mem = order === 'first' ? [a, b] : [b, a];
        for (const [sp, spell] of Object.entries(SPELL)) {
          const x = spell(body);
          for (const w of WRAP) {
            for (const pre of PREFIX) {
              const url = `${pre}${w}${x}${w}`;
              S.resetSecretsForTest();
              for (const s of mem) S.rememberSecret(s);
              const outs = [
                ['safeUrl', await through(S.safeUrl(url))],
                ['console', await through(C.messageText(`href ${url}`))],
                ['evaluate', await through(S.scrubSecrets(JSON.stringify(url)))],
              ];
              for (const [where, out] of outs) {
                n++;
                const whole = [a, b].filter((s) => leak(out as string, s) !== null);
                if (whole.length > 0) bad.push(`${where} ${sp} ${JSON.stringify(url)} -> ${JSON.stringify(out)} shows ${JSON.stringify(whole)}`);
              }
            }
          }
        }
      }
      assert.deepEqual(bad, [], `${bad.length} of ${n}:\n${bad.slice(0, 30).join('\n')}`);
    });
  }
  test('named pairs, exact output: both redacted and merged, whichever is remembered first', () => {
    const rows: [a: string, b: string, text: string, want: string][] = [
      // B's claim gives A its right edge; A comes first in the text, so this needs the fixpoint, not one pass.
      ["O'Brien!26", 'Brien!26xy', "say O'Brien!26xy now", `say ${R} now`],
      ['Hunter2xZ', 'Zebra99!', '%27Hunter2xZ%C3%A9Zebra99!%27', `%27${R}%C3%A9${R}%27`],
      ['Hunter2é', 'Zebra99!', '%27Hunter2%C3%A9Zebra99!%27', `%27${R}%27`],
      ['Hunter2xZ', '2xZ!Pass99', "'Hunter2xZ!Pass99'", `'${R}'`],
      ['pa ss w0rd', 'w0rd 2b', '(pa ss w0rd 2b)', `(${R})`],
    ];
    const bad: string[] = [];
    for (const [a, b, text, want] of rows) {
      for (const order of [[a, b], [b, a]]) {
        S.resetSecretsForTest();
        for (const x of order) S.rememberSecret(x);
        const out = S.scrubSecrets(text);
        if (out !== want) bad.push(`${JSON.stringify(order)} ${JSON.stringify(text)} -> ${JSON.stringify(out)}, want ${JSON.stringify(want)}`);
      }
    }
    assert.deepEqual(bad, [], bad.join('\n'));
  });
  test('a chain of touching copies resolves from its free end: every copy is redacted', () => {
    S.rememberSecret('Hunter2xZ!');
    assert.equal(S.scrubSecrets(`%27${'Hunter2xZ!'.repeat(5)}%27`), `%27${R}%27`);
    assert.equal(S.scrubSecrets(`'${'Hunter2xZ!'.repeat(5)}'`), `'${R}'`);
  });
  test('a secret touching itself (two copies glued) is redacted twice, in every spelling', async () => {
    const bad: string[] = [];
    for (const secret of [...SECRETS, 'Hunter2xZ+', 'C0FFEE99']) {
      for (const [sp, spell] of Object.entries(SPELL)) {
        const x = spell(secret);
        for (const w of ['%25', '%27', ' ']) {
          S.resetSecretsForTest();
          S.rememberSecret(secret);
          for (const [where, out] of [
            ['safeUrl', await through(S.safeUrl(`http://h/p?q=${w}${x}${x}${w}`))],
            ['text', await through(`see ${w}${x}${x}${w} now`)],
          ] as const) {
            if (leak(out, secret) !== null) bad.push(`${where} ${JSON.stringify(secret)} ${sp} ${JSON.stringify(w)}: ${JSON.stringify(out)}`);
          }
        }
      }
    }
    assert.deepEqual(bad, [], `${bad.length}:\n${bad.slice(0, 30).join('\n')}`);
  });
});

// ---------------------------------------------------------------------------------------------------------
// AC5: bounded cost. Each case runs in a child process: a reproduction of a CPU bug never runs in-process on
// unfixed code (memory note "bounded red-first tests"); the child is killed after `limitMs` or above 1.5 GB RSS.

const TSX = new URL('../../node_modules/tsx/dist/esm/index.mjs', import.meta.url).pathname;
interface Timed {
  ms?: number;
  killed?: string;
  out?: string;
}
/** Runs `body` (an async function body with S = the secrets module) in a child and returns its measured ms. */
function timedChild(body: string, limitMs: number): Promise<Timed> {
  const script = `const S = await import(${JSON.stringify(`${SRC}/util/secrets.ts`)});\n${body}`;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', TSX, '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let killed: string | undefined;
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    const kill = (why: string): void => {
      killed ??= why;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => kill(`timeout after ${limitMs} ms`), limitMs);
    const watch = setInterval(() => {
      try {
        const rss = Number(execFileSync('ps', ['-o', 'rss=', '-p', String(child.pid)]).toString().trim()) * 1024;
        if (rss > 1.5 * 1024 ** 3) kill(`RSS ${(rss / 1024 ** 3).toFixed(2)} GB`);
      } catch {
        /* gone */
      }
    }, 250);
    child.on('exit', () => {
      clearTimeout(timer);
      clearInterval(watch);
      if (killed) return resolve({ killed });
      const m = /RESULT (\{.*\})/.exec(stdout);
      if (!m) return resolve({ killed: `no result: ${stderr.slice(-500)}` });
      resolve(JSON.parse(m[1] as string) as Timed);
    });
  });
}
/** The measured call: the best of 3 after a warm-up, so a one-off GC pause does not decide. */
const MEASURE = (setup: string, call: string): string => `${setup}
const run = () => { const t0 = performance.now(); const out = ${call}; return [performance.now() - t0, out.length]; };
run();
const ms = Math.min(run()[0], run()[0], run()[0]);
console.log('RESULT ' + JSON.stringify({ ms }));`;

const MB2 = 2 * 1024 * 1024 - 64;
const CASES: [label: string, setup: string, call: string, maxMs: number][] = [
  ['a 1000-char secret, 2 MB of its own character in a printed URL (the reported 11 s)', `S.rememberSecret('a'.repeat(1000)); const u = 'http://h/p#' + 'a'.repeat(${MB2});`, 'S.safeUrl(u)', 200],
  ['the same in text', `S.rememberSecret('a'.repeat(1000)); const t = 'x ' + 'a'.repeat(${MB2});`, 'S.scrubSecrets(t)', 200],
  // Guards against a superlinear claim pass (a regression there takes seconds): 500 ms leaves room for the full
  // suite's parallel Chrome load. The AC's own case (the plain 2 MB rows) keeps its 200 ms bound.
  ['the same in text written as escapes (every match overlaps the last)', `S.rememberSecret('a'.repeat(1000)); const t = 'x ' + '%61'.repeat(${Math.floor(MB2 / 3)});`, 'S.scrubSecrets(t)', 500],
  ['a 1000-char secret that never matches (a*999+b), 2 MB of a, printed URL', `S.rememberSecret('a'.repeat(999) + 'b'); const u = 'data:text/html,' + 'a'.repeat(${MB2});`, 'S.safeUrl(u)', 200],
  ['a 4000-char secret, 2 MB of its own character in a printed URL', `S.rememberSecret('a'.repeat(4000)); const u = 'data:text/html,' + 'a'.repeat(${MB2});`, 'S.safeUrl(u)', 200],
  [
    '64 secrets of 64 a-prefixed characters, 2 MB of a, printed URL (perf.mjs case 9)',
    `for (let i = 0; i < 64; i++) S.rememberSecret('a'.repeat(63) + String.fromCharCode(66 + i)); const u = 'data:text/html,' + 'a'.repeat(${MB2});`,
    'S.safeUrl(u)',
    200,
  ],
  [
    '64 secrets, 2 MB of %XX escapes in text',
    `for (let i = 0; i < 64; i++) S.rememberSecret('Pw' + i + '-' + 'x'.repeat(30) + '!'); const t = '%41%2'.repeat(${Math.floor(MB2 / 5)});`,
    'S.scrubSecrets(t)',
    200,
  ],
  ['a chain of 100k touching copies that resolves one by one (no rescan per claim), text', `S.rememberSecret('Hunter2xZ!'); const t = '%27' + 'Hunter2xZ!'.repeat(100000) + '%27';`, 'S.scrubSecrets(t)', 500],
  ['200k separate redactions after a quoted string (the output is built in one pass), text', `S.rememberSecret('Hunter2xZ'); const t = '"start" ' + 'Hunter2xZ '.repeat(200000);`, 'S.scrubSecrets(t)', 200],
  [
    'realistic: 3 secrets against 20 KB of page text with escapes and JSON',
    `for (const s of ['Hunter2xZ', "O'Brien!26", 'pa ss w0rd']) S.rememberSecret(s); const t = ('see http://h.test/r?q=%27x%27&n=1 and "a\\\\"b" %3Cdiv%3E ').repeat(400);`,
    'S.scrubSecrets(t)',
    20,
  ],
];

describe('AC5: bounded cost (child process, timeout and RSS watchdog)', () => {
  test('64 long page-chosen secrets with escape-like sequences: building the matchers stays small and quick', { timeout: 60_000 }, async (t) => {
    const body = `for (let i = 0; i < 64; i++) S.rememberSecret('%4' + (i % 10) + '%4' + ((i + 1) % 10) + '%4' + ((i + 2) % 10) + '%4' + ((i + 3) % 10) + (i + '-').padEnd(988, 'x'));
const m0 = process.memoryUsage();
const t0 = performance.now();
S.scrubSecrets('text %41 a+b'); S.scrubSecrets('plain text'); S.safeUrl('http://h/p?q=%41+b'); S.safeUrl('http://h/p?q=plain');
const ms = performance.now() - t0;
const m1 = process.memoryUsage();
console.log('RESULT ' + JSON.stringify({ ms, mb: (m1.external + m1.heapUsed - m0.external - m0.heapUsed) / 1048576 }));`;
    const r = (await timedChild(body, 30_000)) as Timed & { mb?: number };
    assert.equal(r.killed, undefined, `killed: ${r.killed}`);
    t.diagnostic(`build of all four matchers: ${(r.ms as number).toFixed(0)} ms, ${(r.mb as number).toFixed(0)} MB`);
    assert.ok((r.mb as number) < 100, `the matchers took ${(r.mb as number).toFixed(0)} MB`);
    assert.ok((r.ms as number) < 200, `building took ${(r.ms as number).toFixed(0)} ms`);
  });

  for (const [label, setup, call, maxMs] of CASES) {
    test(`${label}: under ${maxMs} ms`, { timeout: 60_000 }, async (t) => {
      const r = await timedChild(MEASURE(setup, call), 30_000);
      assert.equal(r.killed, undefined, `killed: ${r.killed}`);
      assert.ok((r.ms as number) < maxMs, `took ${(r.ms as number).toFixed(1)} ms`);
      t.diagnostic(`${label}: ${(r.ms as number).toFixed(1)} ms`);
    });
  }
});
