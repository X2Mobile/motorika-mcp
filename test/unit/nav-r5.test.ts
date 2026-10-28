// Fix round 5, navigation (PLAN.md "2026-10-23: fix round 5 (nav)"): the decisions behind D1 that a real
// browser makes racy, pinned without one. The event orders come from measurements on Chrome 155 with
// Playwright 1.64.1 (PLAN block): a stopped request fails with net::ERR_ABORTED within a few ms; a navigation
// whose response arrived cannot be stopped, the stop is refused ("Not attached to an active page") and the
// commit lands 0-3 ms later, or once the old page's pagehide handlers have run.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, test } from 'node:test';
import type { Page } from 'playwright-core';
import { watchMainNav, withoutFragment } from '../../src/browser/navwatch.ts';
import type { DocEvent } from '../../src/browser/tabs.ts';
import type { Session } from '../../src/browser/session.ts';
import { RWLock } from '../../src/browser/session.ts';
import { newClient, type Tab } from '../../src/browser/tabs.ts';
import { parseConfig } from '../../src/config.ts';
import { Dispatcher, NAV_DEADLINE_HINT } from '../../src/dispatch.ts';
import { liveAlerts } from '../../src/page/effects.ts';
import { stillLoadingNote, stopBeforeCommit, stoppedHint, UNCONFIRMED_STOP_HINT } from '../../src/tools/navigate.ts';
import { defineTool, timeoutArg, type Tool } from '../../src/tools/types.ts';

/** The page's request events and the tab's CDP document events, driven by hand (round 7: document identity). */
class FakeTab {
  readonly page = Object.assign(new EventEmitter(), { mainFrame: () => this.main });
  readonly main = { url: () => this.url };
  url = 'http://a.test/start';
  mainLoaderId: string | undefined = 'L0';
  private readonly listeners = new Set<(e: DocEvent) => void>();
  async trackDocuments() {
    return true;
  }
  onDocument(l: (e: DocEvent) => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  private emit(e: DocEvent) {
    for (const l of [...this.listeners]) l(e);
  }
  request(url: string, frame: unknown = this.main) {
    const r = { url: () => url, isNavigationRequest: () => true, frame: () => frame, failure: () => ({ errorText: 'net::ERR_ABORTED' }) };
    this.page.emit('request', r);
    return r;
  }
  respond(r: unknown, status = 200) {
    this.page.emit('response', { request: () => r, status: () => status });
  }
  fail(r: unknown) {
    this.page.emit('requestfailed', r);
  }
  /** A new document commits (Page.frameNavigated with this loaderId). */
  commit(url: string, loaderId = `L${Math.random()}`, restore = false) {
    this.url = url;
    this.mainLoaderId = loaderId;
    this.emit({ kind: 'commit', loaderId, url, restore });
  }
  /** A same-document change (Page.navigatedWithinDocument): pushState, replaceState, a fragment. */
  same(url: string) {
    this.url = url;
    this.emit({ kind: 'same', url });
  }
  start(type: string, url: string) {
    this.emit({ kind: 'start', type, url });
  }
}

const asTab = (t: FakeTab) => t as unknown as Tab;
const later = (ms: number, f: () => void) => setTimeout(f, ms);

describe('watchMainNav: only a new document commits (round 7, document identity)', () => {
  test('redirect hops never commit; the final document does, with its response', async () => {
    const t = new FakeTab();
    const w = await watchMainNav(asTab(t));
    const hop = t.request('http://a.test/b');
    t.respond(hop, 302);
    t.request('http://a.test/a');
    assert.equal(w.committed, false, 'a 302 response is not a commit');
    t.respond(t.request('http://a.test/a'));
    t.commit('http://a.test/a#frag');
    assert.equal(w.committed, true);
    assert.equal(await w.next(1000), 'commit');
    w.dispose();
  });

  // v1.mjs / v1b.mjs / d1s.mjs: a same-URL navigate or reload (or a redirect back to the current URL) is
  // pending; the old page calls history.replaceState(location.href). That is never the commit.
  test("the old page's replaceState(location.href) is not the commit, even after a 302 hop's response", async () => {
    const t = new FakeTab();
    t.url = 'http://a.test/a';
    const w = await watchMainNav(asTab(t));
    const hop = t.request('http://a.test/a');
    t.respond(hop, 302);
    t.request('http://a.test/slow');
    t.same('http://a.test/a');
    t.same('http://a.test/a#x');
    assert.equal(w.committed, false);
    assert.equal(await w.next(30), 'timeout');
    w.dispose();
  });

  test("a commit with the starting document's loaderId is not new (a late event of the old document)", async () => {
    const t = new FakeTab();
    const w = await watchMainNav(asTab(t));
    t.commit('http://a.test/start', 'L0');
    assert.equal(w.committed, false);
    w.dispose();
  });

  test('a bfcache restore commits (its own loaderId) and says so', async () => {
    const t = new FakeTab();
    const w = await watchMainNav(asTab(t), { history: true });
    t.start('historyDifferentDocument', 'http://a.test/earlier');
    t.commit('http://a.test/earlier', 'L-old', true);
    assert.equal(w.committed, true);
    assert.equal(w.restored, true);
    w.dispose();
  });

  // v2.mjs: back to an entry whose URL equals the current page's; the page keeps calling replaceState.
  test('history: a same-document step counts only when Chrome started it as historySameDocument', async () => {
    const t = new FakeTab();
    t.url = 'http://a.test/a';
    const w = await watchMainNav(asTab(t), { history: true });
    t.same('http://a.test/a');
    assert.equal(w.committed, false, "the page's own replaceState to the entry's URL");
    t.start('historyDifferentDocument', 'http://a.test/a');
    t.same('http://a.test/a');
    assert.equal(w.committed, false, 'a cross-document step only commits with its new document');
    w.dispose();
    const t2 = new FakeTab();
    const w2 = await watchMainNav(asTab(t2), { history: true });
    t2.start('historySameDocument', 'http://a.test/start#p');
    t2.same('http://a.test/start#p');
    assert.equal(w2.committed, true);
    w2.dispose();
  });

  // v4.mjs: a click on a link to the page's own URL answered 204: no document, so no navigation.
  test('a request to the current URL answered 204 commits nothing', async () => {
    const t = new FakeTab();
    const w = await watchMainNav(asTab(t));
    const r = t.request('http://a.test/start');
    t.respond(r, 204);
    t.fail(r);
    assert.equal(w.committed, false);
    assert.equal(w.failed, true);
    w.dispose();
  });

  test('the latest request failing is a failure; an earlier hop failing is not', async () => {
    const t = new FakeTab();
    const w = await watchMainNav(asTab(t));
    const a = t.request('http://a.test/a');
    t.request('http://a.test/b');
    t.fail(a);
    assert.equal(w.failed, false);
    const pending = w.next(1000);
    t.fail(t.request('http://a.test/c'));
    assert.equal(await pending, 'failed');
    assert.equal(w.failure, 'net::ERR_ABORTED');
    w.dispose();
  });

  test('withoutFragment', () => {
    assert.equal(withoutFragment('http://a.test/x?q=1#f'), 'http://a.test/x?q=1');
    assert.equal(withoutFragment('http://a.test/x'), 'http://a.test/x');
  });
});

describe('stopBeforeCommit: a commit that timed out', () => {
  /** 1 s left before the call must answer. */
  const left = () => 1000;

  test('already committed: no stop at all (it would stop the new page loading)', async () => {
    const t = new FakeTab();
    const w = await watchMainNav(asTab(t));
    t.respond(t.request('http://a.test/x'));
    t.commit('http://a.test/x');
    let stops = 0;
    assert.equal(await stopBeforeCommit(w, async () => (stops++, true), left), 'committed');
    assert.equal(stops, 0);
    w.dispose();
  });

  test('a pending request is stopped: it fails with ERR_ABORTED, so the tab never moved', async () => {
    const t = new FakeTab();
    const w = await watchMainNav(asTab(t));
    const r = t.request('http://a.test/hang');
    assert.equal(await stopBeforeCommit(w, async () => (later(3, () => t.fail(r)), true), left), 'stopped');
    w.dispose();
  });

  test('the response had arrived: the stop is refused and the new document commits 500 ms later (pagehide)', async () => {
    const t = new FakeTab();
    const w = await watchMainNav(asTab(t));
    t.respond(t.request('http://a.test/next'));
    assert.equal(await stopBeforeCommit(w, async () => (later(500, () => t.commit('http://a.test/next')), false), left), 'committed');
    w.dispose();
  });

  test('a response event that trails the answered stop still waits for the commit', async () => {
    const t = new FakeTab();
    const w = await watchMainNav(asTab(t));
    const r = t.request('http://a.test/next');
    const stop = async () => {
      later(40, () => t.respond(r));
      later(400, () => t.commit('http://a.test/next'));
      return true;
    };
    assert.equal(await stopBeforeCommit(w, stop, left), 'committed');
    w.dispose();
  });

  test('nothing was requested and the stop was answered: stopped', async () => {
    const t = new FakeTab();
    const w = await watchMainNav(asTab(t));
    assert.equal(await stopBeforeCommit(w, async () => true, left), 'stopped');
    w.dispose();
  });

  test('the stop is never answered and nothing reports: uncertain (no retry may be invited)', async () => {
    const t = new FakeTab();
    const w = await watchMainNav(asTab(t));
    t.request('http://a.test/hang');
    let stops = 0;
    assert.equal(await stopBeforeCommit(w, async () => (stops++, false), left), 'uncertain');
    assert.equal(stops, 2, 'a refused stop with no response is tried once more');
    w.dispose();
  });

  test('committing but the commit does not land in time: uncertain', async () => {
    const t = new FakeTab();
    const w = await watchMainNav(asTab(t));
    t.respond(t.request('http://a.test/next'));
    assert.equal(await stopBeforeCommit(w, async () => true, () => 300), 'uncertain');
    w.dispose();
  });
});

describe('the wording (AC2, AC3)', () => {
  test('the still-loading note and the stopped hints never suggest wait_until=commit', () => {
    assert.equal(stillLoadingNote('domcontentloaded', 1503), '(still loading: domcontentloaded not reached in 1503 ms)');
    for (const h of [stoppedHint('http://a.test/start', false), stoppedHint('http://a.test/start', true), UNCONFIRMED_STOP_HINT]) {
      assert.doesNotMatch(h, /wait_until=commit/);
    }
    assert.match(stoppedHint('http://a.test/start', false), /^stopped before it committed; the tab still shows http:\/\/a\.test\/start; retrying requests the page again/);
    assert.doesNotMatch(UNCONFIRMED_STOP_HINT, /\bretry/);
  });
});

describe('nit (D5): liveAlerts', () => {
  test('a title-equal text is skipped unless a role=alert holds it; other texts are kept', async () => {
    let reads = 0;
    const none = async () => (reads++, []);
    assert.deepEqual(await liveAlerts(['Saved'], 'r/home', none), ['Saved']);
    assert.equal(reads, 0, 'no alert read when no text equals the title');
    assert.deepEqual(await liveAlerts(['r/home', 'Saved'], 'r/home', none), ['Saved']);
    assert.deepEqual(await liveAlerts(['Session  expired'], 'Session expired', async () => ['Session expired']), ['Session  expired']);
    assert.deepEqual(await liveAlerts(['r/home'], 'r/home', async () => ['Something else']), []);
  });
});

// D1 AC3 at the dispatcher: a navigate whose job started and did not answer by the deadline may still commit,
// so its deadline error must not say "retry" (the tab has not moved yet, so the moved-hint does not apply).
describe('the deadline error of a started navigation', () => {
  function setup(name: string): Dispatcher {
    let tail: Promise<unknown> = Promise.resolve();
    const tab = {
      id: 't1',
      crashed: false,
      closed: false,
      dialog: undefined,
      guardBlanks: 0,
      page: { url: () => 'http://a.test/start' },
      drainEvents: () => [],
      dialogOpened: () => new Promise(() => undefined),
      enqueue<T>(fn: () => Promise<T>): Promise<T> {
        const run = tail.then(fn, fn);
        tail = run.catch(() => undefined);
        return run;
      },
    } as unknown as Tab;
    const client = newClient('local');
    client.owned.add('t1');
    client.active = 't1';
    const session = {
      client: () => client,
      lock: new RWLock(),
      ensure: async () => undefined,
      getTab: () => tab,
      activeTab: async () => tab,
      refs: { get: () => undefined, whyMissing: () => ({ reason: 'unknown' }) },
    } as unknown as Session;
    const tool: Tool = defineTool({
      name,
      description: 'never answers',
      shape: { timeout_ms: timeoutArg },
      scope: 'tab',
      handlesDialog: true,
      async handler() {
        return new Promise<string>(() => undefined);
      },
    });
    return new Dispatcher(session, parseConfig([], {}, '/tmp'), new Map([[tool.name, tool]]));
  }

  test('navigate: no retry hint', async () => {
    const r = await setup('navigate').dispatch('navigate', { timeout_ms: 100 });
    const text = r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    assert.equal(r.isError, true);
    assert.ok(text.split('\n').includes(`hint: ${NAV_DEADLINE_HINT}`), text);
  });

  test('another tool keeps its retry hint', async () => {
    const r = await setup('probe').dispatch('probe', { timeout_ms: 100 });
    const text = r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    assert.match(text, /hint: retry with a larger timeout_ms/, text);
  });
});
