// Regression tests for fix round 4, implementer A (PLAN.md "2026-10-23: fix round 4 (A)"; brief D1, D2, D3, D5).
// Every expectation comes from the brief's acceptance criteria or a reviewer scenario (c1e.mjs, c1.mjs, the
// www.reddit.com feedback), never from this server's own output. Run alone, after npm run build:
//   MOTORIKA_TEST_ROOT=/tmp/motorika-r4a node --import tsx --test --test-concurrency=1 'test/regress/core-r4.test.ts'
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { after, describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { assertNoOrphans, startServer, type ServerHandle, type ServerOptions } from '../support/mcp-client.ts';
// @ts-expect-error -- a plain .mjs fixture (the security reviewer's fake engine), no type declarations.
import { FRAME, HOST, TOP } from '../fixtures/fake-engine-r3.mjs';

const roots: string[] = [];
after(async () => {
  await assertNoOrphans(roots);
});

async function server(label: string, opts: ServerOptions = {}): Promise<ServerHandle> {
  const s = await startServer({ label, ...opts });
  roots.push(s.root);
  return s;
}

/** One loopback HTTP server; `/hang*` never answers (a request the page keeps open). */
async function pages(route: (u: URL) => string | undefined) {
  const srv = createServer((req, res: ServerResponse) => {
    const u = new URL(req.url ?? '/', 'http://x');
    if (u.pathname.startsWith('/hang')) return;
    const body = route(u);
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
    close: () => {
      srv.closeAllConnections();
      srv.close();
    },
  };
}

const COVER = `<!doctype html><title>cover</title><style>#ov{position:fixed;inset:0;background:rgba(0,0,0,.2)}</style>
<button id=a>Alpha</button><div id=ov></div>`;

/**
 * c1e.mjs / c1.mjs shape: a click on a covered button (timeout_ms 3000) holds the tab; 100 ms later a navigate
 * with timeout_ms 2000 queues behind it. Returns the navigate result, its wall time, and where the tab is
 * once everything has settled.
 */
async function queuedNavigate(s: ServerHandle, base: string, path: string) {
  await s.ok('navigate', { url: `${base}/cover`, snapshot: false });
  const click = s.call('click', { target: '#a', timeout_ms: 3000 });
  await sleep(100);
  const t0 = Date.now();
  const nav = await s.call('navigate', { url: `${base}${path}`, timeout_ms: 2000, snapshot: false });
  const ms = Date.now() - t0;
  await click;
  await sleep(1500);
  const now = await s.state<string>('location.href');
  return { nav, ms, now };
}

// ---------------------------------------------------------------------------------------------------------
// D1 (hard blocker): "a queued navigate to a page that keeps a request open ... AC1 Effects never run past
// the call deadline. AC2 When the deadline hits after the navigation committed, navigate reports the
// navigation, `[tN] navigated <url> …`, with a short note that settle did not finish. It is not an error.
// AC3 Every deadline or timeout error names the tab's current URL, and for navigate never suggests a blind
// retry once the URL has changed. AC4 The error text reports the timeout that actually applied."
describe('D1 a queued navigate to a page that keeps a request open', () => {
  test('/poll queued behind a busy tab: navigated, with a settle note, inside the deadline (c1e.mjs)', async () => {
    const http = await pages((u) =>
      u.pathname === '/cover' ? COVER : u.pathname === '/poll' ? `<title>poll</title><h1>poll</h1><script>fetch('/hang').catch(()=>{})</script>` : undefined,
    );
    const s = await server('d1poll', { flags: ['--action-timeout', '2000'] });
    try {
      const { nav, ms, now } = await queuedNavigate(s, http.base, '/poll?ms=100');
      const url = `${http.base}/poll?ms=100`;
      assert.equal(now, url, 'the tab landed on /poll');
      assert.equal(nav.isError, false, `a committed navigation is not an error:\n${nav.text}`);
      const head = nav.text.split('\n')[0] ?? '';
      assert.equal(head, `[t1] navigated ${url} "poll" (200)`);
      assert.match(nav.text, /settle incomplete/, `the note that settle did not finish:\n${nav.text}`);
      // The deadline is timeout_ms + 1.9 s from arrival (contract Q1, G1); the answer comes before it.
      assert.ok(ms < 2000 + 1900, `answered after ${ms} ms`);
    } finally {
      await s.close();
      http.close();
    }
  });

  test('a busy page (open requests and DOM churn) queued: never an error once it landed, or the error names it (c1.mjs C)', async () => {
    const busy = `<title>busy</title><h1>busy</h1><div id=x></div><script>
fetch('/hang').catch(()=>{}); fetch('/hang2').catch(()=>{});
setInterval(()=>{document.getElementById('x').textContent=Math.random()},50);</script>`;
    const http = await pages((u) => (u.pathname === '/cover' ? COVER : u.pathname === '/busy' ? busy : undefined));
    const s = await server('d1busy', { flags: ['--action-timeout', '2000'] });
    try {
      for (const delay of [100, 400]) {
        const { nav, ms, now } = await queuedNavigate(s, http.base, `/busy?ms=${delay}`);
        assert.ok(ms < 2000 + 1900, `answered after ${ms} ms`);
        if (now.includes('/busy')) {
          // It landed: either the success line, or an error that says where the tab is and does not invite
          // a second navigation.
          if (nav.isError) {
            assert.ok(nav.text.includes(`the tab shows ${now}`), `the error must name the URL the tab shows (${now}):\n${nav.text}`);
            assert.doesNotMatch(nav.text.split('\n')[1] ?? '', /^hint: retry/, nav.text);
          } else {
            assert.equal(nav.text.split('\n')[0], `[t1] navigated ${now} "busy" (200)`);
          }
        } else {
          assert.equal(nav.isError, true, `the tab stayed on ${now} but navigate reported success:\n${nav.text}`);
          assert.ok(nav.text.includes(`the tab shows ${now}`), nav.text);
        }
      }
    } finally {
      await s.close();
      http.close();
    }
  });

  test('a queued navigate that times out reports the timeout that applied, not timeout_ms (c1.mjs A)', async () => {
    const http = await pages((u) => (u.pathname === '/cover' ? COVER : u.pathname === '/slow' ? '<title>slow</title>slow done' : undefined));
    const s = await server('d1slow', { flags: ['--action-timeout', '2000'] });
    try {
      const { nav, now } = await queuedNavigate(s, http.base, '/slow?ms=1400');
      assert.equal(nav.isError, true, nav.text);
      const applied = /timed out after (\d+)ms/.exec(nav.text);
      assert.ok(applied, nav.text);
      // Queued for about 3 s of a 3.9 s deadline: what applied is well under the nominal 2000 ms.
      assert.ok(Number(applied[1]) < 2000, `reported ${applied[1]} ms, the nominal timeout_ms:\n${nav.text}`);
      assert.ok(nav.text.includes(`the tab shows ${now}`), `the error names the URL the tab shows (${now}):\n${nav.text}`);
    } finally {
      await s.close();
      http.close();
    }
  });
});

describe('D1 AC3/AC4 for wait', () => {
  test('a queued wait that times out reports the time that applied and the URL the tab shows', async () => {
    const http = await pages((u) => (u.pathname === '/cover' ? COVER : undefined));
    const s = await server('d1wait', { flags: ['--action-timeout', '2000'] });
    try {
      await s.ok('navigate', { url: `${http.base}/cover`, snapshot: false });
      const click = s.call('click', { target: '#a', timeout_ms: 3000 });
      await sleep(100);
      const w = await s.call('wait', { text: 'never-there', timeout_ms: 2000 });
      await click;
      assert.equal(w.isError, true, w.text);
      const applied = /timed out after (\d+)ms/.exec(w.text);
      assert.ok(applied, w.text);
      assert.ok(Number(applied[1]) < 2000, `reported ${applied[1]} ms, the nominal timeout_ms:\n${w.text}`);
      assert.ok(w.text.includes(`the tab shows ${http.base}/cover`), w.text);
    } finally {
      await s.close();
      http.close();
    }
  });
});

describe('D1 AC4 for the action tools (actionError)', () => {
  test('a queued click that times out reports the time that applied, not timeout_ms', async () => {
    const page = `${COVER}<button id=h style="display:none">Hidden</button>`;
    const http = await pages((u) => (u.pathname === '/cover' ? page : undefined));
    const s = await server('d1act', { flags: ['--action-timeout', '2000'] });
    try {
      await s.ok('navigate', { url: `${http.base}/cover`, snapshot: false });
      const click = s.call('click', { target: '#a', timeout_ms: 3000 });
      await sleep(100);
      const c = await s.call('click', { target: '#h', timeout_ms: 2000 });
      await click;
      assert.equal(c.isError, true, c.text);
      const applied = /(?:after|for) (\d+)ms/.exec(c.text);
      assert.ok(applied, c.text);
      assert.ok(Number(applied[1]) < 2000, `reported ${applied[1]} ms, the nominal timeout_ms:\n${c.text}`);
      assert.ok(c.text.includes(`the tab shows ${http.base}/cover`), c.text);
    } finally {
      await s.close();
      http.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------
// D2: "A ref number this server process issued that is no longer live always gives the stale-ref error ...
// `wait {state: detached|hidden}` succeeds for such refs." More than 10k retirements: 11 documents of 1000
// buttons each, every one snapshotted.
describe('D2 stale refs are not forgotten after 10k retirements', () => {
  test('wait detached on the oldest ref succeeds; acting on it is the stale-ref error', async () => {
    const http = await pages((u) => {
      if (u.pathname !== '/rows') return undefined;
      let s = '';
      for (let k = 0; k < 1000; k++) s += `<button>Row ${k} ${u.search}</button>`;
      return `<!doctype html><title>rows</title>${s}`;
    });
    const s = await server('d2', { flags: ['--max-output-chars', '200000'] });
    try {
      let oldest: string | undefined;
      for (let n = 0; n < 12; n++) {
        await s.ok('navigate', { url: `${http.base}/rows?n=${n}`, snapshot: false });
        const t = (await s.ok('snapshot', { max_chars: 190000 })).text;
        if (n === 0) oldest = /button "Row 0 \?n=0" (e\d+)/.exec(t)?.[1];
        assert.ok((t.match(/^\s*- button /gm) ?? []).length >= 1000, `snapshot ${n} has fewer than 1000 buttons`);
      }
      assert.ok(oldest, 'the first document issued a ref for Row 0');
      await s.ok('wait', { target: oldest, state: 'detached', timeout_ms: 2000 });
      await s.ok('wait', { target: oldest, state: 'hidden', timeout_ms: 2000 });
      const gone = await s.err('click', { target: oldest });
      assert.match(gone.text, new RegExp(`${oldest} is stale`), gone.text);
      const never = await s.err('click', { target: 'e9999999' });
      assert.match(never.text, /e9999999 is not a known ref/, never.text);
    } finally {
      await s.close();
      http.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------
// D3: "those titles are clipped to about 200 chars, surrogate-safe, ending in `…`. With a 30k-char title,
// the snapshot and the navigation line are kept."
describe('D3 a 30,000-char page title', () => {
  test('navigate, tabs new and tabs list clip it; the snapshot and the navigation line survive the cap', async () => {
    const long = `${'T'.repeat(150)}${'😀'.repeat(15_000)}`;
    const http = await pages((u) =>
      u.pathname === '/long' ? `<!doctype html><title>${long}</title><button>Only button</button><a href="/long?2">next</a>` : undefined,
    );
    const s = await server('d3');
    try {
      const titleOf = (line: string): string => {
        const m = /("(?:[^"\\]|\\.)*")/.exec(line);
        assert.ok(m, line.slice(0, 300));
        return JSON.parse(m[1] as string) as string;
      };
      const clipped = (t: string, where: string) => {
        assert.ok(t.length <= 201, `${where}: title ${t.length} chars`);
        assert.ok(t.endsWith('…'), `${where}: ${t.slice(-5)}`);
        assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(t), `${where}: a lone surrogate`);
      };
      const nav = await s.ok('navigate', { url: `${http.base}/long` });
      const head = nav.text.split('\n')[0] ?? '';
      assert.ok(head.startsWith(`[t1] navigated ${http.base}/long `), head.slice(0, 200));
      clipped(titleOf(head), 'navigate');
      assert.match(nav.text, /button "Only button" e\d+/, 'the attached snapshot is kept');
      assert.doesNotMatch(nav.text, /output cut at/, 'nothing was cut');

      const click = await s.ok('click', { target: 'a' });
      const navLine = click.text.split('\n').find((l) => l.startsWith('→ navigated '));
      assert.ok(navLine, click.text.slice(0, 500));
      clipped(titleOf(navLine), '→ navigated');
      assert.doesNotMatch(click.text, /output cut at/);

      const nt = await s.ok('tabs', { action: 'new', url: `${http.base}/long?3` });
      clipped(titleOf(nt.text.split('\n')[0] ?? ''), 'tabs new');
      assert.match(nt.text, /button "Only button" e\d+/, 'tabs new keeps its snapshot');

      const list = await s.ok('tabs', { action: 'list' });
      for (const line of list.text.split('\n').filter((l) => /^t\d+ /.test(l))) clipped(titleOf(line), 'tabs list');
    } finally {
      await s.close();
      http.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------
// D5 (www.reddit.com): "A live-region announcement whose text equals the document title is not reported.
// A real role=alert message is still reported. Fixture: a pushState route change that sets an assertive
// live region to the new title."
describe('D5 an SPA route announcer is not an alert', () => {
  test('pushState + assertive region set to the new title: no → alert; a role=alert message: → alert', async () => {
    const page = `<!doctype html><title>r/home</title>
<faceplate-screen-reader-content aria-live="assertive" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">r/home</faceplate-screen-reader-content>
<button id=route onclick="history.pushState({},'', '/r/programming');document.title='r/programming';document.querySelector('faceplate-screen-reader-content').textContent='r/programming'">Programming</button>
<button id=save onclick="document.getElementById('msg').textContent='Saved your post'">Save</button>
<div id=msg role=alert></div>`;
    const http = await pages((u) => (u.pathname === '/r/home' ? page : undefined));
    const s = await server('d5');
    try {
      await s.ok('navigate', { url: `${http.base}/r/home`, snapshot: false });
      const route = await s.ok('click', { target: '#route' });
      assert.match(route.text, /^→ url \S+\/r\/programming$/m, `the route change itself is reported:\n${route.text}`);
      assert.doesNotMatch(route.text, /^→ alert /m, `the title announcement is not an alert:\n${route.text}`);
      const save = await s.ok('click', { target: '#save' });
      assert.match(save.text, /^→ alert "Saved your post"$/m, `a real role=alert message is reported:\n${save.text}`);
    } finally {
      await s.close();
      http.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------
// F2 (security re-check, the rest of P9): "target descriptions go through the same validation as the snapshot
// (role allowlist, all strings escaped). Evaluate output escapes all 7 separators and cannot start a server
// marker line. Use the reviewer's fake-engine repro." The engine is r3-p9-fix.mjs, copied verbatim.
describe('F2 a fake engine cannot forge server lines through click, type or evaluate', () => {
  const SEPS = /\r\n|[\r\n\u2028\u2029\u0085\v\f]/;
  /**
   * Lines where the engine's forged text sits outside a JSON string: a forged line starts after a raw
   * separator, so its text is never inside quotes. Inside a quoted, escaped name it is page content.
   */
  const forged = (text: string) => text.split(SEPS).filter((l) => /FORGED/.test(l.replace(/"(?:[^"\\]|\\.)*"/g, '""')));

  test('top-level fake engine and a cross-origin iframe engine', async () => {
    const http = await pages((u) => (u.pathname === '/top.html' ? (TOP as string) : u.pathname === '/frame.html' ? (FRAME as string) : undefined));
    const port = new URL(http.base).port;
    const host = await pages((u) => (u.pathname === '/host.html' ? (HOST as (b: string) => string)(`http://localhost:${port}`) : undefined));
    const s = await server('f2', { flags: ['--action-timeout', '4000'] });
    try {
      const results: [string, string][] = [];
      await s.ok('navigate', { url: `${http.base}/top.html`, snapshot: false });
      results.push(['click #b', (await s.call('click', { target: '#b' })).text]);
      results.push(['type #inp', (await s.call('type', { target: '#inp', text: 'hello' })).text]);
      const ev = await s.call('evaluate', { script: '1+1' });
      results.push(['evaluate', ev.text]);
      await s.ok('navigate', { url: `${host.base}/host.html`, snapshot: false });
      const snap = (await s.ok('snapshot', { mode: 'full' })).text;
      const lines = snap.split('\n');
      const at = lines.findIndex((l) => /^- iframe /.test(l));
      const inner = lines.slice(at + 1).map((l) => /^\s+- \S+ .*?(e\d+)/.exec(l)?.[1]).find(Boolean);
      if (inner) results.push([`click iframe ${inner}`, (await s.call('click', { target: inner })).text]);
      results.push(['click iframe selector', (await s.call('click', { target: 'iframe >> nth=0' })).text]);
      for (const [label, text] of results) assert.deepEqual(forged(text), [], `${label}:\n${text.slice(0, 600)}`);
      assert.equal(ev.text.split(SEPS).length, 2, `evaluate prints its header and one JSON line:\n${ev.text}`);
      assert.notEqual(await s.state<string>('document.title'), 'DELETED');
    } finally {
      await s.close();
      http.close();
      host.close();
    }
  });
});
