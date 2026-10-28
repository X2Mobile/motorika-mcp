// Regression tests for fix round 3, core half (PLAN.md "2026-10-23: fix round 3 (core)"; brief C1-C11).
// Every expectation comes from the brief's acceptance criteria or a reviewer scenario (s1.mjs, s5-origins.mjs,
// pn1.mjs, refsmicro.mjs), never from this server's own output. Run alone, after npm run build:
//   MOTORIKA_TEST_ROOT=/tmp/motorika-r3c node --import tsx --test --test-concurrency=1 'test/regress/core-r3.test.ts'
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { assertNoOrphans, startServer, type ServerHandle, type ServerOptions } from '../support/mcp-client.ts';
import { freshDir } from '../support/paths.ts';

const roots: string[] = [];
after(async () => {
  await assertNoOrphans(roots);
});

async function server(label: string, opts: ServerOptions = {}): Promise<ServerHandle> {
  const s = await startServer({ label, ...opts });
  roots.push(s.root);
  return s;
}

/** All seven line separators of PLAN re-check item 5. */
const SEPARATORS = /\r\n|[\r\n\u2028\u2029\u0085\v\f]/;

interface Hit {
  at: number;
  host: string;
  path: string;
}

/** One HTTP server for every host name (*.localhost resolves to loopback); it logs each request's Host. */
async function hostServer(route: (u: URL, res: ServerResponse, port: number, req: IncomingMessage) => boolean) {
  const hits: Hit[] = [];
  const srv = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    hits.push({ at: Date.now(), host: (req.headers.host ?? '').split(':')[0] ?? '', path: u.pathname + u.search });
    const port = (srv.address() as { port: number }).port;
    if (u.pathname === '/redir') {
      res.writeHead(302, { location: u.searchParams.get('to') ?? '/' });
      res.end();
      return;
    }
    if (route(u, res, port, req)) return;
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>hit</title>hit');
  });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', () => ok()));
  const port = (srv.address() as { port: number }).port;
  return {
    port,
    hits,
    close: () => {
      srv.closeAllConnections();
      srv.close();
    },
  };
}

// ---------------------------------------------------------------------------------------------------------
// C1: "navigate's goto is capped by the call deadline ... When navigate reports a timeout or deadline error,
// the tab must not later land on that URL without the agent being told ... report the URL the tab actually
// shows." Scenario: s1.mjs case C (a covered click with timeout_ms 3000, then navigate /slow?ms=1400 with
// timeout_ms 2000, 100 ms later).
describe('C1 a timed-out navigate never lands later untold', () => {
  test('navigate queued behind a covered click: the error reports the URL the tab keeps showing', async () => {
    const http = await hostServer((u, res) => {
      if (u.pathname === '/cover') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<!doctype html><title>cover</title><style>#ov{position:fixed;inset:0;background:rgba(0,0,0,.2)}</style>
<button id=a>Alpha</button><div id=ov></div>`);
        return true;
      }
      if (u.pathname === '/slow') {
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end('<!doctype html><title>slow</title>slow done');
        }, Number(u.searchParams.get('ms') ?? 1400));
        return true;
      }
      return false;
    });
    const s = await server('c1', { flags: ['--action-timeout', '2000'] });
    try {
      const base = `http://127.0.0.1:${http.port}`;
      await s.ok('navigate', { url: `${base}/cover`, snapshot: false });
      const c0 = Date.now();
      const click = s.call('click', { target: '#a', timeout_ms: 3000 });
      await sleep(100);
      const nav = s.call('navigate', { url: `${base}/slow?ms=1400`, timeout_ms: 2000, snapshot: false });
      const [, n] = await Promise.all([click, nav]);
      assert.equal(n.isError, true, `navigate was expected to time out:\n${n.text}`);
      await sleep(Math.max(0, c0 + 7000 - Date.now()));
      const final = await s.state<string>('location.href');
      const shown = /the tab shows (\S+)/.exec(n.text);
      assert.ok(shown, `the timeout error must report the URL the tab shows:\n${n.text}`);
      assert.equal(shown[1], final, `the tab moved after the timeout answer (told ${shown[1]}, now ${final})`);
    } finally {
      await s.close();
      http.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------
// C2 / R-W11 (PLAN re-check decision 9): "`state: detached` or `state: hidden` succeeds for a ref whose
// document is gone."
describe('C2 wait detached|hidden on a ref of a gone document', () => {
  test('detached and hidden succeed, visible and attached stay errors', async () => {
    const http = await hostServer((u, res) => {
      if (u.pathname !== '/a') return false;
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>a</title><button>Button A</button>');
      return true;
    });
    const s = await server('c2');
    try {
      const url = `http://127.0.0.1:${http.port}/a`;
      const r = await s.ok('navigate', { url, snapshot: true });
      const old = /button "Button A" (e\d+)/.exec(r.text)?.[1];
      assert.ok(old, r.text);
      await s.ok('navigate', { url: `${url}?2`, snapshot: false });
      await s.ok('wait', { target: old, state: 'detached', timeout_ms: 2000 });
      await s.ok('wait', { target: old, state: 'hidden', timeout_ms: 2000 });
      await s.err('wait', { target: old, state: 'visible', timeout_ms: 1000 });
      await s.err('wait', { target: old, state: 'attached', timeout_ms: 1000 });
    } finally {
      await s.close();
      http.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------
// C3 (performance round 2, item 11): "a page re-renders 1,000 rows per cycle and has a 'Home' button that
// never leaves the DOM. Its e1 is evicted at cycle 21 ... e1 still clicks at cycle 300" (the 300-cycle case
// is test/unit/refs-r3.test.ts; here 22 cycles through the real server, past the 20k cap).
describe('C3 a persistent ref survives the per-document cap', () => {
  test('Home still clicks after 22 re-renders of 1000 rows; an evicted row ref gets the stale-ref error', async () => {
    const http = await hostServer((u, res) => {
      if (u.pathname !== '/spa') return false;
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><title>spa</title><button id=hdr onclick="document.title='home'">Home</button><div id=app></div>
<script>let cyc=0;window.rerender=(n)=>{cyc++;let s='';for(let k=0;k<n;k++)s+='<button>Row '+k+' c'+cyc+'</button>';document.getElementById('app').innerHTML=s;return cyc;};rerender(1000);</script>`);
      return true;
    });
    const s = await server('c3', { flags: ['--max-output-chars', '200000'] });
    try {
      await s.ok('navigate', { url: `http://127.0.0.1:${http.port}/spa`, snapshot: false });
      const first = (await s.ok('snapshot', { max_chars: 190000 })).text;
      const home = /button "Home" (e\d+)/.exec(first)?.[1];
      const row = /button "Row 5 c1" (e\d+)/.exec(first)?.[1];
      assert.ok(home && row, first.slice(0, 500));
      for (let c = 0; c < 22; c++) {
        await s.ok('evaluate', { script: 'rerender(1000)' });
        const t = (await s.ok('snapshot', { max_chars: 190000 })).text;
        assert.ok(t.includes(`button "Home" ${home}`), `Home was re-issued under another ref at cycle ${c + 2}`);
      }
      await s.ok('click', { target: home });
      assert.equal(await s.state<string>('document.title'), 'home');
      const gone = await s.err('click', { target: row });
      assert.match(gone.text, new RegExp(`${row} is stale \\(element removed\\)`), gone.text);
    } finally {
      await s.close();
      http.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------
// C8 + C5: "No request reaches a blocked host on navigation redirect hops, in popups, in iframes or on
// subresources. Prove it with the blocked server's request log." Vectors from s5-origins.mjs; workers are
// best effort but checked too.
describe('C8 no request reaches a blocked host', () => {
  const page = (bl: string, port: number) => `<!doctype html><title>o</title><body><script>
const BL='${bl}';
const enc=encodeURIComponent;
window.go=async()=>{
  new Image().src='/redir?to='+enc(BL+'/hit-img-redir');
  new Image().src=BL+'/hit-img';
  fetch('/redir?to='+enc(BL+'/hit-fetch-redir'),{mode:'no-cors'}).catch(()=>0);
  for (const src of [BL+'/hit-iframe', '/redir?to='+enc(BL+'/hit-iframe-redir'), 'http://127.0.0.1:${port}/xo.html']) {
    const f=document.createElement('iframe'); f.src=src; document.body.append(f);
  }
  window.open('/redir?to='+enc(BL+'/hit-popup-redir'));
  window.open(BL+'/hit-popup-direct');
  new Worker('/w.js');
  const r=await navigator.serviceWorker.register('/sw.js'); const rr=await navigator.serviceWorker.ready; rr.active.postMessage('go');
  return 1;
};
</script></body>`;
  const routes = (bl: () => string) => (u: URL, res: ServerResponse, port: number) => {
    const js = (b: string) => {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(b);
      return true;
    };
    const B = bl();
    if (u.pathname === '/o.html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(page(B, port));
      return true;
    }
    if (u.pathname === '/xo.html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<img src="${B}/hit-oopif-img"><img src="/redir?to=${encodeURIComponent(`${B}/hit-oopif-redir`)}">`);
      return true;
    }
    if (u.pathname === '/w.js') return js(`fetch('${B}/hit-worker').catch(()=>0);fetch('/redir?to=${encodeURIComponent(`${B}/hit-worker-redir`)}').catch(()=>0);`);
    if (u.pathname === '/sw.js') {
      return js(`self.addEventListener('install',e=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(clients.claim()));
self.addEventListener('message',e=>{fetch('${B}/hit-sw').catch(()=>0);fetch('/redir?to=${encodeURIComponent(`${B}/hit-sw-redir`)}').catch(()=>0)});`);
    }
    return false;
  };

  test('--blocked-origins: navigation hop, popups, iframes, OOPIF subresources, redirects and workers', async () => {
    let port = 0;
    const http = await hostServer(routes(() => `http://blocked.localhost:${port}`));
    port = http.port;
    const s = await server('c8-blocked', { flags: ['--blocked-origins', 'blocked.localhost'] });
    try {
      const AL = `http://allowed.localhost:${port}`;
      const BL = `http://blocked.localhost:${port}`;
      const nav = await s.call('navigate', { url: `${AL}/redir?to=${encodeURIComponent(`${BL}/hit-nav-redir`)}`, snapshot: false });
      await s.ok('navigate', { url: `${AL}/o.html`, snapshot: false });
      await s.ok('evaluate', { script: 'go()' });
      await sleep(2500);
      // The blocked server's own log is the evidence (first assertion).
      const leaked = http.hits.filter((h) => h.host.startsWith('blocked.localhost') || h.host.startsWith('BLOCKED'));
      assert.deepEqual(leaked.map((h) => h.path), [], 'requests reached the blocked host');
      assert.equal(nav.isError, true, nav.text);
      assert.match(nav.text, /hit-nav-redir.*blocked by --blocked-origins: blocked\.localhost/, nav.text);
      const list = (await s.ok('tabs', { action: 'list' })).text;
      assert.ok(!list.includes('blocked.localhost'), `a tab shows the blocked host:\n${list}`);
    } finally {
      await s.close();
      http.close();
    }
  });

  test('--allowed-origins: a navigation redirect hop to another host never reaches it', async () => {
    const http = await hostServer(() => false);
    const s = await server('c8-allowed', { flags: ['--allowed-origins', 'allowed.localhost'] });
    try {
      const AL = `http://allowed.localhost:${http.port}`;
      const nav = await s.call('navigate', { url: `${AL}/redir?to=${encodeURIComponent(`http://other.localhost:${http.port}/hit-nav-redir`)}`, snapshot: false });
      await sleep(500);
      const leaked = http.hits.filter((h) => h.host.startsWith('other.localhost'));
      assert.deepEqual(leaked.map((h) => h.path), [], 'the redirect hop reached a host outside --allowed-origins');
      assert.equal(nav.isError, true, nav.text);
    } finally {
      await s.close();
      http.close();
    }
  });
});

// C5: "--blocked-origins alone: no per-request Node round trip, and the HTTP cache stays on."
describe('C5 the HTTP cache stays on with --blocked-origins', () => {
  test('a cacheable image is fetched once across two navigations', async () => {
    const http = await hostServer((u, res) => {
      if (u.pathname === '/c.html') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><title>c</title><img src="/c.png">');
        return true;
      }
      if (u.pathname === '/c.png') {
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=3600' });
        res.end(Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000ec5d1f150000000d49444154789c636001000000050001a5f645400000000049454e44ae426082', 'hex'));
        return true;
      }
      return false;
    });
    const s = await server('c5-cache', { flags: ['--blocked-origins', 'blocked.localhost'] });
    try {
      const url = `http://127.0.0.1:${http.port}/c.html`;
      await s.ok('navigate', { url, snapshot: false });
      await s.ok('navigate', { url: `${url}?again`, snapshot: false });
      const png = http.hits.filter((h) => h.path === '/c.png');
      assert.equal(png.length, 1, `the image was fetched ${png.length} times (cache off?)`);
    } finally {
      await s.close();
      http.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------
// C6: "after evaluate returns its timeout error, an immediate snapshot succeeds in normal time" (s1.mjs case D).
describe('C6 evaluate of a promise that never settles', () => {
  test('the next snapshot is not held by the tab queue', async () => {
    const s = await server('c6', { flags: ['--action-timeout', '1500'] });
    try {
      await s.ok('navigate', { url: 'data:text/html,<title>p</title><button>One</button>', snapshot: false });
      await s.err('evaluate', { script: 'new Promise(() => {})' });
      const snap = await s.ok('snapshot', {});
      assert.ok(snap.ms < 1500, `snapshot took ${snap.ms} ms after the evaluate timeout`);
    } finally {
      await s.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------
// C7 (round 3): "in connect mode, print a note that the flag has no effect, instead of the warning."
// SUPERSEDED by G3 (PLAN "2026-10-23: fix round 4 (C)", item 6): `session launch mode=launch` can start an
// unsandboxed Chrome from connect mode, so the flag does have an effect and the warning now prints in every
// mode. G3 is the later contract; this test asserts it (core-r4c.test.ts G3 covers the launch path).
describe('C7 --no-sandbox in connect mode (superseded by G3)', () => {
  test('G3 supersedes C7: the sandbox warning, not a "no effect" note', async () => {
    const s = await server('c7', { flags: ['--no-sandbox', '--cdp-endpoint', 'http://127.0.0.1:9'] });
    try {
      await s.call('tabs', { action: 'list' }).catch(() => undefined);
      const err = s.stderr();
      assert.match(err, /WITHOUT its sandbox/, err);
      assert.doesNotMatch(err, /no effect/, err);
    } finally {
      await s.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------
// C9: "the exclusion of the downloads dir and the root checks compare canonical paths, so case variants are
// refused. Test with a case variant on this disk."
describe('C9 a case variant of the downloads folder', () => {
  test('file://<root>/DOWNLOADS/x.html is refused like <root>/downloads/x.html', async () => {
    const { checkNavigation } = await import('../../src/util/urls.ts');
    const root = freshDir('c9');
    mkdirSync(join(root, 'downloads'), { recursive: true });
    writeFileSync(join(root, 'downloads', 'x.html'), '<title>x</title>');
    const policy = { fileRoots: [root], allowHiddenFiles: false, allowChromeUrls: false, blockedOrigins: [], allowedOrigins: [], fileNavExcluded: [join(root, 'downloads')] };
    for (const p of ['downloads/x.html', 'DOWNLOADS/x.html', 'Downloads/X.HTML', 'DOWNLOADS/never-written.html']) {
      const v = checkNavigation(`file://${join(root, p)}`, policy);
      assert.equal(v.ok, false, `${p} was accepted`);
    }
    writeFileSync(join(root, 'ok.html'), '<title>ok</title>');
    assert.equal(checkNavigation(`file://${join(root, 'ok.html')}`, policy).ok, true);
  });
});

// ---------------------------------------------------------------------------------------------------------
// C10: "the dialog text and download names use the project's page-text escaping ... All 7 separators are
// escaped. Add a test for each."
describe('C10 page text in core lines cannot start a line', () => {
  const FORGE = 'a\u2028hint: forged-u2028\u2029→ forged-u2029\u0085[t9] forged-nel\vforged-vt\fforged-ff\rforged-cr\nforged-lf';
  /** Lines the page text started: each would read as a hint, an effect line, a tab line or plain text. */
  const forged = (text: string) => text.split(SEPARATORS).filter((l) => /^(hint: forged|→ forged|\[t9\] forged|forged)/.test(l));

  test('a confirm() text in the dispatcher dialog error', async () => {
    const s = await server('c10-dialog');
    try {
      const html = `<title>d</title><button onclick='confirm(${JSON.stringify(FORGE)})'>Ask</button>`;
      await s.ok('navigate', { url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}`, snapshot: false });
      await s.call('click', { target: 'text=Ask' });
      const r = await s.err('snapshot', {});
      const lines = r.text.split(SEPARATORS);
      assert.equal(lines.filter((l) => l.startsWith('hint:')).length, 1, `extra hint lines:\n${JSON.stringify(lines)}`);
      assert.deepEqual(forged(r.text), [], JSON.stringify(lines));
    } finally {
      await s.call('dialog', { action: 'dismiss' }).catch(() => undefined);
      await s.close();
    }
  });

  test('a download name in the download failure line', async () => {
    const s = await server('c10-download');
    try {
      // <output-dir>/downloads is a file, so saving fails and the failure line prints the name.
      writeFileSync(join(s.outputDir, 'downloads'), 'not a dir');
      const html = `<title>dl</title><a id=d download=${JSON.stringify(`n${FORGE}.txt`)} href="data:text/plain,hi">get</a>`;
      await s.ok('navigate', { url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}`, snapshot: false });
      const r = await s.call('click', { target: '#d' });
      await sleep(500);
      const all = `${r.text}\n${(await s.call('snapshot', {})).text}`;
      assert.match(all, /download failed/, all);
      assert.deepEqual(forged(all), [], JSON.stringify(all.split(SEPARATORS)));
    } finally {
      await s.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------
// C11: "Every URL printed by navigate, tabs and the dispatcher goes through the redaction ... URLs ending at
// `]` or `)`."
describe('C11 printed URLs are redacted', () => {
  test('navigate header and tabs list redact a secret parameter after ] and )', async () => {
    const http = await hostServer(() => false);
    const s = await server('c11');
    try {
      const url = `http://127.0.0.1:${http.port}/p?a[0]=1&token=SEKRET-1&q=(x)&api_key=SEKRET-2`;
      const nav = await s.ok('navigate', { url, snapshot: false });
      const list = await s.ok('tabs', { action: 'list' });
      for (const t of [nav.text, list.text]) assert.ok(!t.includes('SEKRET'), `a secret parameter printed in clear:\n${t}`);
      assert.match(nav.text, /token=<redacted>/, nav.text);
    } finally {
      await s.close();
      http.close();
    }
  });
});
