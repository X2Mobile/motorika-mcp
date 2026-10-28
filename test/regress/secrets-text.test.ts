// Secrets in text paths (PLAN.md "2026-10-26: secrets in text paths"), end to end through Chrome and the built
// server. Source: the round-7b re-check backlog, ~/x2b-r7brc-sec/text-paths.mjs (read links, console text, evaluate
// results), unit-pairs.mjs (two touching secrets) and perf-e2e.mjs (a 1000-char secret, a 2 MB fragment).
// Oracle: test/support/leak-oracle.ts (the secret as a whole token in any piece of a result, raw or decoded, a
// `%XX` escape next to it counting as an edge) and wall times, never this server's own output.
// Run alone, after npm run build:
//   node --import tsx --test --test-concurrency=1 'test/regress/secrets-text.test.ts'
// Red-first: MOTORIKA_TEST_ENTRY=<old checkout>/dist/index.js runs the same tests against another build.
// Builds from before the 2026-10-28 rename read `x2b.engine` and `X2B_*`, so they miss the planted engine and env cases.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, describe, test } from 'node:test';
import { performance } from 'node:perf_hooks';
import { leak, R } from '../support/leak-oracle.ts';
import { assertNoOrphans, startServer, type ServerHandle, type ToolResult } from '../support/mcp-client.ts';

const ENTRY = process.env.MOTORIKA_TEST_ENTRY;
const roots: string[] = [];
after(async () => {
  await assertNoOrphans(roots);
});

async function server(label: string): Promise<ServerHandle> {
  const s = await startServer({ label, ...(ENTRY ? { entry: ENTRY } : {}) });
  roots.push(s.root);
  return s;
}

/** One loopback server; routes map a path to an HTML body. */
async function pages(routes: Record<string, string>) {
  const srv = createServer((req, res) => {
    const body = routes[new URL(req.url ?? '/', 'http://x').pathname];
    if (body === undefined) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
  });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', () => ok()));
  const port = (srv.address() as { port: number }).port;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => {
      srv.closeAllConnections();
      srv.close();
    },
  };
}

function assertNoLeak(r: ToolResult, secret: string, what: string): void {
  const at = leak(r.text, secret);
  assert.equal(at, null, `${what} shows ${JSON.stringify(secret)} in ${JSON.stringify(at)}:\n${r.text.slice(0, 3000)}`);
}

// ---------------------------------------------------------------------------------------------------------
// AC1 (priority finding): text-paths.mjs. The page echoes the typed password into link hrefs, a console message,
// visible text and its own URL; Chrome writes the URL spellings (' as %27 in a query, < > as %3C %3E in a fragment).

const TP = String.raw`<!doctype html><title>tp</title><input id="p" type="password" aria-label="pw"><button id="go">go</button><main id="box"><h1>Links</h1></main>
<script>
document.getElementById('go').addEventListener('click', () => {
  const v = document.getElementById('p').value;
  const box = document.getElementById('box');
  const add = (h, t) => { const p = document.createElement('p'); const a = document.createElement('a'); a.href = h; a.textContent = t; p.appendChild(a); box.appendChild(p); };
  add("/r?q='" + v + "'", 'query-quote');
  add('/r?q=' + v, 'query-plain');
  add("/r#'" + v + "'", 'hash-quote');
  add('/r#<' + v + '>', 'hash-angle');
  const u = new URL("/r?q='" + v + "'", location.href).href;
  console.warn('href ' + u);
  const t = document.createElement('p'); t.textContent = 'visible ' + u; box.appendChild(t);
  history.replaceState(null, '', "/tp?q='" + v + "'");
});
</script>`;

describe('AC1: a typed password echoed next to escapes is redacted in read, console and evaluate (text-paths.mjs)', () => {
  for (const secret of ['Hunter2xZ', "O'Brien!26", 'Hu"nt\\er2!']) {
    test(`secret ${JSON.stringify(secret)}: read links and text, console, evaluate, snapshot, find, tabs, the click's effect lines`, async () => {
      const http = await pages({ '/tp': TP });
      const s = await server('st-tp');
      try {
        await s.ok('navigate', { url: `${http.base}/tp`, snapshot: false });
        await s.ok('type', { target: '#p', text: secret, snapshot: false });
        const click = await s.ok('click', { target: '#go', snapshot: false });
        assertNoLeak(click, secret, 'click');
        const outs: [string, ToolResult][] = [
          ['read', await s.ok('read', {})],
          ['console', await s.ok('console', { level: 'warning' })],
          ['evaluate location.href', await s.ok('evaluate', { script: 'location.href' })],
          ['evaluate link hrefs', await s.ok('evaluate', { script: '[...document.links].map((a) => a.href)' })],
          ['evaluate text', await s.ok('evaluate', { script: 'document.getElementById("box").innerText' })],
          ['snapshot', await s.ok('snapshot', {})],
          ['find', await s.ok('find', { query: 'visible' })],
          ['tabs', await s.ok('tabs', { action: 'list' })],
        ];
        for (const [what, r] of outs) assertNoLeak(r, secret, what);
        // The text paths of the finding print a marker where the secret was (the redaction is visible, not silent).
        for (const [what, r] of outs.slice(0, 3)) assert.ok(r.text.includes(R), `${what} has no ${R}:\n${r.text}`);
      } finally {
        await s.close();
        http.close();
      }
    });
  }
});

// ---------------------------------------------------------------------------------------------------------
// Fix round 2 (docs/reviews/review-secret-text-paths.md), C1: through the real read, console and evaluate tools, a
// secret-named parameter after the redacted password never prints (the reviewer's prescrub.mjs and urlnet.mjs shapes;
// the page writes the %27 itself, as a page or a server would).

const C1PAGE = String.raw`<!doctype html><title>c1</title><input id="p" type="password" aria-label="pw"><button id="go">go</button><main id="box"></main>
<script>
document.getElementById('go').addEventListener('click', () => {
  const v = document.getElementById('p').value;
  const box = document.getElementById('box');
  const shapes = [
    '/r?q=%27' + v + '%27&token=TOKVAL1',
    '/r?q=' + v + '&token=TOKVAL2',
    '/r#q=%27' + v + '%27&access_token=TOKVAL3',
    '/a?q=!' + v + '!http://b.test/?token=TOKVAL4',
    '/a?q=%27' + v + '%27&next=http://b.test/&token=TOKVAL5',
  ];
  for (const sh of shapes) {
    const u = new URL(sh, location.href).href;
    const a = document.createElement('a'); a.href = sh; a.textContent = 'link'; const li = document.createElement('p'); li.appendChild(a); box.appendChild(li);
    console.warn('href ' + u);
  }
  history.replaceState(null, '', shapes[0]);
});
</script>`;

describe('C1 (round 2): secret-named parameters after the redacted password stay hidden in read, console and evaluate', () => {
  for (const secret of ['Hunter2xZ', "O'Brien!26"]) {
    test(`secret ${JSON.stringify(secret)}`, async () => {
      const http = await pages({ '/tp': C1PAGE });
      const s = await server('st-c1');
      try {
        await s.ok('navigate', { url: `${http.base}/tp`, snapshot: false });
        await s.ok('type', { target: '#p', text: secret, snapshot: false });
        const outs: [string, ToolResult][] = [
          ['click', await s.ok('click', { target: '#go', snapshot: false })],
          ['read', await s.ok('read', {})],
          ['console', await s.ok('console', { level: 'warning' })],
          ['evaluate location.href', await s.ok('evaluate', { script: 'location.href' })],
          ['evaluate link hrefs', await s.ok('evaluate', { script: '[...document.links].map((a) => a.href)' })],
          ['tabs', await s.ok('tabs', { action: 'list' })],
        ];
        for (const [what, r] of outs) {
          assertNoLeak(r, secret, what);
          const tok = /TOKVAL\d/.exec(r.text);
          assert.equal(tok, null, `${what} prints ${tok?.[0]}:\n${r.text.slice(0, 3000)}`);
        }
        for (const [what, r] of outs.slice(1, 4)) assert.ok(r.text.includes(R), `${what} has no ${R}:\n${r.text}`);
      } finally {
        await s.close();
        http.close();
      }
    });
  }
});

// Fix round 2, W1: a password with an emoji, which the page echoes as JSON with surrogate-pair escapes.
const W1PAGE = String.raw`<!doctype html><title>w1</title><input id="p" type="password" aria-label="pw"><button id="go">go</button><main id="box"></main>
<script>
document.getElementById('go').addEventListener('click', () => {
  const v = document.getElementById('p').value;
  const esc = [...v].map((ch) => (ch.length === 2 ? '\\u' + ch.charCodeAt(0).toString(16) + '\\u' + ch.charCodeAt(1).toString(16) : ch)).join('');
  const line = '{"pw":"' + esc + '","n":1}';
  console.warn(line);
  document.getElementById('box').textContent = 'echo ' + line;
});
</script>`;

describe('W1 (round 2): a password with an emoji, echoed as JSON surrogate escapes, is redacted in read and console', () => {
  test('Smile + U+1F600 + 42', async () => {
    const secret = `Smile${String.fromCodePoint(0x1f600)}42`;
    const http = await pages({ '/w1': W1PAGE });
    const s = await server('st-w1');
    try {
      await s.ok('navigate', { url: `${http.base}/w1`, snapshot: false });
      await s.ok('fill_form', { fields: [{ target: '#p', value: secret }] });
      await s.ok('click', { target: '#go', snapshot: false });
      for (const [what, r] of [
        ['read', await s.ok('read', {})],
        ['console', await s.ok('console', { level: 'warning' })],
      ] as const) {
        assertNoLeak(r, secret, what);
        assert.ok(r.text.includes(`"pw":"${R}"`), `${what}:\n${r.text}`);
      }
    } finally {
      await s.close();
      http.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------
// AC4: two remembered secrets that touch (Chrome encodes é) or overlap, typed in either order (unit-pairs.mjs).

const PAIR = String.raw`<!doctype html><title>pair</title>
<input id="p1" type="password" aria-label="one"><input id="p2" type="password" aria-label="two"><button id="go">go</button><main id="box"></main>
<script>
document.getElementById('go').addEventListener('click', () => {
  const a = document.getElementById('p1').value, b = document.getElementById('p2').value;
  const body = window.__overlap ? a + b.slice(window.__overlap) : a + b;
  location.hash = "'" + body + "'";
  console.warn('pair ' + location.href);
  const l = document.createElement('a'); l.href = "/x?q='" + body + "'"; l.textContent = 'pair link'; document.getElementById('box').appendChild(l);
});
</script>`;

describe('AC4: touching and overlapping secrets are both redacted, typed in either order', () => {
  const CASES: [label: string, a: string, b: string, overlap: number][] = [
    ['touching (Hunter2é then Zebra99!, é encoded by Chrome)', 'Hunter2é', 'Zebra99!', 0],
    ['overlapping at 2xZ', 'Hunter2xZ', '2xZ!Pass99', 3],
  ];
  for (const [label, a, b, overlap] of CASES) {
    test(label, async () => {
      const http = await pages({ '/pair': PAIR });
      const s = await server('st-pair');
      try {
        for (const order of [['#p1', '#p2'], ['#p2', '#p1']] as const) {
          await s.ok('navigate', { url: `${http.base}/pair`, snapshot: false });
          await s.ok('evaluate', { script: `window.__overlap = ${overlap}; 1` });
          for (const target of order) await s.ok('type', { target, text: target === '#p1' ? a : b, snapshot: false });
          const outs: [string, ToolResult][] = [
            ['click', await s.ok('click', { target: '#go', snapshot: false })],
            ['read', await s.ok('read', {})],
            ['console', await s.ok('console', { level: 'warning', clear: true })],
            ['evaluate', await s.ok('evaluate', { script: '[location.href, document.links[0] && document.links[0].href]' })],
            ['tabs', await s.ok('tabs', { action: 'list' })],
          ];
          for (const [what, r] of outs) {
            assertNoLeak(r, a, `${order.join(' then ')}: ${what}`);
            assertNoLeak(r, b, `${order.join(' then ')}: ${what}`);
          }
        }
      } finally {
        await s.close();
        http.close();
      }
    });
  }
});

// ---------------------------------------------------------------------------------------------------------
// AC5: bounded cost, and other calls are not blocked (perf-e2e.mjs: c052783 17 ms, round 7b 11 s for `tabs`).

const PF = String.raw`<!doctype html><title>pf</title><input id="p" type="password" aria-label="pw"><button id="go">go</button>
<script>document.getElementById('go').addEventListener('click', () => { history.replaceState(null, '', '/pf#' + 'a'.repeat(2 * 1024 * 1024 - 200)); });</script>`;

describe('AC5: a 1000-char secret and a 2 MB fragment', () => {
  test('the click, tabs list and a concurrent evaluate each answer within 1 s', { timeout: 180_000 }, async (t) => {
    const http = await pages({ '/pf': PF });
    const s = await server('st-pf');
    try {
      await s.ok('navigate', { url: `${http.base}/pf`, snapshot: false });
      await s.ok('fill_form', { fields: [{ target: '#p', value: 'a'.repeat(1000) }] });
      let t0 = performance.now();
      await s.ok('click', { target: '#go', snapshot: false });
      const clickMs = performance.now() - t0;
      await s.ok('tabs', { action: 'list' }); // warm
      t0 = performance.now();
      const tabs = s.ok('tabs', { action: 'list' });
      await new Promise((r) => setTimeout(r, 50));
      const e0 = performance.now();
      const ev = await s.ok('evaluate', { script: '1', tab: 't1' });
      const evMs = performance.now() - e0;
      await tabs;
      const tabsMs = performance.now() - t0;
      t.diagnostic(`click ${clickMs.toFixed(0)} ms, tabs list ${tabsMs.toFixed(0)} ms, concurrent evaluate ${evMs.toFixed(0)} ms`);
      assert.match(ev.text, /\n1$/);
      assert.ok(clickMs < 1000, `click took ${clickMs.toFixed(0)} ms`);
      assert.ok(tabsMs < 1000, `tabs list took ${tabsMs.toFixed(0)} ms`);
      assert.ok(evMs < 1000, `a concurrent evaluate waited ${evMs.toFixed(0)} ms`);
    } finally {
      await s.close();
      http.close();
    }
  });
});
