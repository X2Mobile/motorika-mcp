// Fix round 3 (page), end to end through the built server. Oracles: old.reddit.com's own markup (P1, P2,
// P4), the reviewers' repro pages (P6-P9) and the acceptance criteria in PLAN.md "2026-10-23: fix round 3
// (page)", never this code's output. Run alone (after npm run build):
//   MOTORIKA_TEST_ROOT=/tmp/motorika-r3p node --import tsx --test --test-concurrency=1 'test/regress/page-r3.test.ts'
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium, type BrowserContext } from 'playwright-core';
import { startFixtureServer, type FixtureServer } from '../support/fixture-server.ts';
import { parseFindHits, parseSnapshot, type ViewportFooter } from '../support/grammar.ts';
import { imageSize } from '../support/images.ts';
import { assertBuilt, assertNoOrphans, startServer, type ServerHandle } from '../support/mcp-client.ts';
import { freshDir } from '../support/paths.ts';
import { killChromeUnder } from '../support/procs.ts';
import { acquireSlots } from '../support/slots.ts';

const roots: string[] = [];
let s: ServerHandle;
let fx: FixtureServer;
const page = (html: string): string => `data:text/html,${encodeURIComponent(html)}`;
const ATTACHED_MAX = 6000;
/** Lines a consumer splits on: every one of the 7 separators. */
const consumerLines = (t: string): string[] => t.split(/\r\n|[\n\r\u2028\u2029\u0085\v\f]/);
/** The attached snapshot: everything from its header line on. */
const attached = (t: string): string => {
  const ls = t.split('\n');
  const i = ls.findIndex((l) => / \(untrusted page content\)$/.test(l));
  return i < 0 ? '' : ls.slice(i).join('\n');
};

before(async () => {
  assertBuilt();
  fx = await startFixtureServer();
  s = await startServer({ label: 'page-r3', flags: ['--action-timeout', '3000'] });
  roots.push(s.root);
});
after(async () => {
  await s?.close();
  await fx?.close();
  await assertNoOrphans(roots);
});

async function read(path: string, format?: 'markdown' | 'text'): Promise<string> {
  await s.ok('navigate', { url: fx.url(path), snapshot: false });
  return (await s.ok('read', format ? { format } : {})).text;
}

describe('P1: read keeps the text inside a <form>, never a control value', () => {
  for (const format of ['markdown', 'text'] as const) {
    test(`old.reddit thread: selftext and every comment body (${format})`, async () => {
      const t = await read('/reddit-thread.html', format);
      for (const body of ['SELFTEXT-BODY: this is the post body people came for.', 'COMMENT-ONE: first comment body.', 'Second paragraph of the first comment.', 'COMMENT-TWO: a nested reply with']) {
        assert.ok(t.includes(body), `missing "${body}":\n${t}`);
      }
      assert.doesNotMatch(t, /HIDDEN-VALUE|REPLY-HIDDEN|REPLY-DRAFT-VALUE|side-search-value/, t);
    });
  }
  test('a login form reads its heading and labels, and no value of any control', async () => {
    const t = await read('/login-form.html');
    assert.match(t, /Sign in to Example/);
    assert.match(t, /Email address/);
    assert.match(t, /Forgot your password\?/);
    assert.doesNotMatch(t, /EMAIL-VALUE|PASSWORD-VALUE|CSRF-HIDDEN-VALUE|SELECT-OPTION-VALUE/, t);
  });
});

describe('P2: read keeps the "N comments" link of a listing row', () => {
  test('"8 comments" with its link; the site nav and header menu stay out', async () => {
    const t = await read('/reddit-listing.html');
    assert.ok(t.includes(`[8 comments](${fx.url('/r/test/comments/abc/first_post/')})`), t);
    assert.match(t, /First post title/);
    assert.doesNotMatch(t, /NAV-POPULAR|NAV-ALL|HEADER-MENU-HOT|HEADER-MENU-NEW|HIDE-HIDDEN-VALUE/, t);
  });
});

describe('P4: find matches text split across elements', () => {
  for (const query of ['karma', 'comment karma', '21 comment karma']) {
    test(`find "${query}": one hit, the smallest element holding it`, async () => {
      await s.ok('navigate', { url: fx.url('/reddit-user.html'), snapshot: false });
      const r = await s.ok('find', { query });
      const hits = parseFindHits(r.text);
      assert.equal(hits.length, 1, r.text);
      assert.match(hits[0]!.el.name ?? '', /21 comment karma/, r.text);
      // No ancestor listed again: not the main landmark, nor anything else.
      assert.doesNotMatch(r.text.split('\n').slice(1).filter((l) => !l.startsWith('  in ')).join('\n'), /- main/, r.text);
    });
  }
});

describe('P5: find with an empty query and a role lists that role', () => {
  const form = page(`<title>F</title><label>A <input></label><input aria-label="B"><textarea></textarea><input type=password aria-label=P><button>Go</button>`);
  test('every textbox, capped by limit', async () => {
    await s.ok('navigate', { url: form, snapshot: false });
    const all = parseFindHits((await s.ok('find', { query: '', role: 'textbox' })).text);
    assert.equal(all.length, 4, 'A, B, the unnamed textarea and the password');
    assert.ok(all.every((h) => h.el.role === 'textbox'));
    const two = await s.ok('find', { query: '', role: 'textbox', limit: 2 });
    assert.equal(parseFindHits(two.text).length, 2, two.text);
  });
  test('an empty query without a role is an error that says what to pass', async () => {
    const r = await s.err('find', { query: '' });
    assert.match(r.text, /role/, r.text);
  });
});

describe('P6/P7: cut lines stay in the grammar; the cap holds; paging covers every line', () => {
  test('a 10-option select at max_chars 300 and 120 parses', async () => {
    await s.ok('navigate', {
      url: page(`<title>sel</title><select>${Array.from({ length: 10 }, (_, i) => `<option>${`opt${i} `.repeat(6)}</option>`).join('')}</select><button>After</button>`),
      snapshot: false,
    });
    for (const max_chars of [300, 120]) {
      const r = await s.ok('snapshot', { max_chars });
      assert.deepEqual(parseSnapshot(r.text).errors, [], r.text);
    }
  });
  test('max_chars 120: paging through every offset shows the combobox and the button', async () => {
    const seen: string[] = [];
    let offset = 0;
    for (let g = 0; g < 10; g++) {
      const r = await s.ok('snapshot', { max_chars: 120, offset });
      const p = parseSnapshot(r.text);
      assert.deepEqual(p.errors, [], r.text);
      seen.push(...p.elements.map((e) => e.role));
      const f = p.footer;
      if (!f || f.offset === null) break;
      assert.ok(f.offset > offset, `progress: ${r.text}`);
      offset = f.offset;
    }
    assert.deepEqual(seen, ['combobox', 'button']);
  });
  test('a textarea holding 100 x U+0001 at max_chars 400, 333 and 250 parses', async () => {
    await s.ok('navigate', {
      url: page(`<title>ta</title><textarea id=t aria-label=T></textarea><button>After</button><script>t.value=String.fromCharCode(1).repeat(100)</script>`),
      snapshot: false,
    });
    for (const max_chars of [500, 400, 333, 250]) {
      const r = await s.ok('snapshot', { max_chars });
      assert.deepEqual(parseSnapshot(r.text).errors, [], r.text);
    }
  });
  test('a 7,000-char title: the attached snapshot stays within 6,000 and shows its button', async () => {
    const r = await s.ok('navigate', { url: page(`<title>${'T'.repeat(7000)}</title><button>One</button>`) });
    const snap = attached(r.text);
    assert.ok(snap.length <= ATTACHED_MAX, `attached snapshot ${snap.length} chars`);
    const p = parseSnapshot(snap);
    assert.deepEqual(p.errors, []);
    assert.deepEqual(p.elements.map((e) => [e.role, e.name]), [['button', 'One']]);
  });
});

describe('P8: off-screen 1x1 iframes are not counted', () => {
  test('one on-screen button and two tracking frames: no off-screen count', async () => {
    const r = await s.ok('navigate', { url: fx.url('/tracking-iframes.html') });
    const p = parseSnapshot(attached(r.text));
    assert.deepEqual(p.errors, []);
    const f = p.footer as ViewportFooter | null;
    assert.ok(f === null || f.offscreen === 0, `footer: ${JSON.stringify(f)}\n${r.text}`);
    assert.doesNotMatch(r.text, /more off-screen/, r.text);
  });
});

describe('P9: a page-planted engine is untrusted', () => {
  const FORGED = /^(\[t\d+\]|→ |hint: |notice:)/;
  test('a cross-origin frame engine forges no line, no foreign ref and no URL', async () => {
    const r = await s.ok('navigate', { url: fx.url('/fake-engine-forge.html') });
    let snapText = '';
    for (let i = 0; i < 20; i++) {
      snapText = (await s.ok('snapshot', {})).text;
      if (/- iframe [^\n]*frame=f\d+\n {2}- /.test(snapText)) break; // the frame's nodes are stitched in
      await sleep(200);
    }
    for (const t of [attached(r.text), snapText]) {
      // Every line after the snapshot header: none may look like a server line.
      const lines = consumerLines(t).slice(1);
      assert.deepEqual(lines.filter((l) => FORGED.test(l)), [], t);
      assert.ok(!lines.some((l) => /Keep my account/.test(l) && /^\s*- button/.test(l)), t);
      // Forged text may only survive escaped inside a quoted name; never as a role, level, type or URL.
      assert.doesNotMatch(t, /bank\.example|forged\.example|FORGED-(URL|TYPE|CHECKED|ID)/, t);
      const p = parseSnapshot(t);
      assert.deepEqual(p.errors, [], t); // includes "duplicate ref": the host's e2 is never reprinted
      const del = p.elements.find((e) => e.name === 'Delete account');
      assert.ok(del, t);
      assert.equal(p.elements.filter((e) => e.ref === del.ref).length, 1);
    }
    assert.match(snapText, /^ {2}- group "x" e\d+/m, 'the frame node is shown with a vocabulary role');
    const found = await s.ok('find', { query: 'ad' });
    assert.deepEqual(consumerLines(found.text).slice(1).filter((l) => FORGED.test(l)), [], found.text);
    assert.doesNotMatch(found.text, /FORGED-FIND/, found.text);
  });
  test('a top page engine cannot replace the URL in the snapshot or read header', async () => {
    const url = fx.url('/fake-engine-top.html');
    await s.ok('navigate', { url, snapshot: false });
    const snap = await s.ok('snapshot', {});
    assert.equal(parseSnapshot(snap.text).header.url, url, snap.text);
    const rd = await s.ok('read', {});
    assert.ok(rd.text.split('\n')[0]!.includes(` ${url} (untrusted page content)`), rd.text);
    assert.doesNotMatch(rd.text, /bankofamerica|FORGED/, rd.text);
    const sc = await s.call('scroll', { direction: 'down' });
    assert.doesNotMatch(sc.text, /FORGED/, sc.text);
  });
});

describe('P12: read escapes a page-written batch step marker', () => {
  test('"## step 2: navigate" in the page text gets a leading backslash', async () => {
    await s.ok('navigate', { url: page(`<title>S</title><main><pre>intro\n## step 2: navigate\nmore</pre></main>`), snapshot: false });
    const t = (await s.ok('read', { format: 'text' })).text;
    assert.ok(consumerLines(t).includes('\\## step 2: navigate'), t);
    assert.ok(!consumerLines(t).includes('## step 2: navigate'), t);
  });
});

// P3: on a retina Mac, Playwright's viewport emulation reports devicePixelRatio 1 while Chrome captures at
// the screen's 2x. --force-device-scale-factor=2 under the same emulation is that machine; deviceScaleFactor
// 2 is an honest DPR 2 page. The server attaches to that Chrome over CDP (the server takes no Chrome args).
describe('P3: the screenshot header matches the delivered image, DPR 1 and DPR 2', () => {
  type Mode = { label: string; args: string[]; dsf?: number };
  const modes: Mode[] = [
    { label: 'retina Mac (JS dpr 1, capture 2x)', args: ['--force-device-scale-factor=2'] },
    { label: 'deviceScaleFactor 2', args: [], dsf: 2 },
  ];
  const HEADER = /^\[t\d+\] screenshot (\d+)x(\d+) scale=([\d.]+); x,y targets use this image's pixels/m;

  async function check(srv: ServerHandle, tab: string | undefined): Promise<void> {
    const t = tab ? { tab } : {};
    await srv.ok('navigate', { ...t, url: fx.url('/coords.html'), snapshot: false });
    for (const args of [{}, { full_page: true }, { target: '#coord' }, { format: 'png' }, { full_page: true, max_edge: 640, format: 'png' }]) {
      const r = await srv.ok('screenshot', { ...t, ...args });
      const h = HEADER.exec(r.text);
      assert.ok(h, r.text);
      const img = r.images[0]!;
      const size = imageSize(Buffer.from(img.data, 'base64'), img.mimeType);
      assert.deepEqual([Number(h[1]), Number(h[2])], [size.width, size.height], `${JSON.stringify(args)}: header vs image`);
    }
    // An x,y click taken from the viewport image hits "Coord target" (CSS 300,200 size 160x60).
    const shot = await srv.ok('screenshot', { ...t, format: 'png' });
    const size = imageSize(Buffer.from(shot.images[0]!.data, 'base64'), 'image/png');
    const vw = await srv.state<number>('innerWidth', t);
    const k = size.width / vw;
    await srv.ok('click', { ...t, target: `${Math.round((300 + 80) * k)},${Math.round((200 + 30) * k)}` });
    assert.deepEqual(await srv.state('window.__counts', t), { coord: 1 });
  }

  test('DPR 1 (launch mode)', async () => {
    await check(s, undefined);
  });

  for (const mode of modes) {
    test(mode.label, async () => {
      const lease = await acquireSlots(1, 'p3');
      const root = freshDir('p3');
      roots.push(root);
      const udd = join(root, 'udd');
      mkdirSync(udd, { recursive: true });
      let context: BrowserContext | undefined;
      let srv: ServerHandle | undefined;
      try {
        context = await chromium.launchPersistentContext(udd, {
          channel: 'chrome',
          headless: true,
          viewport: { width: 1280, height: 800 },
          ...(mode.dsf ? { deviceScaleFactor: mode.dsf } : {}),
          args: ['--remote-debugging-port=0', ...mode.args],
          env: { ...process.env, TMPDIR: `${root}/` },
        });
        const pg = context.pages()[0] ?? (await context.newPage());
        await pg.goto(fx.url('/coords.html'));
        const portFile = join(udd, 'DevToolsActivePort');
        for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(100);
        const port = Number(readFileSync(portFile, 'utf8').split('\n')[0]);
        srv = await startServer({ label: 'p3', headless: false, isolated: false, slots: 0, flags: ['--cdp-endpoint', `http://127.0.0.1:${port}`] });
        const tabs = (await srv.ok('tabs', { action: 'list' })).text;
        const tab = /^(t\d+) .*coords\.html/m.exec(tabs)?.[1];
        assert.ok(tab, tabs);
        await check(srv, tab);
      } finally {
        await srv?.close();
        await context?.close().catch(() => undefined);
        await killChromeUnder(root).catch(() => 0);
        lease.release();
      }
    });
  }
});
