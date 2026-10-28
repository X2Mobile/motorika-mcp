// Acceptance group A: session and modes. Every test starts its own server(s), so no Chrome slot is held
// between tests and multi-Chrome tests (A4) acquire their slots atomically.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { startFixtureServer, type FixtureServer } from '../support/fixture-server.ts';
import { parseTabsList, parseSnapshot, refOf } from '../support/grammar.ts';
import { assertBuilt, assertNoOrphans, startServer, type ServerHandle } from '../support/mcp-client.ts';
import { freshDir, SERVER_ENTRY } from '../support/paths.ts';
import {
  cdpEvaluate,
  chromeUnder,
  chromeWithProfile,
  pidAlive,
  startThrowawayChrome,
  tcpListeners,
  waitNoChromeUnder,
} from '../support/procs.ts';
import { acquireSlots } from '../support/slots.ts';

const TOOLS = [
  'session', 'tabs', 'navigate', 'snapshot', 'screenshot', 'read', 'find', 'click', 'type', 'fill_form', 'press',
  'hover', 'scroll', 'drag', 'upload', 'dialog', 'wait', 'evaluate', 'video', 'console', 'network', 'batch',
];

let fx: FixtureServer;
const roots: string[] = [];

before(async () => {
  assertBuilt();
  fx = await startFixtureServer();
});
after(async () => {
  await fx?.close();
  await assertNoOrphans(roots); // G2 for this file
});

/** Registers a directory for this file's G2 sweep (persistent profiles live outside server roots). */
function track(dir: string): string {
  roots.push(dir);
  return dir;
}

async function server(label: string, opts: Parameters<typeof startServer>[0] = {}): Promise<ServerHandle> {
  const s = await startServer({ label, ...opts });
  roots.push(s.root);
  return s;
}

/** The first line of a result is a notice when it is not the normal `[tN] navigated` line. */
function startsWithNotice(text: string): boolean {
  const first = text.split('\n')[0] ?? '';
  return first.trim() !== '' && !/^\[t\d+\] navigated /.test(first);
}

describe('A session and modes', () => {
  test('A1 initialize + tools/list answer within 1 s and start no Chrome', async () => {
    const lease = await acquireSlots(1, 'a1'); // the slot wait must not count against the server
    const t0 = performance.now();
    const s = await server('a1', { slots: 0 });
    try {
      const { tools } = await s.client.listTools();
      const ms = performance.now() - t0;
      assert.ok(ms <= 1000, `initialize + tools/list took ${Math.round(ms)} ms`);
      assert.deepEqual(tools.map((t) => t.name).sort(), [...TOOLS].sort());
      await sleep(500);
      assert.deepEqual(await chromeUnder(s.root), [], 'no Chrome before the first tool call that needs one');
    } finally {
      await s.close();
      lease.release();
    }
  });

  test('A3 a cookie survives a server restart on the same --profile-dir', async () => {
    const profile = join(track(freshDir('a3')), 'profile');
    const value = `a3-${Date.now()}`;
    const flags = ['--profile-dir', profile];
    const s1 = await server('a3-1', { isolated: false, flags });
    try {
      await s1.ok('navigate', { url: fx.url(`/set-cookie?v=${value}`) });
    } finally {
      await s1.close();
    }
    assert.deepEqual(await waitNoChromeUnder(profile, 5000), []);
    fx.reset();
    const s2 = await server('a3-2', { isolated: false, flags });
    try {
      await s2.ok('navigate', { url: fx.url('/echo-cookie') });
      const rec = fx.records((r) => r.path === '/echo-cookie')[0];
      assert.ok(rec, 'the fixture saw the request');
      assert.match(rec.headers.cookie ?? '', new RegExp(`motorika_acc=${value}`));
    } finally {
      await s2.close();
    }
  });

  // PLAN amendment 2026-10-21 (main 754e079): A4 replaced: a second server JOINS the first one's browser.
  // CONTRACT-QUESTION: the socket lives at ~/.motorika/run/; the contract does not say whether HOME is
  // honoured for "~". This test sets HOME to a test dir (hermetic) and expects the socket under it.
  test('A4 a second server on the same profile joins the first browser (cookie, one Chrome, own tabs, takeover, socket)', async () => {
    // One slot: the criterion itself asserts exactly one Chrome on the profile (b).
    const lease = await acquireSlots(1, 'a4');
    const home = track(freshDir('home'));
    const profile = join(track(freshDir('a4')), 'profile');
    const opts = { isolated: false, flags: ['--profile-dir', profile], env: { HOME: home }, slots: 0 };
    let s1: ServerHandle | undefined;
    let s2: ServerHandle | undefined;
    try {
      s1 = await server('a4-1', opts);
      const r1 = await s1.ok('navigate', { url: fx.url('/nav-a.html') });
      await s1.ok('evaluate', { script: 'document.cookie = "motorika_join=one; max-age=3600; path=/"' });
      s2 = await server('a4-2', opts);
      const r2 = await s2.ok('navigate', { url: fx.url('/nav-b.html') });

      // (a) the cookie set through server 1 is visible through server 2 on the same origin
      const cookie = await s2.state<string>('document.cookie');
      assert.match(cookie, /motorika_join=one/, '(a) cookie shared');

      // (b) exactly one Chrome uses the profile dir
      const mains = await chromeWithProfile(profile, { mainOnly: true });
      assert.equal(mains.length, 1, `(b) one Chrome on the profile, got ${mains.map((p) => p.pid).join(',')}`);

      // (c) server 2 lists only its own tabs; ids and refs do not collide
      const l1 = parseTabsList((await s1.ok('tabs', { action: 'list' })).text);
      const l2 = parseTabsList((await s2.ok('tabs', { action: 'list' })).text);
      assert.ok(l2.length >= 1 && l2.every((t) => !t.url.includes('/nav-a.html')), `(c) server 2 sees only its tabs:\n${l2.map((t) => t.raw).join('\n')}`);
      assert.ok(l1.some((t) => t.url.includes('/nav-a.html')));
      assert.deepEqual(l1.map((t) => t.id).filter((id) => l2.some((t) => t.id === id)), [], '(c) tab ids do not collide');
      const refs1 = new Set(parseSnapshot(r1.text).elements.map((e) => e.ref));
      const refs2 = parseSnapshot(r2.text).elements.map((e) => e.ref);
      assert.deepEqual(refs2.filter((r) => refs1.has(r)), [], '(c) refs do not collide');

      // (e) user-only socket at ~/.motorika/run/<12 hex of sha1(realpath(profile))>.sock; no TCP listeners
      const hash = createHash('sha1').update(realpathSync(profile)).digest('hex').slice(0, 12);
      const sock = join(home, '.motorika', 'run', `${hash}.sock`);
      const st = statSync(sock);
      assert.ok(st.isSocket(), `(e) ${sock} is a socket`);
      assert.equal(st.mode & 0o777, 0o600, '(e) socket mode 0600');
      assert.equal(statSync(join(home, '.motorika', 'run')).mode & 0o777, 0o700, '(e) dir mode 0700');
      const pids = [s1.pid, s2.pid, ...(await chromeWithProfile(profile)).map((p) => p.pid)];
      assert.deepEqual(await tcpListeners(pids), [], '(e) no TCP listener on servers or Chrome');

      // (d) server 1 exits; server 2's next call takes over with a notice and the cookie survives
      await s1.close();
      s1 = undefined;
      const r3 = await s2.ok('navigate', { url: fx.url('/nav-a.html') });
      assert.ok(startsWithNotice(r3.text), `(d) takeover notice first:\n${r3.text.slice(0, 300)}`);
      assert.match(r3.text, /navigated/);
      assert.match(await s2.state<string>('document.cookie'), /motorika_join=one/, '(d) cookie still there');
    } finally {
      await s1?.close();
      await s2?.close();
      lease.release();
    }
    assert.deepEqual(await waitNoChromeUnder(profile, 5000), []);
  });

  test(
    'A5 session launch with a different headless value switches mode; tabs not carried over; cookies survive',
    { skip: process.env.MOTORIKA_TEST_HEADED === '1' ? false : 'switches to a headed window; run with MOTORIKA_TEST_HEADED=1 (headed runs are recorded under A2)' },
    async () => {
      const profile = join(track(freshDir('a5')), 'profile');
      const s = await server('a5', { isolated: false, flags: ['--profile-dir', profile] });
      try {
        await s.ok('navigate', { url: fx.url('/set-cookie?v=a5') });
        assert.match((await s.ok('session', { action: 'status' })).text, /\bheadless=true\b/);
        const r = await s.ok('session', { action: 'launch', headless: false });
        // CONTRACT-QUESTION: no fixed token for "tabs were not carried over"; asserting it mentions tabs.
        assert.match(r.text, /tab/i);
        assert.match((await s.ok('session', { action: 'status' })).text, /\bheadless=false\b/);
        fx.reset();
        await s.ok('navigate', { url: fx.url('/echo-cookie') });
        assert.match(fx.records((x) => x.path === '/echo-cookie')[0]?.headers.cookie ?? '', /motorika_acc=a5/);
      } finally {
        await s.close();
      }
    },
  );

  test('A6 after Chrome is killed, the next call relaunches with a notice and does not hang', async () => {
    const s = await server('a6');
    try {
      await s.ok('navigate', { url: fx.url('/nav-a.html') });
      const mains = await chromeUnder(s.root, { mainOnly: true });
      assert.equal(mains.length, 1, 'one browser process under this server');
      process.kill(mains[0]!.pid, 'SIGKILL');
      for (let i = 0; i < 50 && pidAlive(mains[0]!.pid); i++) await sleep(100);
      const r = await s.ok('navigate', { url: fx.url('/nav-b.html') });
      assert.ok(startsWithNotice(r.text), `notice first:\n${r.text.slice(0, 300)}`);
      assert.match(r.text, /nav-b\.html/);
      const again = await chromeUnder(s.root, { mainOnly: true });
      assert.equal(again.length, 1);
      assert.notEqual(again[0]!.pid, mains[0]!.pid);
    } finally {
      await s.close();
    }
  });

  for (const how of ['stdin close', 'SIGTERM'] as const) {
    test(`A7 after ${how}, no launch-mode Chrome remains within 5 s`, async () => {
      const s = await server(`a7-${how}`);
      try {
        await s.ok('navigate', { url: fx.url('/nav-a.html') });
        assert.ok((await chromeUnder(s.root)).length > 0, 'Chrome is running before exit');
        if (how === 'stdin close') s.closeStdin();
        else process.kill(s.pid, 'SIGTERM');
        const left = await waitNoChromeUnder(s.root, 5000);
        assert.deepEqual(left.map((p) => p.pid), [], `Chrome left after ${how}`);
        assert.ok(await s.waitExit(5000), 'the server process exits');
      } finally {
        await s.close();
      }
    });
  }

  // CONTRACT-QUESTION: harness rule says servers run with --headless --isolated; for attach modes those
  // launch options are omitted here (the attached Chrome decides). Proposed: say so in the harness rules.
  test('A8 connect mode acts on the existing tab and leaves the attached Chrome running', async () => {
    const dir = track(freshDir('a8'));
    const udd = join(dir, 'udd');
    mkdirSync(udd);
    const c = await startThrowawayChrome(udd, fx.url('/click.html'));
    try {
      const s = await server('a8', { headless: false, isolated: false, slots: 0, flags: ['--cdp-endpoint', c.httpEndpoint] });
      try {
        const tabs = parseTabsList((await s.ok('tabs', { action: 'list' })).text);
        const t = tabs.find((x) => x.url.includes('/click.html'));
        assert.ok(t, `existing tab listed:\n${tabs.map((x) => x.raw).join('\n')}`);
        const snap = await s.snapshot({ tab: t.id });
        await s.ok('click', { target: refOf(snap, 'button', 'Plain'), tab: t.id });
      } finally {
        await s.close();
      }
      assert.equal(c.process.exitCode, null, 'attached Chrome still running');
      assert.ok(pidAlive(c.pid));
      const page = (await c.listTargets()).find((x) => x.type === 'page' && x.url.includes('/click.html'));
      assert.ok(page?.webSocketDebuggerUrl, 'its tab survives (own /json/list)');
      assert.equal(await cdpEvaluate(page.webSocketDebuggerUrl, 'JSON.stringify(window.__counts)'), '{"plain":1}', 'the click landed');
    } finally {
      await c.stop();
    }
  });

  test('A9 auto-connect reads DevToolsActivePort and attaches; without the file the error names chrome://inspect', async () => {
    const dir = track(freshDir('a9'));
    const udd = join(dir, 'udd');
    mkdirSync(udd);
    const c = await startThrowawayChrome(udd, fx.url('/click.html'));
    try {
      const s = await server('a9', { headless: false, isolated: false, slots: 0, flags: ['--auto-connect', '--chrome-user-data-dir', udd] });
      try {
        const tabs = parseTabsList((await s.ok('tabs', { action: 'list' })).text);
        const t = tabs.find((x) => x.url.includes('/click.html'));
        assert.ok(t, 'existing tab listed');
        const snap = await s.snapshot({ tab: t.id });
        await s.ok('click', { target: refOf(snap, 'button', 'Plain'), tab: t.id });
      } finally {
        await s.close();
      }
      assert.ok(pidAlive(c.pid), 'attached Chrome still running');
      const page = (await c.listTargets()).find((x) => x.type === 'page' && x.url.includes('/click.html'));
      assert.equal(await cdpEvaluate(page!.webSocketDebuggerUrl!, 'JSON.stringify(window.__counts)'), '{"plain":1}');
    } finally {
      await c.stop();
    }
    const empty = freshDir('a9e');
    const s2 = await server('a9-missing', { headless: false, isolated: false, slots: 0, flags: ['--auto-connect', '--chrome-user-data-dir', empty] });
    try {
      const r = await s2.err('navigate', { url: fx.url('/nav-a.html') });
      assert.ok(r.text.includes('chrome://inspect/#remote-debugging'), r.text);
    } finally {
      await s2.close();
    }
  });

  test('A10 a launch-mode Chrome (and the server) has no TCP listening socket', async () => {
    const s = await server('a10');
    try {
      await s.ok('navigate', { url: fx.url('/nav-a.html') });
      const procs = await chromeUnder(s.root);
      assert.ok(procs.length > 0);
      assert.deepEqual(await tcpListeners([s.pid, ...procs.map((p) => p.pid)]), []);
    } finally {
      await s.close();
    }
  });

  // PLAN amendment 2026-10-21 (main 754e079): `motorika open [url] [--profile-dir <dir>] [--headless]`.
  test('A11 open starts a plain Chrome on the profile (no automation flags), exits with it, and exits 2 when a server owns the profile', async () => {
    const run = (args: string[], env: NodeJS.ProcessEnv): ChildProcess =>
      spawn(process.execPath, [SERVER_ENTRY, 'open', ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const exit = (p: ChildProcess, ms: number): Promise<number | null | 'timeout'> =>
      new Promise((resolve) => {
        if (p.exitCode !== null) return resolve(p.exitCode);
        const t = setTimeout(() => resolve('timeout'), ms);
        p.once('exit', (code) => {
          clearTimeout(t);
          resolve(code);
        });
      });

    // 1) plain Chrome, then it exits when that Chrome exits
    const dir = track(freshDir('a11'));
    const profile = join(dir, 'profile');
    const env = { TMPDIR: dir + '/', HOME: freshDir('home') };
    const lease = await acquireSlots(1, 'a11');
    let open: ChildProcess | undefined;
    try {
      open = run([fx.url('/nav-a.html'), '--profile-dir', profile, '--headless'], env);
      let mains: Awaited<ReturnType<typeof chromeWithProfile>> = [];
      for (let i = 0; i < 150 && mains.length === 0; i++) {
        mains = await chromeWithProfile(profile, { mainOnly: true });
        if (mains.length === 0) await sleep(100);
      }
      assert.equal(mains.length, 1, 'open started one Chrome with --user-data-dir=<profile>');
      const cmd = mains[0]!.command;
      assert.ok(!/--enable-automation\b/.test(cmd), `no --enable-automation:\n${cmd}`);
      assert.ok(!/--remote-debugging-/.test(cmd), `no --remote-debugging-*:\n${cmd}`);
      process.kill(mains[0]!.pid, 'SIGTERM');
      const code = await exit(open, 10_000);
      assert.notEqual(code, 'timeout', 'open exits when its Chrome exits');
    } finally {
      if (open && open.exitCode === null) open.kill('SIGKILL');
      for (const p of await chromeWithProfile(profile)) process.kill(p.pid, 'SIGKILL');
      lease.release();
    }

    // 2) a server owns the profile: open exits with code 2 and starts no second Chrome
    const profile2 = join(track(freshDir('a11b')), 'profile');
    // hermetic: the owner's socket goes under a test HOME, never the real ~/.motorika/run
    const home2 = freshDir('home');
    const s = await server('a11-owner', { isolated: false, flags: ['--profile-dir', profile2], env: { HOME: home2 } });
    let open2: ChildProcess | undefined;
    try {
      await s.ok('navigate', { url: fx.url('/nav-a.html') });
      open2 = run(['--profile-dir', profile2, '--headless'], { TMPDIR: s.tmpDir + '/', HOME: home2 });
      assert.equal(await exit(open2, 10_000), 2, 'exit code 2 when a server owns the profile');
      assert.equal((await chromeWithProfile(profile2, { mainOnly: true })).length, 1, 'no second Chrome');
    } finally {
      if (open2 && open2.exitCode === null) open2.kill('SIGKILL');
      await s.close();
      // a misbehaving `open` must not outlive the test
      for (const p of await chromeWithProfile(profile2)) process.kill(p.pid, 'SIGKILL');
    }
  });
});
