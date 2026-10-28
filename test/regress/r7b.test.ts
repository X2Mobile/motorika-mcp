// Regression tests for fix round 7b (PLAN.md "2026-10-26: fix round 7b"), end to end through the built server.
// Source: the round-7 re-check (docs/reviews/recheck-r7.md): security C1 (secret-e2e.mjs, secret-raw.mjs) and
// correctness C2/W2 (s4e.mjs, s4d.mjs, s4b.mjs), plus W1 (the unavailable marker; its forgery case is in the
// forged-lines matrix). Expectations come from the pages (static text that is never removed, timestamps the
// page records) and from the AC, never from this server's output.
// Run alone, after npm run build:
//   node --import tsx --test --test-concurrency=1 'test/regress/r7b.test.ts'
// Red-first: MOTORIKA_TEST_ENTRY=<old checkout>/dist/index.js runs the same tests against another build.
// Builds from before the 2026-10-28 rename read `x2b.engine` and `X2B_*`, so they miss the planted engine and env cases.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseFindHits, parseHeader, parseSnapshot } from '../support/grammar.ts';
import { assertNoOrphans, startServer, type ServerHandle, type ServerOptions, type ToolResult } from '../support/mcp-client.ts';
import { PASSWORD_LITERAL } from '../support/spec.ts';

const ENTRY = process.env.MOTORIKA_TEST_ENTRY;
const roots: string[] = [];
after(async () => {
  await assertNoOrphans(roots);
});

async function server(label: string, opts: ServerOptions = {}): Promise<ServerHandle> {
  const s = await startServer({ label, ...(ENTRY ? { entry: ENTRY } : {}), ...opts });
  roots.push(s.root);
  return s;
}

type Route = (u: URL) => { status?: number; headers?: Record<string, string>; body?: string; delay?: number } | undefined;

/** One loopback server on 127.0.0.1 (also reachable as localhost: a cross-origin frame is an OOPIF). */
async function pages(route: Route) {
  const srv = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const r = route(u);
    if (!r) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (r.delay !== undefined && r.delay < 0) return; // hangs
    setTimeout(() => {
      res.writeHead(r.status ?? 200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...(r.headers ?? {}) });
      res.end(r.body ?? '');
    }, r.delay ?? 0);
  });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', () => ok()));
  const port = (srv.address() as { port: number }).port;
  return {
    base: `http://127.0.0.1:${port}`,
    other: `http://localhost:${port}`,
    close: () => {
      srv.closeAllConnections();
      srv.close();
    },
  };
}

// ---------------------------------------------------------------------------------------------------------
// C1 (CRITICAL, security): "safeUrl leaks remembered secrets ... a secret next to ', \, ", a space or a control
// gets a %27-style escape glued to it ... Chrome itself pre-encodes the backtick and <> (%60, %3C)."

const SECRET = PASSWORD_LITERAL; // the harness's C7 check also scans every result for it

/** Lenient percent-decoding (valid %XX runs as UTF-8): the review's second oracle. */
const decode = (s: string): string =>
  s.replace(/(?:%[0-9a-fA-F]{2})+/g, (m) => Buffer.from(m.slice(1).split('%').map((h) => parseInt(h, 16))).toString('utf8'));

/** The secret, or a spelling that decodes to it, in a result: never (sec-unit.mjs). */
function assertNoLeak(r: ToolResult, what: string): void {
  const bare = r.text.split('<redacted>').join('');
  assert.ok(!r.text.includes(SECRET) && !decode(bare).includes(SECRET), `${what} leaks the secret:\n${r.text}`);
}

// The password field's value is echoed into the URL by the page, next to characters Chrome keeps raw (round
// 7's encoder made the escape) or encodes itself (Chrome's URL carries the escape). Measured on Chrome 155:
// a fragment keeps ' and \ raw and encodes a space, " < > and `; a query encodes ' and keeps ` and \ raw; a
// path keeps ' raw and encodes ". `want`: how the URL must print, after the page's origin.
const STEPS: { name: string; js: string; want: string }[] = [
  { name: "fragment, ' raw", js: `location.hash = "'" + v() + "'"`, want: '/login#%27<redacted>%27' },
  { name: 'fragment, \\ raw', js: String.raw`location.hash = '\\' + v() + '\\'`, want: '/login#%5C<redacted>%5C' },
  { name: 'fragment, <b> pre-encoded', js: `location.hash = '<b>' + v() + '</b>'`, want: '/login#%3Cb%3E<redacted>%3C/b%3E' },
  { name: 'fragment, ` pre-encoded', js: 'location.hash = "`" + v() + "`"', want: '/login#%60<redacted>%60' },
  { name: 'fragment, space pre-encoded', js: `location.hash = ' ' + v() + ' '`, want: '/login#%20<redacted>%20' },
  { name: 'fragment, %25 from the page', js: `location.hash = '%25' + v() + '%25'`, want: '/login#%25<redacted>%25' },
  { name: "query, ' pre-encoded", js: `history.replaceState(null, '', "/login?q='" + v() + "'")`, want: '/login?q=%27<redacted>%27' },
  { name: 'query, ` raw', js: 'history.replaceState(null, "", "/login?q=`" + v() + "`")', want: '/login?q=%60<redacted>%60' },
  { name: 'query, \\ raw', js: String.raw`history.replaceState(null, '', '/login?q=\\' + v() + '\\')`, want: '/login?q=%5C<redacted>%5C' },
  { name: "path, ' raw", js: `history.replaceState(null, '', "/x'" + v() + "'/login")`, want: "/x%27<redacted>%27/login" },
  { name: 'path, " pre-encoded', js: `history.replaceState(null, '', '/x"' + v() + '"/login')`, want: '/x%22<redacted>%22/login' },
];

const LOGIN = String.raw`<!doctype html><title>login</title>
<input id=p type=password aria-label="Password"><button id=go>go</button><button id=pop>pop</button>
<button id=log onclick="console.error('logged here')">log</button>
<script>
const v = () => document.getElementById('p').value;
window.__steps = {};
document.getElementById('go').onclick = () => window.__steps[window.__step]();
document.getElementById('pop').onclick = () => window.open('/login#"' + v() + '"');
</script>`;

describe('C1: a typed password echoed into a URL is redacted at every printed-URL site', () => {
  test('raw and pre-encoded neighbours in the fragment, query and path: → url, snapshot, read, tabs, wait, network, new tab, not clicked', async () => {
    const http = await pages((u) => {
      if (u.pathname === '/login' || u.pathname.startsWith('/x')) return { body: LOGIN };
      if (u.pathname === '/api') return { body: 'ok' };
      if (u.pathname === '/hang') return { delay: -1 };
      return undefined;
    });
    const s = await server('r7b-c1');
    try {
      await s.ok('navigate', { url: `${http.base}/login`, snapshot: false });
      await s.ok('type', { target: '#p', text: SECRET });
      const at = (want: string) => `${http.base}${want}`;
      for (const step of STEPS) {
        // Back to /login with the field kept (no navigation), then the page echoes the field into its URL.
        await s.ok('evaluate', { script: `history.replaceState(null, '', '/login'); window.__step = 'x'; window.__steps.x = () => { const v = () => document.getElementById('p').value; ${step.js}; }; 1` });
        const c = await s.ok('click', { target: '#go', snapshot: false });
        assertNoLeak(c, `${step.name}: click`);
        assert.ok(c.text.split('\n').includes(`→ url ${at(step.want)}`), `${step.name}: → url ${at(step.want)}\n${c.text}`);
        const snap = await s.ok('snapshot', {});
        assertNoLeak(snap, `${step.name}: snapshot`);
        assert.equal(parseHeader(snap.text.split('\n')[0] ?? '')?.url, at(step.want), `${step.name}: snapshot header\n${snap.text}`);
        const rd = await s.ok('read', {});
        assertNoLeak(rd, `${step.name}: read`);
        assert.equal(parseHeader(rd.text.split('\n')[0] ?? '')?.url, at(step.want), `${step.name}: read header\n${rd.text}`);
        const tabs = await s.ok('tabs', { action: 'list' });
        assertNoLeak(tabs, `${step.name}: tabs list`);
        assert.ok(tabs.text.includes(` ${at(step.want)}`), `${step.name}: tabs list\n${tabs.text}`);
      }
      // The URL is now the last step's; put the fragment case back for the remaining sites.
      await s.ok('evaluate', { script: `history.replaceState(null, '', '/login'); location.hash = "'" + document.getElementById('p').value + "'"; 1` });
      const shows = at('/login#%27<redacted>%27');
      // A timeout error names the tab's URL (dispatcher).
      const w = await s.err('wait', { text: 'never-on-this-page', timeout_ms: 300 });
      assertNoLeak(w, 'wait timeout');
      assert.match(w.text, new RegExp(`the tab shows ${shows.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), w.text);
      // network: the request URL the page fetched.
      await s.ok('evaluate', { script: `fetch("/api?q='" + document.getElementById('p').value + "'").then(() => 1)` });
      const net = await s.ok('network', { pattern: '/api' });
      assertNoLeak(net, 'network');
      assert.ok(net.text.includes(`${http.base}/api?q=%27<redacted>%27`), net.text);
      // console: a message whose location is this page.
      assertNoLeak(await s.ok('click', { target: '#log', snapshot: false }), 'click log');
      assertNoLeak(await s.ok('console', {}), 'console');
      // A popup the page opens: → new tab, then tabs list, then close it.
      const pop = await s.ok('click', { target: '#pop', snapshot: false });
      assertNoLeak(pop, 'popup');
      assert.match(pop.text, /^→ new tab t\d+ http:\/\/127\.0\.0\.1:\d+\/login#%22<redacted>%22$/m, pop.text);
      assertNoLeak(await s.ok('tabs', { action: 'list' }), 'tabs list with the popup');
      const popTab = /→ new tab (t\d+)/.exec(pop.text)?.[1];
      if (popTab) await s.ok('tabs', { action: 'close', tab: popTab });
      await s.ok('tabs', { action: 'select', tab: 't1' });
      // The caller's own URL holding the remembered secret: tabs new, navigate, a navigate timeout.
      const tn = await s.ok('tabs', { action: 'new', url: `${http.base}/login#'${SECRET}'` });
      assertNoLeak(tn, 'tabs new');
      const newTab = /\[(t\d+)\]/.exec(tn.text)?.[1];
      if (newTab) await s.ok('tabs', { action: 'close', tab: newTab });
      await s.ok('tabs', { action: 'select', tab: 't1' });
      assertNoLeak(await s.ok('navigate', { url: `${http.base}/login?n=1#'${SECRET}'`, snapshot: false }), 'navigate');
      // userinfo: Chrome 155 encodes ' there (measured), so the escape comes from Chrome.
      const ui = await s.ok('navigate', { url: http.base.replace('http://', `http://u:'${SECRET}'@`) + '/login', snapshot: false });
      assertNoLeak(ui, 'navigate with userinfo');
      assert.match(ui.text, /^\[t1\] navigated http:\/\/u:%27<redacted>%27@127\.0\.0\.1:\d+\/login /, ui.text);
      const nt = await s.err('navigate', { url: `${http.base}/hang?q='${SECRET}'`, timeout_ms: 800 });
      assertNoLeak(nt, 'navigate timeout');
      assert.match(nt.text, /\/hang\?q=%27<redacted>%27/, nt.text);
      // "not clicked": the click waits behind a 2.1 s call on this tab, so its deadline (300 + 1900 ms) leaves no
      // time for it (5 of 5 in ~/x2b-r7b-repro/sec/notclicked.mjs; c052783 printed the secret there 5 of 5).
      await s.ok('navigate', { url: `${http.base}/login`, snapshot: false });
      await s.ok('type', { target: '#p', text: SECRET });
      await s.ok('evaluate', { script: `location.hash = "'" + document.getElementById('p').value + "'"; 1` });
      const hold = s.call('evaluate', { script: 'new Promise((r) => setTimeout(() => r(1), 2100))' });
      await sleep(50);
      const nc = await s.call('click', { target: '#go', timeout_ms: 300, snapshot: false });
      await hold;
      assertNoLeak(nc, 'not clicked');
      assert.equal(nc.isError, true, nc.text);
      assert.match(nc.text, /: not clicked: the call waited behind earlier calls on this tab until no time was left; the tab shows http:\/\/127\.0\.0\.1:\d+\/login#%27<redacted>%27$/m, nc.text);
    } finally {
      await s.close();
      http.close();
    }
  });

  test("read in a data: frame the page built from the password: the header's URL is redacted", async () => {
    const http = await pages((u) => (u.pathname === '/login' ? { body: LOGIN } : undefined));
    const s = await server('r7b-c1-data');
    try {
      await s.ok('navigate', { url: `${http.base}/login`, snapshot: false });
      await s.ok('type', { target: '#p', text: SECRET });
      await s.ok('evaluate', {
        script: `const f = document.createElement('iframe'); f.src = 'data:text/html,<button>InData</button> <b>' + document.getElementById('p').value + '</b> "q"'; document.body.append(f); 1`,
      });
      await s.ok('wait', { text: 'InData', timeout_ms: 5000 });
      const snap = await s.ok('snapshot', {});
      assertNoLeak(snap, 'snapshot with the data: frame');
      const ref = /button "InData" (e\d+)/.exec(snap.text)?.[1];
      assert.ok(ref, snap.text);
      const rd = await s.ok('read', { target: ref });
      assertNoLeak(rd, 'read in the data: frame');
      assert.equal(parseHeader(rd.text.split('\n')[0] ?? '')?.url, 'data:text/html,%3Cbutton%3EInData%3C/button%3E%20%3Cb%3E<redacted>%3C/b%3E%20%22q%22', rd.text);
    } finally {
      await s.close();
      http.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------
// C2 (CRITICAL, correctness): "a frame that does not answer within its 500 ms budget counts as absent": wait
// text_gone reported the text gone after ~502 ms while it was on the page (10/10, busy child or busy main),
// find returned 0 hits with no note when the match was in a busy frame (s4e.mjs, s4d.mjs).

/**
 * A cross-origin frame (an OOPIF) that keeps its main thread busy on request, with static text that is never
 * removed unless asked, and a video. It reports when it removed its text.
 */
const BUSY_FRAME = `<!doctype html><title>bf</title><h1 id=t>BUSYFRAMEOK</h1><p id=g>GONESOON</p><video width=160 height=90></video>
<script>addEventListener('message', (e) => {
  const d = e.data || {};
  if (!d.busy) return;
  const t = Date.now();
  while (Date.now() - t < d.busy);
  if (d.remove) { document.getElementById('g').remove(); parent.postMessage({ removedAt: Date.now() }, '*'); }
});</script>`;
const MAIN = (other: string) => `<!doctype html><title>main</title><h1>MAINOK</h1><p id=g>GONESOON</p>
<iframe src="${other}/bf" style="width:400px;height:300px"></iframe>
<script>addEventListener('message', (e) => { if (e.data && e.data.removedAt) window.__childRemovedAt = e.data.removedAt; });</script>`;

async function busyPage() {
  const http = await pages((u) => {
    if (u.pathname === '/bf') return { body: BUSY_FRAME };
    if (u.pathname === '/main') return { body: MAIN(http.other) };
    return undefined;
  });
  return http;
}

const UNAVAILABLE = /1 of 2 frames unavailable \(no answer within 500 ms\): f\d+/;

describe('C2: a frame that does not answer is never "absent"', () => {
  test('wait text_gone does not succeed while the text is in a busy frame (child, then main); it names the frame', async () => {
    const http = await busyPage();
    const s = await server('r7b-c2-gone');
    try {
      for (const [where, trigger, text] of [
        ['child', `frames[0].postMessage({ busy: 3000 }, '*'); 1`, 'BUSYFRAMEOK'],
        ['main', `setTimeout(() => { const t = Date.now(); while (Date.now() - t < 3000); }, 50); 1`, 'MAINOK'],
      ] as const) {
        await s.ok('navigate', { url: `${http.base}/main`, snapshot: false });
        await s.ok('wait', { text: 'BUSYFRAMEOK', timeout_ms: 5000 }); // the frame is loaded
        await s.ok('evaluate', { script: trigger });
        await sleep(150);
        const w = await s.call('wait', { text_gone: text, timeout_ms: 1500 });
        // The page never removes this text: any success is false.
        assert.equal(w.isError, true, `${where}: wait text_gone succeeded while the text is on the page:\n${w.text}`);
        assert.match(w.text, new RegExp(`wait for text "${text}" to disappear timed out after 1500ms; ${UNAVAILABLE.source}`), `${where}:\n${w.text}`);
        assert.ok(w.ms >= 1500, `${where}: answered after ${w.ms} ms, before its timeout`);
        await sleep(3200); // the busy period ends
      }
    } finally {
      await s.close();
      http.close();
    }
  });

  test('wait text_gone asks a busy frame again: it succeeds only after that frame answered without the text', async () => {
    const http = await busyPage();
    const s = await server('r7b-c2-retry');
    try {
      await s.ok('navigate', { url: `${http.base}/main`, snapshot: false });
      await s.ok('wait', { text: 'BUSYFRAMEOK', timeout_ms: 5000 });
      // The main frame drops its copy at once; the child is busy 1.2 s and drops its copy right after.
      await s.ok('evaluate', { script: `document.getElementById('g').remove(); frames[0].postMessage({ busy: 1200, remove: true }, '*'); 1` });
      const w = await s.ok('wait', { text_gone: 'GONESOON', timeout_ms: 6000 });
      const doneAt = Date.now();
      // The page's own record of when the busy frame removed its copy (it may come after a premature answer).
      let removedAt: number | null = null;
      for (let i = 0; i < 40 && typeof removedAt !== 'number'; i++) {
        removedAt = await s.state<number | null>('window.__childRemovedAt ?? null');
        if (typeof removedAt !== 'number') await sleep(100);
      }
      assert.ok(typeof removedAt === 'number', `the child never reported its removal: ${removedAt}`);
      assert.ok(doneAt >= removedAt, `"gone" was answered ${removedAt - doneAt} ms before the busy frame removed the text:\n${w.text}`);
    } finally {
      await s.close();
      http.close();
    }
  });

  test('wait text succeeds from an answering frame while another frame is busy', async () => {
    const http = await busyPage();
    const s = await server('r7b-c2-appear');
    try {
      await s.ok('navigate', { url: `${http.base}/main`, snapshot: false });
      await s.ok('wait', { text: 'BUSYFRAMEOK', timeout_ms: 5000 });
      await s.ok('evaluate', { script: `frames[0].postMessage({ busy: 3000 }, '*'); 1` });
      await sleep(150);
      await s.ok('wait', { text: 'MAINOK', timeout_ms: 2000 });
      await sleep(3000);
    } finally {
      await s.close();
      http.close();
    }
  });

  test('find returns the answering frames\' hits and names the busy frame; 0 hits there is not a clean 0', async () => {
    const http = await busyPage();
    const s = await server('r7b-c2-find');
    try {
      await s.ok('navigate', { url: `${http.base}/main`, snapshot: false });
      await s.ok('wait', { text: 'BUSYFRAMEOK', timeout_ms: 5000 });
      await s.ok('evaluate', { script: `frames[0].postMessage({ busy: 3000 }, '*'); 1` });
      await sleep(150);
      const both = await s.ok('find', { query: 'OK' });
      const lines = both.text.split('\n');
      assert.match(lines[0] ?? '', /^\[t1\] find "OK": 1 hit; 1 frame unavailable \(untrusted page content\)$/, both.text);
      assert.match(lines[1] ?? '', /^not searched: 1 frame unavailable \(no answer within 500 ms\): f\d+; find again, or snapshot$/, both.text);
      assert.deepEqual(parseFindHits(both.text).map((h) => h.el.name), ['MAINOK'], both.text);
      const zero = await s.ok('find', { query: 'BUSYFRAMEOK' });
      assert.match(zero.text, /^\[t1\] find "BUSYFRAMEOK": 0 hits; 1 frame unavailable \(untrusted page content\)\nnot searched: /, zero.text);
      assert.doesNotMatch(zero.text, /no matches/, zero.text);
      await sleep(3000);
      const later = await s.ok('find', { query: 'BUSYFRAMEOK' });
      assert.match(later.text, /^\[t1\] find "BUSYFRAMEOK": 1 hit \(untrusted page content\)$/m, later.text);
    } finally {
      await s.close();
      http.close();
    }
  });

  test('video list: a busy frame holding the only video is not "0 videos"', async () => {
    const http = await busyPage();
    const s = await server('r7b-c2-video');
    try {
      await s.ok('navigate', { url: `${http.base}/main`, snapshot: false });
      await s.ok('wait', { text: 'BUSYFRAMEOK', timeout_ms: 5000 });
      await s.ok('evaluate', { script: `frames[0].postMessage({ busy: 3000 }, '*'); 1` });
      await sleep(150);
      const v = await s.ok('video', { action: 'list' });
      assert.match(v.text, /^\[t1\] 0 videos on the page \(searched 2 frames; 1 frame unavailable \(no answer within 500 ms\): f\d+\); /, v.text);
      await sleep(3000);
    } finally {
      await s.close();
      http.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------
// W2: "a working frame that contains a hanging child frame shows as (frame unavailable)" (s4b.mjs). W1: the
// marker is an attribute only the server prints.

describe('W2: a frame that answers shows its content; only its hanging child is marked', () => {
  test('cross-origin and same-origin frames holding a scriptless about:blank#x child', async () => {
    const http = await pages((u) => {
      if (u.pathname === '/outer') return { body: '<title>o</title><h2>OUTEROK</h2><iframe src="about:blank#x" sandbox></iframe>' };
      if (u.pathname === '/nested') return { body: `<title>n</title><h1>MAINOK</h1><iframe src="${http.other}/outer"></iframe>` };
      if (u.pathname === '/nested-same') return { body: '<title>n</title><h1>MAINOK</h1><iframe src="/outer"></iframe>' };
      return undefined;
    });
    const s = await server('r7b-w2', { flags: ['--action-timeout', '1500'] });
    try {
      for (const path of ['/nested', '/nested-same']) {
        await s.ok('navigate', { url: `${http.base}${path}`, snapshot: false });
        await s.ok('wait', { text: 'OUTEROK', timeout_ms: 5000 });
        const r = await s.ok('snapshot', {});
        assert.ok(r.ms < 2500, `${path}: snapshot took ${r.ms} ms`);
        const snap = parseSnapshot(r.text);
        assert.deepEqual(snap.errors, [], r.text);
        const outerHeading = snap.elements.find((e) => e.role === 'heading' && e.name === 'OUTEROK');
        assert.ok(outerHeading, `${path}: the answering frame's own content is missing:\n${r.text}`);
        const marked = snap.elements.filter((e) => e.attrs.unavailable === true);
        assert.equal(marked.length, 1, `${path}: exactly the hanging frame is marked:\n${r.text}`);
        const hanging = marked[0]!;
        assert.equal(hanging.role, 'iframe', r.text);
        assert.match(hanging.attrs.frame ?? '', /^f\d+$/, r.text);
        const parent = snap.lines[hanging.parent];
        assert.ok(parent && parent.kind === 'element' && parent.role === 'iframe' && parent.attrs.unavailable !== true, `${path}: the marked frame sits under the answering one:\n${r.text}`);
        assert.equal(snap.lines[outerHeading.parent], parent, `${path}: OUTEROK is the answering frame's content:\n${r.text}`);
      }
    } finally {
      await s.close();
      http.close();
    }
  });
});
