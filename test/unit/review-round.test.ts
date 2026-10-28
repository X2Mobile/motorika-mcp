// Review-lens decisions (PLAN amendment "decisions from the three review lenses"): URL policy, origin
// lists, hard cap, console clipping, takeover counters, ref memory, open's cookie-encryption switches.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { FORGOTTEN_CAP, RefRegistry } from '../../src/browser/refs.js';
import { CONSOLE_MESSAGE_CAP, clipConsoleText } from '../../src/browser/tabs.js';
import { openChromeArgs } from '../../src/cli/open.js';
import { ConfigError, parseConfig } from '../../src/config.js';
import { CUT_NOTE, capResult } from '../../src/dispatch.js';
import type { ToolResult } from '../../src/tools/types.js';
import { checkNavigation, checkOrigin, guardLanding, type UrlPolicy } from '../../src/util/urls.js';

describe('URL policy (item 1)', () => {
  let base: string;
  let root: string;
  let policy: UrlPolicy;
  before(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'motorika-unit-urls-')));
    root = join(base, 'root');
    mkdirSync(join(root, 'docs'), { recursive: true });
    mkdirSync(join(root, '.ssh'), { recursive: true });
    mkdirSync(join(base, 'outside'), { recursive: true });
    writeFileSync(join(root, 'docs', 'a.html'), '<p>a</p>');
    writeFileSync(join(root, '.env'), 'SECRET=1');
    writeFileSync(join(root, '.ssh', 'id_rsa'), 'key');
    writeFileSync(join(base, 'outside', 'b.txt'), 'b');
    symlinkSync(join(base, 'outside', 'b.txt'), join(root, 'link.txt'));
    policy = { fileRoots: [root], allowHiddenFiles: false, allowChromeUrls: false, blockedOrigins: [], allowedOrigins: [] };
  });
  after(() => rmSync(base, { recursive: true, force: true }));
  const url = (p: string) => pathToFileURL(p).href;

  it('file: inside a root is allowed (files and directories)', () => {
    assert.deepEqual(checkNavigation(url(join(root, 'docs', 'a.html')), policy), { ok: true });
    assert.deepEqual(checkNavigation(url(join(root, 'docs')), policy), { ok: true });
  });
  it('file: outside the roots, via a symlink, or hidden is refused; view-source:file: too', () => {
    for (const u of [
      url(join(base, 'outside', 'b.txt')),
      url(join(root, 'link.txt')),
      url(join(root, '.env')),
      url(join(root, '.ssh', 'id_rsa')),
      `view-source:${url(join(root, '.env'))}`,
      'file:///etc/passwd',
    ]) {
      const v = checkNavigation(u, policy);
      assert.equal(v.ok, false, u);
    }
    const hidden = checkNavigation(url(join(root, '.env')), policy);
    assert.ok(!hidden.ok && /--allow-hidden-files/.test(hidden.hint));
    const out = checkNavigation('file:///etc/passwd', policy);
    assert.ok(!out.ok && /--allow-file-root/.test(out.hint));
  });
  it('--allow-hidden-files widens dot-files inside a root', () => {
    assert.deepEqual(checkNavigation(url(join(root, '.env')), { ...policy, allowHiddenFiles: true }), { ok: true });
  });
  it('internal pages need --allow-chrome-urls; about:blank and about:srcdoc never do', () => {
    for (const u of ['chrome://version', 'chrome-untrusted://x', 'chrome-extension://abc/p.html', 'chrome-search://local', 'devtools://devtools/x', 'about:version', 'about:settings', 'view-source:chrome://version']) {
      const v = checkNavigation(u, policy);
      assert.ok(!v.ok && /--allow-chrome-urls/.test(v.hint), u);
      assert.deepEqual(checkNavigation(u, { ...policy, allowChromeUrls: true }), { ok: true }, u);
    }
    assert.deepEqual(checkNavigation('about:blank', policy), { ok: true });
    assert.deepEqual(checkNavigation('about:srcdoc', policy), { ok: true });
  });
  it('http(s) and data: stay unrestricted by default', () => {
    for (const u of ['https://example.com/', 'http://127.0.0.1:8080/x', 'data:text/html,hi', 'view-source:https://example.com/']) {
      assert.deepEqual(checkNavigation(u, policy), { ok: true }, u);
    }
  });
  it('the landing guard only judges file: URLs', () => {
    assert.equal(guardLanding(url(join(root, '.env')), policy).ok, false);
    assert.equal(guardLanding(url(join(root, 'docs', 'a.html')), policy).ok, true);
    assert.equal(guardLanding('chrome-error://chromewebdata/', policy).ok, true);
    assert.equal(guardLanding('https://x.example/', policy).ok, true);
  });
});

describe('origin lists (item 2)', () => {
  const p = (blocked: string[], allowed: string[]): UrlPolicy => ({ fileRoots: [], allowHiddenFiles: false, allowChromeUrls: false, blockedOrigins: blocked, allowedOrigins: allowed });
  it('a host entry matches the host and its subdomains', () => {
    const pol = p(['bank.example'], []);
    for (const u of ['https://bank.example/', 'https://www.bank.example/x', 'wss://api.bank.example/ws']) assert.equal(checkOrigin(u, pol).ok, false, u);
    for (const u of ['https://notbank.example/', 'https://bank.example.evil.test/']) assert.equal(checkOrigin(u, pol).ok, true, u);
  });
  it('a *. entry matches subdomains only', () => {
    const pol = p(['*.bank.example'], []);
    assert.equal(checkOrigin('https://www.bank.example/', pol).ok, false);
    assert.equal(checkOrigin('https://bank.example/', pol).ok, true);
  });
  it('a full origin matches scheme, host and port exactly (ws(s) maps to http(s))', () => {
    const pol = p(['https://mail.google.com'], []);
    assert.equal(checkOrigin('https://mail.google.com/mail/u/0', pol).ok, false);
    assert.equal(checkOrigin('wss://mail.google.com/x', pol).ok, false);
    assert.equal(checkOrigin('http://mail.google.com/', pol).ok, true);
    assert.equal(checkOrigin('https://mail.google.com:8443/', pol).ok, true);
  });
  it('the blocked error names the flag and the host', () => {
    const v = checkNavigation('https://www.bank.example/login', p(['bank.example'], []));
    assert.ok(!v.ok);
    assert.equal(v.reason, 'blocked by --blocked-origins: www.bank.example');
    const w = checkNavigation('https://other.example/', p([], ['docs.example']));
    assert.ok(!w.ok && w.reason === 'blocked by --allowed-origins: other.example');
  });
  it('allowed list: only listed hosts load; non-web schemes are not affected', () => {
    const pol = p([], ['docs.example', 'https://127.0.0.1:9000']);
    assert.equal(checkOrigin('https://a.docs.example/', pol).ok, true);
    assert.equal(checkOrigin('https://127.0.0.1:9000/', pol).ok, true);
    assert.equal(checkOrigin('https://127.0.0.1:9001/', pol).ok, false);
    assert.equal(checkOrigin('data:text/html,x', pol).ok, true);
  });
  it('flags and env parse, comma-separated and repeatable; bad entries are refused', () => {
    const c = parseConfig(['--blocked-origins', 'Bank.example, *.mail.example', '--blocked-origins=https://x.example'], { MOTORIKA_ALLOWED_ORIGINS: 'docs.example' }, '/w');
    assert.deepEqual(c.blockedOrigins, ['bank.example', '*.mail.example', 'https://x.example']);
    assert.deepEqual(c.allowedOrigins, ['docs.example']);
    assert.equal(parseConfig([], {}, '/w').blockedOrigins.length, 0);
    assert.equal(parseConfig(['--allow-chrome-urls'], {}, '/w').allowChromeUrls, true);
    assert.equal(parseConfig([], { MOTORIKA_ALLOW_CHROME_URLS: '1' }, '/w').allowChromeUrls, true);
    assert.throws(() => parseConfig(['--blocked-origins', 'https://x.example/path'], {}, '/w'), ConfigError);
  });
});

describe('hard output cap (item 4)', () => {
  const text = (...parts: string[]): ToolResult => ({ content: parts.map((t) => ({ type: 'text' as const, text: t })) });
  const totalText = (r: ToolResult) => r.content.reduce((n, c) => n + (c.type === 'text' ? c.text.length : 0), 0);
  it('under the cap: unchanged', () => {
    const r = text('a\nb');
    assert.equal(capResult(r, 100), r);
  });
  it('over the cap: cut at a line boundary, note inside the cap, across all parts', () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i} ${'x'.repeat(i % 30)}`).join('\n');
    for (const max of [200, 1000, 5000]) {
      const r = capResult(text('notice: n', lines, 'tail part'), max);
      assert.ok(totalText(r) <= max, `${totalText(r)} > ${max}`);
      const all = r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
      assert.ok(all.endsWith(CUT_NOTE(max)), all.slice(-80));
      const body = all.slice(0, -CUT_NOTE(max).length - 1);
      for (const l of body.split('\n')) assert.ok(l === 'notice: n' || lines.split('\n').includes(l), `partial line: ${l}`);
    }
  });
  it('keeps images and the isError flag', () => {
    const r = capResult({ content: [{ type: 'text', text: 'y'.repeat(500) }, { type: 'image', data: 'AA', mimeType: 'image/png' }], isError: true }, 100);
    assert.equal(r.isError, true);
    assert.ok(r.content.some((c) => c.type === 'image'));
  });
});

describe('console messages are clipped to 4,096 chars ending with … (item 3)', () => {
  it('long message', () => {
    const t = clipConsoleText('z'.repeat(1_000_000));
    assert.equal(t.length, CONSOLE_MESSAGE_CAP);
    assert.ok(t.endsWith('…'));
  });
  it('short message unchanged', () => assert.equal(clipConsoleText('hello'), 'hello'));
});

describe('refs: memory and takeover (P1, W2, item 8)', () => {
  const issue = (r: RefRegistry<string>, tabId: string, frame: string, docId: string, localId: number, unique?: boolean) =>
    r.issue({ tabId, frame, docId, localId, role: 'button', name: 'Save', unique });

  it('W2: an issuer that did not compute uniqueness keeps the stored flag', () => {
    const r = new RefRegistry<string>();
    const a = issue(r, 't1', 'f1', 'd', 1, true);
    issue(r, 't1', 'f1', 'd', 1, undefined);
    assert.equal(r.get(a)?.unique, true);
    issue(r, 't1', 'f1', 'd', 1, false);
    assert.equal(r.get(a)?.unique, false);
  });
  it('a record whose frame label no longer resolves is an earlier document, not a pinned frame', () => {
    const live = new Set(['f1']);
    const r = new RefRegistry<string>({ label: (_t, f) => f, resolve: (_t, l) => (live.has(l) ? l : undefined) });
    const a = issue(r, 't1', 'f1', 'd', 1);
    const b = issue(r, 't1', 'f2', 'd2', 1);
    assert.equal(r.get(a)?.frame, 'f1');
    assert.equal(r.get(b), undefined);
    assert.deepEqual(r.whyMissing(b), { reason: 'old-doc', tabId: 't1' });
  });
  it('forgetFrameBefore drops the old document of a frame and keeps refs issued after the commit', async () => {
    const r = new RefRegistry<string>();
    const old = issue(r, 't1', 'f1', 'old', 1);
    await new Promise((res) => setTimeout(res, 5));
    const commit = Date.now();
    await new Promise((res) => setTimeout(res, 5));
    const fresh = issue(r, 't1', 'f1', 'new', 1);
    const other = issue(r, 't2', 'f1', 'x', 1);
    r.forgetFrameBefore('t1', 'f1', commit);
    assert.equal(r.get(old), undefined);
    assert.equal(r.whyMissing(old).reason, 'old-doc');
    assert.ok(r.get(fresh));
    assert.ok(r.get(other));
  });
  it('forgetFrame drops refs of a detached frame', () => {
    const r = new RefRegistry<string>();
    const a = issue(r, 't1', 'f2', 'd', 1);
    const b = issue(r, 't1', 'f1', 'd0', 1);
    r.forgetFrame('t1', 'f2');
    assert.equal(r.get(a), undefined);
    assert.ok(r.get(b));
  });
  it('forgotten-ref reasons are capped (~10k), so they cannot grow forever', () => {
    const r = new RefRegistry<string>();
    for (let i = 0; i < FORGOTTEN_CAP + 500; i++) issue(r, 't1', 'f1', `d${i}`, 1);
    r.forgetTab('t1');
    assert.equal(r.size, 0);
    assert.ok(r.forgottenSize <= FORGOTTEN_CAP);
    assert.equal(r.whyMissing(FORGOTTEN_CAP + 500).reason, 'closed-tab', 'the most recent keep their reason');
  });
  it('item 8: after a takeover, numbering continues above what was seen; older refs are a previous session', () => {
    const r = new RefRegistry<string>();
    r.continueAbove(41);
    assert.equal(issue(r, 't1', 'f1', 'd', 1), 42);
    assert.equal(r.whyMissing(7).reason, 'previous-session');
    assert.equal(r.whyMissing(500).reason, 'unknown');
  });
});

describe('open: same cookie-encryption mode as the agent (item 12 / A12)', () => {
  const o = { url: 'https://accounts.google.com', profileDir: '/p', headless: false, executablePath: undefined };
  it('macOS adds --use-mock-keychain, Linux --password-store=basic, still no automation flags', () => {
    const mac = openChromeArgs(o, 'darwin');
    const linux = openChromeArgs(o, 'linux');
    assert.ok(mac.includes('--use-mock-keychain') && !mac.includes('--password-store=basic'));
    assert.ok(linux.includes('--password-store=basic') && !linux.includes('--use-mock-keychain'));
    for (const a of [...mac, ...linux]) assert.ok(!/^--(enable-automation|remote-debugging-)/.test(a), a);
    assert.equal(mac[mac.length - 1], 'https://accounts.google.com');
  });
});
