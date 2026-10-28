// Regression tests for the core half of the re-check round (PLAN.md amendment "decisions from the re-check
// round", items 1-4, 6, 11). Every expectation comes from a PLAN line or a reviewer scenario
// (docs/reviews/recheck-*.md), never from this server's own output. Run alone, after npm run build:
//   MOTORIKA_TEST_ROOT=/tmp/motorika-c node --import tsx --test --test-concurrency=1 'test/regress/core-r2.test.ts'
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
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

/** A directory outside every allowed root (cwd = repo, output dir, HOME's Downloads/Desktop/Documents). */
function outsideSecret(marker: string): string {
  const dir = freshDir('outside');
  const f = join(dir, 'secret.txt');
  writeFileSync(f, marker);
  return f;
}

// ---------------------------------------------------------------------------------------------------------
// Item 4 / NEW-1: "The first URL of every new page (popup, target=_blank, window.open) obeys the URL policy.
// A refused one is sent to about:blank or closed, and reported as `→ blocked <url> (<reason>)`."
// "<output-dir>/downloads is not a root for file: navigation ... It remains an upload source."
describe('item 4 popups and the downloads folder (NEW-1)', () => {
  test('window.open and target=_blank of an outside file from an allowed file: page are blocked, not readable', async () => {
    const MARK = 'OUTSIDE-SECRET-core-r2-4711';
    const secret = outsideSecret(MARK);
    const home = freshDir('home');
    const s = await server('popup', { env: { HOME: home } });
    try {
      const opener = join(s.outputDir, 'opener.html');
      writeFileSync(opener, `<!doctype html><title>op</title><script>window.open(${JSON.stringify(`file://${secret}`)});</script>`);
      const link = join(s.outputDir, 'link.html');
      writeFileSync(link, `<!doctype html><title>ln</title><a id=l target=_blank href=${JSON.stringify(`file://${secret}`)}>open</a>`);

      let seen = (await s.ok('navigate', { url: `file://${opener}`, snapshot: false })).text;
      await sleep(1800);
      seen += `\n${(await s.ok('tabs', { action: 'list' })).text}`;
      await s.ok('navigate', { url: `file://${link}`, snapshot: false });
      seen += `\n${(await s.call('click', { target: '#l' })).text}`;
      await sleep(1800);
      const list = (await s.ok('tabs', { action: 'list' })).text;
      seen += `\n${list}`;

      const blocked = seen.split('\n').filter((l) => l.startsWith('→ blocked ') && l.includes(secret));
      assert.ok(blocked.length >= 2, `two "→ blocked <url> (<reason>)" lines expected:\n${seen}`);
      for (const l of blocked) assert.match(l, /^→ blocked file:\/\/\S+ \(.+\)$/);
      assert.ok(!list.includes('secret.txt'), `no tab shows the outside file:\n${list}`);
      // Whatever tabs exist, none of them can read the marker.
      for (const m of list.matchAll(/\b(t\d+)\b/g)) {
        const r = await s.call('read', { tab: m[1] });
        assert.ok(!r.text.includes(MARK), `tab ${m[1]} leaked the outside file:\n${r.text}`);
      }
    } finally {
      await s.close();
    }
  });

  test('a file: URL inside <output-dir>/downloads is refused for navigation but still uploads', async () => {
    const home = freshDir('home');
    const s = await server('dl', { env: { HOME: home } });
    try {
      const dl = join(s.outputDir, 'downloads');
      mkdirSync(dl, { recursive: true });
      writeFileSync(join(dl, 'evil.html'), '<!doctype html><title>evil</title>EVIL-PAGE');
      const e = await s.err('navigate', { url: `file://${join(dl, 'evil.html')}` });
      assert.match(e.text, /downloads/i);
      assert.match(e.text, /\nhint: /);
      const form = join(s.outputDir, 'form.html');
      writeFileSync(form, '<!doctype html><title>f</title><input type=file id=f>');
      await s.ok('navigate', { url: `file://${form}`, snapshot: false });
      await s.ok('upload', { target: '#f', paths: [join(dl, 'evil.html')] });
      assert.equal(await s.state("document.querySelector('#f').files[0].name"), 'evil.html');
    } finally {
      await s.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------
// Item 3 / R-C4 + NEW-3 + PN1: "Redirects are checked at every hop, for navigations and for subresource
// requests alike. A host's trailing dot is ignored. Only URLs a list could match are routed."
describe('item 3 origin lists at every redirect hop (R-C4, NEW-3, PN1)', () => {
  test('PN1: the route matcher is a regex that leaves unrelated URLs alone', async () => {
    const { originRouteMatch } = await import('../../src/util/urls.ts');
    const m = originRouteMatch({ blockedOrigins: ['bank.example', '*.corp.example'], allowedOrigins: [] });
    assert.ok(m instanceof RegExp, 'a regex URLMatch, not a function matcher (which routes every request)');
    for (const u of ['https://bank.example/', 'https://www.bank.example/x', 'http://bank.example.:8080/', 'wss://a.corp.example/s']) assert.ok(m.test(u), u);
    for (const u of ['https://example.org/', 'https://notbank.example/', 'https://cdn.net/?u=https://bank.example/', 'https://corp.example/']) assert.ok(!m.test(u), u);
    assert.equal(originRouteMatch({ blockedOrigins: [], allowedOrigins: [] }), undefined);
  });

  test('a blocked host is refused with a trailing dot, through a navigation redirect, and through img/fetch redirects', async () => {
    const MARK = 'BLOCKED-HOST-CONTENT-core-r2';
    const hits: string[] = [];
    const http = await import('node:http');
    const srv = http.createServer((q, r) => {
      const host = (q.headers.host ?? '').split(':')[0] ?? '';
      hits.push(`${host}${q.url}`);
      const port = (srv.address() as { port: number }).port;
      if (q.url?.startsWith('/hop')) {
        r.writeHead(302, { location: `http://localhost:${port}/secret${q.url}`, 'access-control-allow-origin': '*' });
        r.end();
        return;
      }
      if (q.url === '/page') {
        r.setHeader('content-type', 'text/html');
        r.end(`<!doctype html><title>p</title><img src="/hop-img"><script>fetch('/hop-fetch').then((x) => x.text()).then((t) => { document.title = 'F:' + t; }, () => { document.title = 'fetch-failed'; });</script>`);
        return;
      }
      r.setHeader('content-type', 'text/html');
      r.setHeader('access-control-allow-origin', '*');
      r.end(`<!doctype html><title>s</title>${MARK}`);
    });
    await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', () => ok()));
    const port = (srv.address() as { port: number }).port;
    const s = await server('origins', { flags: ['--blocked-origins', 'localhost'] });
    try {
      const dot = await s.err('navigate', { url: `http://localhost.:${port}/secret-dot` });
      assert.match(dot.text, /blocked by --blocked-origins/);

      const nav = await s.call('navigate', { url: `http://127.0.0.1:${port}/hop-nav` });
      await sleep(500);
      const read = await s.call('read', {});
      assert.ok(!`${nav.text}\n${read.text}`.includes(MARK), `the redirect landed on the blocked host:\n${nav.text}\n${read.text}`);
      assert.match(`${nav.text}\n${read.text}`, /^→ blocked http:\/\/localhost:\d+\/secret\/hop-nav \(blocked by --blocked-origins: localhost\)$/m);

      await s.call('navigate', { url: `http://127.0.0.1:${port}/page`, snapshot: false });
      await sleep(1000);
      const title = await s.state<string>('document.title');
      assert.ok(!String(title).includes(MARK), `fetch read the blocked host through a redirect: ${title}`);
      // Subresource hops never reach the blocked host. A navigation hop is checked at commit (Playwright
      // never routes a redirect hop; see the report's amendment), so only its content is refused.
      const leaked = hits.filter((h) => h.startsWith('localhost') && !h.includes('/hop-nav'));
      assert.deepEqual(leaked, [], `subresource requests reached the blocked host: ${leaked.join(', ')}`);
    } finally {
      await s.close();
      srv.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------
// Item 1 / R-C1 (core half): "The tab queue moves on only after a timed-out job has actually settled ...
// So a call never ... overlaps the next call on the same tab." Scenario from recheck-correctness R-C1
// (action timeout 2000: wait 3500, click under an overlay at +100 ms, evaluate at +250 ms).
describe('item 1 the tab queue waits for a timed-out job (R-C1)', () => {
  test('the next call on the tab never runs while a timed-out click is still acting', async () => {
    const s = await server('rc1', { flags: ['--action-timeout', '2000'] });
    try {
      const page = join(s.outputDir, 'overlay.html');
      writeFileSync(
        page,
        `<!doctype html><title>Ov</title><script>window.log=[];</script>
<button id=b style="position:absolute;top:10px;left:10px;width:100px;height:40px" onclick="window.log.push(['click',Date.now()])">B</button>
<div id=ov style="position:absolute;top:0;left:0;width:300px;height:100px;background:#eee;z-index:9"></div>
<script>window.arm=(ms)=>setTimeout(()=>{document.getElementById('ov').remove();window.log.push(['ovgone',Date.now()])},ms)</script>`,
      );
      await s.ok('navigate', { url: `file://${page}`, snapshot: false });
      await s.state('window.arm(4700)');
      const w = s.call('wait', { ms: 3500 });
      await sleep(100);
      const pA = s.call('click', { target: '#b' });
      await sleep(150);
      const pB = s.call('evaluate', { script: 'window.log.push(["evalB",Date.now()]); 1' });
      const [a] = await Promise.all([pA, pB, w]);
      assert.equal(a.isError, true, `the click times out:\n${a.text}`);
      await sleep(3000);
      const log = JSON.parse(await s.state<string>('JSON.stringify(window.log)')) as [string, number][];
      const clickAt = log.find((x) => x[0] === 'click')?.[1];
      const evalAt = log.find((x) => x[0] === 'evalB')?.[1];
      if (clickAt !== undefined && evalAt !== undefined) {
        assert.ok(evalAt >= clickAt, `evaluate ran at ${evalAt}, before the timed-out click landed at ${clickAt}: ${JSON.stringify(log)}`);
      }
    } finally {
      await s.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------
// Item 2 / R-C2 + R-C3: "Ref and tab counters travel as structured fields ... never parsed out of result
// text, because page text can contain e<digits>. A client that rejoins sends its highest seen ref and tab
// numbers. The new owner raises its counters and its previous-session floor to match, and the rejoined
// client gets the takeover notice." Three servers: A owner, B and C joined, A exits.
describe('item 2 takeover counters with three servers (R-C2, R-C3)', () => {
  test('C keeps no ref that clicks a new element, sees the notice, and page text cannot collapse counters', async () => {
    const home = freshDir('home');
    const docs = join(home, 'Documents');
    mkdirSync(docs, { recursive: true });
    const buttons = Array.from({ length: 30 }, (_, i) => `<button onclick="window.__counts['B${i}']=(window.__counts['B${i}']||0)+1">B${i}</button>`).join('');
    const page = join(docs, 'many.html');
    writeFileSync(page, `<!doctype html><title>many</title><script>window.__counts={}</script><p>e9007199254740993 t9007199254740993 e4294967296</p>${buttons}`);
    const small = join(docs, 'small.html');
    writeFileSync(small, '<!doctype html><title>small</title><button>S</button>');
    const profile = join(freshDir('rc2'), 'profile');
    const opts: ServerOptions = { isolated: false, flags: ['--profile-dir', profile], env: { HOME: home }, slots: 0 };
    const A = await server('rc2-A', { ...opts, slots: 1 });
    const B = await server('rc2-B', opts);
    const C = await server('rc2-C', opts);
    try {
      await A.ok('navigate', { url: `file://${small}` });
      await B.ok('navigate', { url: `file://${small}` });
      const cBefore = (await C.ok('navigate', { url: `file://${page}` })).text;
      const cRefs = [...cBefore.matchAll(/button "B\d+" (e\d+)/g)].map((m) => m[1]!);
      assert.equal(cRefs.length, 30, cBefore);
      const old = cRefs[cRefs.length - 1]!;
      const oldMaxRef = Math.max(...cRefs.map((r) => Number(r.slice(1))));
      const oldMaxTab = Math.max(...[...(await C.ok('tabs', { action: 'list' })).text.matchAll(/^t(\d+) /gm)].map((m) => Number(m[1])));

      await A.close();
      await B.ok('navigate', { url: `file://${small}` }); // B takes over
      const cAfter = await C.call('navigate', { url: `file://${page}` }); // C rejoins B
      assert.equal(cAfter.isError, false, cAfter.text);
      assert.match(cAfter.text, /went away/, `the rejoined client gets the takeover notice:\n${cAfter.text}`);
      const newRefs = [...cAfter.text.matchAll(/button "B\d+" e(\d+)/g)].map((m) => Number(m[1]));
      assert.equal(newRefs.length, 30);
      assert.ok(Math.min(...newRefs) > oldMaxRef, `new refs start at e${Math.min(...newRefs)}, C saw up to e${oldMaxRef}`);
      assert.equal(new Set(newRefs).size, 30, 'page text did not collapse the ref counter');
      assert.ok(Math.max(...newRefs) < 1e9, `ref numbers stay small: e${Math.max(...newRefs)}`);
      const tab = /^\[(t\d+)\]/m.exec(cAfter.text.split('\n').find((l) => l.startsWith('[t')) ?? '')?.[1] ?? 't0';
      assert.ok(Number(tab.slice(1)) > oldMaxTab, `new tab ${tab}, C saw up to t${oldMaxTab}`);

      const e = await C.call('click', { target: old });
      assert.equal(e.isError, true, `old ref ${old} must be refused:\n${e.text}`);
      assert.match(e.text, /from a previous browser session/);
      assert.equal(await C.state('JSON.stringify(window.__counts)'), '{}', 'the old ref clicked nothing');
    } finally {
      await C.close();
      await B.close();
      await A.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------
// Item 6 / R-W8: "Secrets reach a joined client too, so they survive a takeover."
describe('item 6 remembered secrets survive a takeover (R-W8)', () => {
  test('a password a joined client typed stays redacted after it takes over', async () => {
    const SECRET = 'Zq-core-r2-secret-77';
    const home = freshDir('home');
    const docs = join(home, 'Documents');
    mkdirSync(docs, { recursive: true });
    const form = join(docs, 'login.html');
    writeFileSync(form, '<!doctype html><title>login</title><input type=password id=pw aria-label="Password">');
    const echo = join(docs, 'echo.html');
    writeFileSync(echo, `<!doctype html><title>echo</title><p>your password is ${SECRET}</p>`);
    const profile = join(freshDir('rw8'), 'profile');
    const opts: ServerOptions = { isolated: false, flags: ['--profile-dir', profile], env: { HOME: home }, slots: 0 };
    const A = await server('rw8-A', { ...opts, slots: 1 });
    const B = await server('rw8-B', opts);
    try {
      await A.ok('navigate', { url: `file://${form}`, snapshot: false });
      await B.ok('navigate', { url: `file://${form}`, snapshot: false });
      await B.ok('type', { target: '#pw', text: SECRET });
      const before = await B.ok('navigate', { url: `file://${echo}` });
      assert.ok(!before.text.includes(SECRET), 'redacted while joined');
      await A.close();
      const after = await B.call('navigate', { url: `file://${echo}` }); // B takes over
      const read = await B.call('read', {});
      assert.ok(!`${after.text}\n${read.text}`.includes(SECRET), `the secret leaked after the takeover:\n${after.text}\n${read.text}`);
      assert.match(read.text, /<redacted>/);
    } finally {
      await B.close();
      await A.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------
// Item 11 + PN2: "live refs are capped at 20k per document. A retired or evicted ref gets the stale-ref
// error." PN2: forgetting a frame or a tab must not walk every live ref of every tab.
describe('item 11 ref retention and PN2 ref index', () => {
  test('a document keeps at most 20k live refs; the oldest are evicted as stale, other documents untouched', async () => {
    const { RefRegistry } = await import('../../src/browser/refs.ts');
    const r = new RefRegistry<string>();
    const other = r.issue({ tabId: 't1', frame: 'f1', docId: 'd0', localId: 1, role: 'button', name: 'x' });
    const first = r.issue({ tabId: 't1', frame: 'f1', docId: 'd1', localId: 0, role: 'button', name: 'b' });
    for (let i = 1; i <= 20000; i++) r.issue({ tabId: 't1', frame: 'f1', docId: 'd1', localId: i, role: 'button', name: 'b' });
    assert.equal(r.get(first), undefined, 'the oldest ref of the document is evicted');
    // Round 3 C3: the expectation was 'old-doc' (the "earlier document" text); PLAN item 11 says stale-ref.
    assert.equal(r.whyMissing(first).reason, 'stale', 'an evicted ref gets the stale-ref reason');
    assert.ok(r.get(first + 1), 'the next one is still live');
    assert.ok(r.get(other), 'another document is not affected');
    assert.equal(r.size, 20001);
  });

  test('forgetting frames of a small tab does not scale with another tab holding 100k refs', async () => {
    const { RefRegistry } = await import('../../src/browser/refs.ts');
    const r = new RefRegistry<string>();
    for (let d = 0; d < 5; d++) for (let i = 0; i < 20000; i++) r.issue({ tabId: 't1', frame: 'f1', docId: `big${d}`, localId: i, role: 'button', name: 'b' });
    const t0 = performance.now();
    for (let n = 0; n < 2000; n++) {
      const ref = r.issue({ tabId: 't2', frame: `f${n}`, docId: `small${n}`, localId: 0, role: 'link', name: 'l' });
      r.forgetFrameBefore('t2', `f${n}`, Date.now() + 1);
      r.forgetFrame('t2', `f${n}`);
      assert.equal(r.get(ref), undefined);
    }
    r.forgetTab('t2');
    const ms = performance.now() - t0;
    // A scan of every live ref is 2000 x 2 x 100k = 4e8 visits (seconds); an index is a few ms.
    assert.ok(ms < 500, `2000 frame forgets took ${ms.toFixed(0)} ms with 100k live refs elsewhere`);
    assert.equal(r.size, 100000);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Nit (re-check round): a blocked file: click prints `→ blocked …` without a `→ navigated about:blank`
// line before it.
describe('nit: a blocked file: click', () => {
  test('reports → blocked and no → navigated about:blank line', async () => {
    const secret = outsideSecret('NIT-OUTSIDE');
    const home = freshDir('home');
    const s = await server('nit', { env: { HOME: home } });
    try {
      const link = join(s.outputDir, 'samelink.html');
      writeFileSync(link, `<!doctype html><title>ln</title><a id=l href=${JSON.stringify(`file://${secret}`)}>open</a>`);
      await s.ok('navigate', { url: `file://${link}`, snapshot: false });
      let text = (await s.call('click', { target: '#l' })).text;
      if (!text.includes('→ blocked')) text += `\n${(await s.call('tabs', { action: 'list' })).text}`;
      assert.match(text, /^→ blocked file:\/\/\S+secret\.txt \(.+\)$/m, text);
      assert.doesNotMatch(text, /^→ navigated about:blank/m, text);
    } finally {
      await s.close();
    }
  });
});
