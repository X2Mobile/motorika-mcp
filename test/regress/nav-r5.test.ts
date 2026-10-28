// Regression tests for fix round 5, navigation (PLAN.md "2026-10-23: fix round 5 (nav)"). Every expectation
// comes from the brief's acceptance criteria or the independent re-check's repro scripts (/tmp/x2b-r4rc/t/:
// d1v.mjs, c1e.mjs, d1r.mjs, r6.mjs), never from this server's own output: "the tab moved" is read from the
// page (location) and the HTTP server's own hit log. Run alone, after npm run build:
//   MOTORIKA_TEST_ROOT=/tmp/motorika-r5n node --import tsx --test --test-concurrency=1 'test/regress/nav-r5.test.ts'
// Red-first: MOTORIKA_TEST_ENTRY=<old checkout>/dist/index.js runs the same tests against another build.
// Builds from before the 2026-10-28 rename read `x2b.engine` and `X2B_*`, so they miss the planted engine and env cases.
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { after, describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { tabIdOf, parseTabsList } from '../support/grammar.ts';
import { assertNoOrphans, startServer, type ServerHandle, type ServerOptions } from '../support/mcp-client.ts';

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

const HINT_CRASH = 'hint: close it with tabs close, or open a new tab with tabs new';

/**
 * One loopback HTTP server with a hit log per path:
 * - `/never`: headers and the start of the body at once, then never the end (d1v.mjs, d1r.mjs): the page
 *   commits, its DOMContentLoaded never fires;
 * - `/hang`: never answers (nothing commits);
 * - `/poll?ms=N`: answers after N ms, then keeps a fetch open (c1e.mjs);
 * - `/ph`: a pagehide handler keeps the renderer busy for `busy` ms, so the next navigation's commit lands
 *   that late although its response arrived at once (the commit-after-stop race, made deterministic);
 * - `/nocontent`: 204 (fails as net::ERR_ABORTED without any crash).
 */
async function pages(extra: Record<string, string> = {}) {
  const hits: Record<string, number> = {};
  const srv = createServer((req, res: ServerResponse) => {
    const u = new URL(req.url ?? '/', 'http://x');
    hits[u.pathname] = (hits[u.pathname] ?? 0) + 1;
    if (u.pathname === '/hang') return;
    if (u.pathname === '/never') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.write(`<title>never</title><h1>never</h1>${' '.repeat(2048)}`);
      return;
    }
    if (u.pathname === '/nocontent') {
      res.writeHead(204);
      res.end();
      return;
    }
    const busy = Number(u.searchParams.get('busy') ?? 900);
    const body =
      extra[u.pathname] ??
      (u.pathname === '/start'
        ? '<!doctype html><title>start</title><h1>start</h1><a id=go href="/poll?ms=100">go poll</a>'
        : u.pathname === '/poll'
          ? `<!doctype html><title>poll</title><h1>poll</h1><script>fetch('/hang').catch(()=>{})</script>`
          : u.pathname === '/ph'
            ? `<!doctype html><title>ph</title><h1>ph</h1><script>addEventListener('pagehide',()=>{const t=Date.now();while(Date.now()-t<${busy});})</script>`
            : u.pathname === '/next'
              ? '<!doctype html><title>next</title><h1>next</h1>'
              : undefined);
    if (body === undefined) {
      res.writeHead(404);
      res.end();
      return;
    }
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    }, Number(u.searchParams.get('ms') ?? 0));
  });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', () => ok()));
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  return {
    base,
    hits,
    reset: () => {
      for (const k of Object.keys(hits)) delete hits[k];
    },
    close: () => {
      srv.closeAllConnections();
      srv.close();
    },
  };
}

const STILL_LOADING = /^\(still loading: domcontentloaded not reached in (\d+) ms\)$/m;

// ---------------------------------------------------------------------------------------------------------
// D1 AC2: "a navigation that committed is reported as `[tN] navigated <url> …` with a short note that loading
// did not finish. It is NOT an error." AC3: "an error never invites a retry that navigates twice."
describe('D1 a navigation that committed is a navigation, not an error', () => {
  test('a page whose response never finishes (d1v.mjs /never, d1r.mjs): navigated, a still-loading note, one request', async () => {
    const http = await pages();
    const s = await server('r5never');
    try {
      await s.ok('navigate', { url: `${http.base}/start`, snapshot: false });
      http.reset();
      const r = await s.call('navigate', { url: `${http.base}/never`, timeout_ms: 1500, snapshot: false });
      assert.equal(await s.state<string>('location.href'), `${http.base}/never`, 'the tab is on /never');
      assert.equal(r.isError, false, `the tab is on the page, so this is no error:\n${r.text}`);
      assert.equal(r.text.split('\n')[0], `[t1] navigated ${http.base}/never "never" (200)`);
      const note = STILL_LOADING.exec(r.text);
      assert.ok(note, `the note that loading did not finish:\n${r.text}`);
      assert.ok(Number(note[1]) >= 1400 && Number(note[1]) <= 2000, `the wait that applied (timeout_ms 1500): ${note[1]} ms`);
      // d1r.mjs: nothing in the answer invites a second navigation, and the server saw one request.
      assert.doesNotMatch(r.text, /wait_until=commit|\bretry\b/, r.text);
      assert.equal(http.hits['/never'], 1, JSON.stringify(http.hits));
    } finally {
      await s.close();
      http.close();
    }
  });

  test('the same page queued behind a busy tab (d1v.mjs busy=2500, 3300): navigated, never an error', async () => {
    const http = await pages();
    const s = await server('r5neverq', { flags: ['--action-timeout', '2000'] });
    try {
      for (const busy of [2500, 3300]) {
        await s.ok('navigate', { url: `${http.base}/start`, snapshot: false });
        http.reset();
        const hold = s.call('wait', { ms: busy, timeout_ms: busy + 2000 });
        await sleep(30);
        const t0 = Date.now();
        const r = await s.call('navigate', { url: `${http.base}/never`, timeout_ms: 2000, snapshot: false });
        const ms = Date.now() - t0;
        await hold;
        await sleep(300);
        assert.equal(await s.state<string>('location.pathname'), '/never', `busy=${busy}: the tab is on /never`);
        assert.equal(r.isError, false, `busy=${busy}: the tab is on the page, so this is no error:\n${r.text}`);
        assert.equal(r.text.split('\n')[0], `[t1] navigated ${http.base}/never "never" (200)`, `busy=${busy}`);
        assert.match(r.text, STILL_LOADING, `busy=${busy}: the note that loading did not finish:\n${r.text}`);
        assert.ok(ms < 2000 + 1900, `busy=${busy}: answered after ${ms} ms, past the call deadline`);
        assert.equal(http.hits['/never'], 1, `busy=${busy}: ${JSON.stringify(http.hits)}`);
      }
    } finally {
      await s.close();
      http.close();
    }
  });

  test('reload, back and forward follow the same two phases', async () => {
    const http = await pages();
    const s = await server('r5hist');
    try {
      await s.ok('navigate', { url: `${http.base}/start`, snapshot: false });
      await s.ok('navigate', { url: `${http.base}/never`, timeout_ms: 1000, snapshot: false });
      const rl = await s.call('navigate', { action: 'reload', timeout_ms: 1000, snapshot: false });
      assert.equal(rl.isError, false, `reload of a page that never finishes:\n${rl.text}`);
      assert.equal(rl.text.split('\n')[0], `[t1] navigated ${http.base}/never "never" (200)`);
      assert.match(rl.text, STILL_LOADING, rl.text);
      await s.ok('navigate', { url: `${http.base}/next`, snapshot: false });
      const bk = await s.call('navigate', { action: 'back', timeout_ms: 1000, snapshot: false });
      assert.equal(bk.isError, false, `back to a page that never finishes:\n${bk.text}`);
      assert.equal(bk.text.split('\n')[0], `[t1] navigated ${http.base}/never "never" (200)`);
      assert.match(bk.text, STILL_LOADING, bk.text);
      assert.equal(await s.state<string>('location.pathname'), '/never');
      const fw = await s.ok('navigate', { action: 'forward', timeout_ms: 2000, snapshot: false });
      assert.equal(fw.text.split('\n')[0], `[t1] navigated ${http.base}/next "next" (200)`);
      assert.doesNotMatch(fw.text, /still loading/, 'a page that loads gets no note');
    } finally {
      await s.close();
      http.close();
    }
  });

  test('a commit that lands after the stop (the old page holds its renderer in pagehide): navigated, not an error', async () => {
    const http = await pages();
    const s = await server('r5race');
    try {
      for (let i = 0; i < 3; i++) {
        await s.ok('navigate', { url: `${http.base}/ph?busy=900&i=${i}`, snapshot: false });
        http.reset();
        const r = await s.call('navigate', { url: `${http.base}/next?i=${i}`, timeout_ms: 400, snapshot: false });
        await sleep(1200);
        assert.equal(await s.state<string>('location.href'), `${http.base}/next?i=${i}`, 'the navigation committed');
        assert.equal(r.isError, false, `run ${i}: the tab landed on /next, so this is no error:\n${r.text}`);
        assert.equal(r.text.split('\n')[0], `[t1] navigated ${http.base}/next?i=${i} "next" (200)`, `run ${i}`);
        assert.equal(http.hits['/next'], 1, JSON.stringify(http.hits));
      }
    } finally {
      await s.close();
      http.close();
    }
  });
});

describe('D1 AC3 a navigation that never committed', () => {
  test('is stopped; the error names the URL the tab still shows and never suggests wait_until=commit', async () => {
    const http = await pages();
    const s = await server('r5hang');
    try {
      await s.ok('navigate', { url: `${http.base}/start`, snapshot: false });
      const r = await s.err('navigate', { url: `${http.base}/hang`, timeout_ms: 1000, snapshot: false });
      const [cause, hint] = r.text.split('\n');
      assert.match(cause ?? '', /timed out after 1000ms/, r.text);
      assert.ok((cause ?? '').endsWith(`the tab shows ${http.base}/start`), r.text);
      assert.equal(hint, `hint: stopped before it committed; the tab still shows ${http.base}/start; retrying requests the page again (a larger timeout_ms gives the server more time)`);
      assert.doesNotMatch(r.text, /wait_until=commit/, r.text);
      await sleep(1500);
      assert.equal(await s.state<string>('location.href'), `${http.base}/start`, 'the stopped navigation never lands');
    } finally {
      await s.close();
      http.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------
// R6 (r6.mjs): "a navigate that crashes the tab answers `tab tN crashed` with its hint", not net::ERR_ABORTED.
describe('R6 a navigate that crashes the tab', () => {
  test('chrome://crash answers "tab tN crashed" with its hint; a 204 is still ERR_ABORTED and no crash', async () => {
    const http = await pages();
    const s = await server('r5crash', { flags: ['--allow-chrome-urls'] });
    try {
      const tid = tabIdOf((await s.ok('tabs', { action: 'new', url: `${http.base}/start` })).text);
      assert.ok(tid);
      const r = await s.err('navigate', { url: 'chrome://crash', tab: tid, timeout_ms: 5000 });
      assert.equal(r.text.split('\n')[0], `[${tid}] tab ${tid} crashed`, r.text);
      assert.ok(r.text.split('\n').includes(HINT_CRASH), r.text);
      const line = parseTabsList((await s.ok('tabs', { action: 'list' })).text).find((x) => x.id === tid);
      assert.equal(line?.crashed, true, line?.raw);
      await s.ok('tabs', { action: 'close', tab: tid });

      // Guard: a 204 also fails as ERR_ABORTED; the renderer answers, so it is no crash and costs little.
      const t2 = tabIdOf((await s.ok('tabs', { action: 'new', url: `${http.base}/start` })).text);
      const nc = await s.err('navigate', { url: `${http.base}/nocontent`, tab: t2, timeout_ms: 5000 });
      assert.match(nc.text, /failed: net::ERR_ABORTED/, nc.text);
      assert.ok(nc.ms < 1500, `a 204 answered after ${nc.ms} ms`);
      await s.ok('snapshot', { tab: t2 });
    } finally {
      await s.close();
      http.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------
// Nit: "a click whose navigation commits after the deadline cut prints no `→ navigated` line. The settle note
// does appear." Shape: d1v.mjs click:#go with the tab busy for 3300 ms of the click's 3.9 s deadline.
describe('nit: a click whose navigation commits after the deadline cut', () => {
  test('reports → navigated', async () => {
    const http = await pages();
    const s = await server('r5click', { flags: ['--action-timeout', '2000'] });
    try {
      await s.ok('navigate', { url: `${http.base}/start`, snapshot: false });
      const hold = s.call('wait', { ms: 3300, timeout_ms: 5300 });
      await sleep(30);
      const c = await s.call('click', { target: '#go', timeout_ms: 2000 });
      await hold;
      await sleep(500);
      assert.equal(await s.state<string>('location.pathname'), '/poll', 'the click navigated');
      assert.equal(c.isError, false, c.text);
      assert.match(c.text, /settle incomplete/, `the deadline cut settle short (the scenario):\n${c.text}`);
      assert.match(c.text, new RegExp(`^→ navigated ${http.base.replace(/[.]/g, '\\.')}/poll\\?ms=100 "(?:poll)?" \\(200\\)$`, 'm'), c.text);
    } finally {
      await s.close();
      http.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------
// Nit (D5): "a real role=alert whose text equals the title is dropped. Only aria-live route announcers that
// are not role=alert should be skipped."
describe('nit (D5): a role=alert with the title text', () => {
  test('is reported; an aria-live route announcer with the title text is still not', async () => {
    const page = `<!doctype html><title>Session expired</title>
<faceplate-screen-reader-content aria-live="assertive" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)"></faceplate-screen-reader-content>
<button id=announce onclick="document.querySelector('faceplate-screen-reader-content').textContent=document.title">Announce</button>
<button id=expire onclick="document.getElementById('msg').textContent='Session expired'">Expire</button>
<div id=msg role=alert></div>`;
    const http = await pages({ '/alert': page });
    const s = await server('r5alert');
    try {
      // Each on a fresh document: a live text already shown before the click is never "new".
      await s.ok('navigate', { url: `${http.base}/alert`, snapshot: false });
      const announced = await s.ok('click', { target: '#announce' });
      assert.doesNotMatch(announced.text, /^→ alert /m, `a route announcer is not an alert:\n${announced.text}`);
      await s.ok('navigate', { url: `${http.base}/alert?2`, snapshot: false });
      const expired = await s.ok('click', { target: '#expire' });
      assert.match(expired.text, /^→ alert "Session expired"$/m, `a real role=alert is reported:\n${expired.text}`);
    } finally {
      await s.close();
      http.close();
    }
  });
});
