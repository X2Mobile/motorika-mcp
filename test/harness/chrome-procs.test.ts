// Harness: the process helpers that A4/A6-A11/G2 rely on find, check and clean up exactly the Chrome
// processes the suite started.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { startFixtureServer, type FixtureServer } from '../support/fixture-server.ts';
import { freshDir, TEST_ROOT } from '../support/paths.ts';
import {
  cdpEvaluate,
  chromeUnder,
  chromeWithProfile,
  pidAlive,
  startThrowawayChrome,
  tcpListeners,
  waitNoChromeUnder,
} from '../support/procs.ts';
import { launchPw } from '../support/pw.ts';

let fx: FixtureServer;
before(async () => {
  fx = await startFixtureServer();
});
after(async () => {
  await fx.close();
});

describe('process helpers', () => {
  test('throwaway Chrome: DevToolsActivePort, /json/list, raw CDP, found under the root, TCP listener caught, stop leaves nothing', async () => {
    const dir = freshDir('tw');
    const udd = join(dir, 'udd');
    mkdirSync(udd);
    const c = await startThrowawayChrome(udd, fx.url('/click.html'));
    try {
      assert.ok(existsSync(join(udd, 'DevToolsActivePort')));
      assert.match(c.wsEndpoint, /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[\w-]+$/);
      const targets = await c.listTargets();
      const page = targets.find((t) => t.type === 'page' && t.url.includes('/click.html'));
      assert.ok(page?.webSocketDebuggerUrl, 'the tab is listed by Chrome itself');
      await cdpEvaluate(page.webSocketDebuggerUrl, "document.getElementById('plain').click()");
      assert.deepEqual(await cdpEvaluate(page.webSocketDebuggerUrl, 'JSON.stringify(window.__counts)'), '{"plain":1}');

      const mains = await chromeUnder(dir, { mainOnly: true });
      assert.deepEqual(mains.map((p) => p.pid), [c.pid], 'the main process is found by --user-data-dir prefix');
      assert.equal((await chromeWithProfile(udd, { mainOnly: true })).length, 1);
      assert.ok((await chromeUnder(dir)).length >= 2, 'helper processes carry the flag too');
      // must-catch for A10/A4e: a debugging port IS a TCP listener
      const all = (await chromeUnder(dir)).map((p) => p.pid);
      const listeners = await tcpListeners(all);
      assert.ok(listeners.some((l) => l.includes(`:${c.port}`)), `lsof must see port ${c.port}:\n${listeners.join('\n')}`);
    } finally {
      await c.stop();
    }
    assert.equal(pidAlive(c.pid), false);
    assert.deepEqual(await waitNoChromeUnder(dir, 5000), []);
  });

  test('must-allow for A10: a pipe-transport Chrome (playwright launch) has no TCP listener', async () => {
    const pw = await launchPw();
    try {
      const p = await pw.page();
      await p.goto(fx.url('/nav-a.html'));
      const procs = await chromeUnder(pw.root);
      assert.ok(procs.length > 0, 'found under its root');
      assert.deepEqual(await tcpListeners(procs.map((x) => x.pid)), []);
    } finally {
      await pw.close();
    }
    assert.deepEqual(await waitNoChromeUnder(pw.root, 5000), []);
  });

  test('Chrome starts with TMPDIR and HOME pointed into the short test root (A4 hermetic HOME)', async () => {
    const home = freshDir('home');
    const pw = await launchPw({ env: { HOME: home } });
    try {
      const p = await pw.page();
      await p.goto(fx.url('/nav-b.html'));
      assert.equal(await p.title(), 'Nav B');
    } finally {
      await pw.close();
    }
  });

  test('the test root is short enough for Unix socket paths', () => {
    // <root>/<tag><n>-<pid>/tmp/ + .com.google.Chrome.XXXXXX/SingletonSocket (41), and
    // <root>/home<n>-<pid>/ + .motorika/run/<12hex>.sock (31): both must stay under 104 bytes.
    const perServer = '/s99-99999/tmp/'.length;
    assert.ok(TEST_ROOT.length + perServer + 41 < 104, `test root too long: ${TEST_ROOT}`);
    assert.ok(TEST_ROOT.length + '/home99-99999/'.length + 31 < 104, `test root too long: ${TEST_ROOT}`);
  });
});
