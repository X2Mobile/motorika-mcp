// Sharing (PLAN amendment "one logged-in agent browser"), open subcommand args, and call budgets (Q1).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { budgetOf, errorText } from '../../src/dispatch.js';
import { openChromeArgs, parseOpenArgs } from '../../src/cli/open.js';
import { JoinClient } from '../../src/shared/joiner.js';
import { OwnerServer, probeSocket } from '../../src/shared/owner.js';
import { runDir, socketPathFor } from '../../src/shared/paths.js';

const CFG = { actionTimeout: 10000, navigationTimeout: 30000 };

describe('call budgets (contract Q1)', () => {
  it('navigation timeout for navigate, tabs new with url, session launch', () => {
    assert.equal(budgetOf('navigate', {}, CFG), 30000);
    assert.equal(budgetOf('tabs', { action: 'new', url: 'x' }, CFG), 30000);
    assert.equal(budgetOf('tabs', { action: 'new' }, CFG), 10000);
    assert.equal(budgetOf('session', { action: 'launch' }, CFG), 30000);
    assert.equal(budgetOf('session', { action: 'status' }, CFG), 10000);
  });
  it('timeout_ms replaces the default', () => {
    assert.equal(budgetOf('navigate', { timeout_ms: 800 }, CFG), 800);
    assert.equal(budgetOf('click', { timeout_ms: 300 }, CFG), 300);
  });
  it('wait: ms for an ms wait, else the action timeout', () => {
    assert.equal(budgetOf('wait', { ms: 2500 }, CFG), 2500);
    assert.equal(budgetOf('wait', { text: 'x' }, CFG), 10000);
  });
  it('video frames: duration_ms + action timeout with every_ms, else navigation timeout', () => {
    assert.equal(budgetOf('video', { action: 'frames', every_ms: 500, duration_ms: 2000 }, CFG), 12000);
    assert.equal(budgetOf('video', { action: 'frames', times: [1] }, CFG), 30000);
    assert.equal(budgetOf('video', { action: 'list' }, CFG), 10000);
  });
  it('batch: the sum of its steps', () => {
    assert.equal(
      budgetOf('batch', { steps: [{ tool: 'navigate', args: {} }, { tool: 'click', args: { target: 'e1' } }, { tool: 'wait', args: { ms: 500 } }] }, CFG),
      30000 + 10000 + 500,
    );
  });
  it('everything else: the action timeout (fill_form included)', () => {
    for (const t of ['click', 'type', 'fill_form', 'snapshot', 'evaluate', 'tabs']) assert.equal(budgetOf(t, {}, CFG), 10000);
  });
});

describe('error shape (contract Q2)', () => {
  it('line 1 the cause, line 2 "hint: …"', () => {
    const [l1, l2, more] = errorText('e12 is stale (element removed)', 'take a new snapshot').split('\n');
    assert.equal(l1, 'e12 is stale (element removed)');
    assert.equal(l2, 'hint: take a new snapshot');
    assert.equal(more, undefined);
  });
});

describe('open subcommand arguments (A11)', () => {
  it('url, --profile-dir, --headless', () => {
    const o = parseOpenArgs(['https://accounts.google.com', '--profile-dir', '/p/prof', '--headless'], {});
    assert.deepEqual(o, { url: 'https://accounts.google.com', profileDir: '/p/prof', headless: true, executablePath: undefined });
  });
  it('the Chrome command line carries the profile and no automation flags', () => {
    const args = openChromeArgs({ url: 'https://a.example/', profileDir: '/p/prof', headless: false, executablePath: undefined });
    assert.ok(args.includes('--user-data-dir=/p/prof'));
    assert.ok(args.every((a) => !/^--enable-automation\b/.test(a) && !/^--remote-debugging-/.test(a)), args.join(' '));
    assert.equal(args[args.length - 1], 'https://a.example/');
  });
  it('rejects unknown flags', () => {
    assert.throws(() => parseOpenArgs(['--remote-debugging-port=9222'], {}), /unknown flag/);
  });
});

describe('profile socket (amendment: user-only unix socket, never TCP)', () => {
  let home: string;
  let prevHome: string | undefined;
  let profile: string;
  before(() => {
    // Short base: unix socket paths are limited to 104 bytes on macOS.
    home = realpathSync(mkdtempSync('/tmp/motorika-unit-share-'));
    prevHome = process.env.HOME;
    process.env.HOME = home; // ~ = os.homedir(), which respects HOME (Q18)
    profile = join(home, 'prof');
  });
  after(() => {
    process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('path is ~/.motorika/run/<12 hex of sha1(realpath(profile))>.sock', () => {
    const p = socketPathFor(profile);
    const hash = createHash('sha1').update(realpathSync(profile)).digest('hex').slice(0, 12);
    assert.equal(p, join(home, '.motorika', 'run', `${hash}.sock`));
    assert.equal(runDir(), join(home, '.motorika', 'run'));
  });

  it('owner listens with 0600 in a 0700 dir; a joiner forwards calls under its own client id; close is seen', async () => {
    const path = socketPathFor(profile);
    const seen: { tool: string; client: string }[] = [];
    const dropped: string[] = [];
    const owner = new OwnerServer(path, {
      dispatch: async (tool, _args, clientId) => {
        seen.push({ tool, client: clientId });
        return { content: [{ type: 'text', text: `ran ${tool} for ${clientId}` }] };
      },
      dropClient: (id) => dropped.push(id),
    });
    try {
      assert.equal(await owner.listen(), 'ok');
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.equal(statSync(join(home, '.motorika', 'run')).mode & 0o777, 0o700);
      assert.equal(await probeSocket(path), 'live');
      const second = new OwnerServer(path, { dispatch: async () => ({ content: [] }), dropClient: () => undefined });
      assert.equal(await second.listen(), 'in-use', 'only one owner per profile');

      const c1 = await JoinClient.connect(path);
      const c2 = await JoinClient.connect(path);
      assert.ok(c1 && c2);
      assert.equal(c1.ownerPid, process.pid);
      const [r1, r2] = await Promise.all([c1.call('tabs', { action: 'list' }), c2.call('snapshot', {})]);
      const t1 = r1.content[0];
      const t2 = r2.content[0];
      assert.ok(t1?.type === 'text' && t2?.type === 'text');
      const id1 = /for (\S+)/.exec(t1.text)?.[1];
      const id2 = /for (\S+)/.exec(t2.text)?.[1];
      assert.ok(id1 && id2 && id1 !== id2 && id1 !== 'local', 'each joined session is its own client');
      c1.close();
      for (let i = 0; i < 50 && !dropped.includes(id1); i++) await new Promise((r) => setTimeout(r, 20));
      // (probe connections without calls are dropped too; they own nothing)
      assert.ok(dropped.includes(id1) && !dropped.includes(id2), `a disconnected session is dropped, the other stays: ${dropped.join(',')}`);
      await owner.close();
      for (let i = 0; i < 50 && !c2.closed; i++) await new Promise((r) => setTimeout(r, 20));
      assert.equal(c2.closed, true, 'joiners see the owner go away');
      const r3 = await c2.call('snapshot', {});
      assert.equal(r3.isError, true);
      assert.equal(await probeSocket(path), 'absent', 'the owner removes its socket');
    } finally {
      await owner.close();
    }
  });

  it('a stale socket file (no listener) is replaced', async () => {
    const path = socketPathFor(join(home, 'prof2'));
    mkdirSync(join(home, '.motorika', 'run'), { recursive: true });
    writeFileSync(path, '');
    assert.equal(await probeSocket(path), 'stale');
    const owner = new OwnerServer(path, { dispatch: async () => ({ content: [] }), dropClient: () => undefined });
    try {
      assert.equal(await owner.listen(), 'ok');
    } finally {
      await owner.close();
    }
  });
});
