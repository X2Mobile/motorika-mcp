// R6 after the r3 merge: the renderer crashed while a call ran, before Playwright's 'crash' event marked the
// tab, and the call answered "[t1] Target crashed / hint: check the arguments ...". Contract (R6): a call on
// a crashed tab is isError "tab tN crashed" with the hint "close it with tabs close, or open a new tab with
// tabs new", whichever tool or helper surfaced the crash. Pinned here without a browser, because the real
// order of the crash event and the failing call is a race.
// Round 5 (security): the text "Target crashed" alone is page-controllable (an evaluate that throws it), so
// the tab is marked crashed only on the browser's evidence: the page's crash event, or the dispatcher's own
// probe (round 6: Runtime.evaluate of `1` through CDP) answered by the page's crash event. The fake tab
// therefore has a renderer: a crashed one (the probe gets no answer, the page fires 'crash') or a live one.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, test } from 'node:test';
import type { Session } from '../../src/browser/session.ts';
import { RWLock } from '../../src/browser/session.ts';
import { newClient, type Tab } from '../../src/browser/tabs.ts';
import { parseConfig } from '../../src/config.ts';
import { Dispatcher } from '../../src/dispatch.ts';
import { ToolError } from '../../src/util/errors.ts';
import { defineTool, type Tool } from '../../src/tools/types.ts';

const HINT = 'hint: close it with tabs close, or open a new tab with tabs new';

type Renderer = 'crashed' | 'live' | 'crash-event';

function fakeTab(renderer: Renderer): Tab {
  let tail: Promise<unknown> = Promise.resolve();
  const page = Object.assign(new EventEmitter(), {
    url: () => 'http://a.test/',
    // Round 6 (item 7): the probe no longer goes through the page's main world; a page whose eval throws
    // "Target crashed" changes nothing.
    evaluate: async () => {
      throw new Error('page.evaluate: Target crashed ');
    },
  });
  // The probe: Runtime.evaluate on the tab's CDP session. A crashed renderer never answers it, and the page
  // fires 'crash' (at once, or 30 ms later); a live one answers.
  const cdp = async () => ({
    send: async () => {
      if (renderer === 'live') return { result: { type: 'number', value: 1 } };
      setTimeout(() => page.emit('crash'), renderer === 'crash-event' ? 30 : 0);
      return new Promise(() => undefined);
    },
  });
  const tab = {
    id: 't1',
    crashed: false,
    closed: false,
    dialog: undefined,
    guardBlanks: 0,
    page,
    cdp,
    drainEvents: () => [],
    dialogOpened: () => new Promise(() => undefined),
    enqueue<T>(fn: () => Promise<T>): Promise<T> {
      const run = tail.then(fn, fn);
      tail = run.catch(() => undefined);
      return run;
    },
  };
  // The real Tab marks itself crashed on the page's crash event.
  page.on('crash', () => {
    tab.crashed = true;
  });
  return tab as unknown as Tab;
}

function setup(thrown: () => Error, renderer: Renderer = 'crashed'): { d: Dispatcher; tab: Tab } {
  const tab = fakeTab(renderer);
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
    name: 'probe',
    description: 'throws',
    shape: {},
    scope: 'tab',
    async handler() {
      throw thrown();
    },
  });
  const config = parseConfig([], {}, '/tmp');
  return { d: new Dispatcher(session, config, new Map([[tool.name, tool]])), tab };
}

const textOf = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');

describe('a crash surfaced by a call maps to the crashed-tab error (R6)', () => {
  for (const [label, err] of [
    ['a raw Playwright error', () => new Error('frame.evaluate: Target crashed')],
    ['a ToolError that wraps it', () => new ToolError('snapshot failed: Target crashed', 'take a snapshot and retry')],
  ] as const) {
    test(label, async () => {
      const { d, tab } = setup(err);
      const r = await d.dispatch('probe', {});
      const text = textOf(r);
      assert.equal(r.isError, true);
      assert.ok(text.includes('tab t1 crashed'), text);
      assert.ok(text.split('\n').includes(HINT), text);
      assert.equal(tab.crashed, true, 'the tab is marked crashed for the next call and tabs list');
    });
  }

  test("the crash event arrives after the call's error: still the crashed-tab error", async () => {
    const { d, tab } = setup(() => new Error('frame.evaluate: Target crashed'), 'crash-event');
    const r = await d.dispatch('probe', {});
    assert.ok(textOf(r).includes('tab t1 crashed'), textOf(r));
    assert.equal(tab.crashed, true);
  });

  test('an unrelated error is unchanged', async () => {
    // Round 7: every failed call asks the browser; this renderer is alive.
    const { d, tab } = setup(() => new Error('frame.evaluate: boom'), 'live');
    const r = await d.dispatch('probe', {});
    const text = textOf(r);
    assert.match(text, /boom/);
    assert.equal(tab.crashed, false);
  });
});

// Round 5 (security) AC: "mark a tab crashed only on Playwright/CDP evidence … an evaluate that throws that
// text does NOT mark the tab crashed".
describe('page text that says "Target crashed" is not a crash', () => {
  for (const [label, err] of [
    ['an evaluate page exception', () => new ToolError('page exception: Error: Target crashed', 'fix the script and retry')],
    ['a raw error with the text', () => new Error('page.evaluate: Error: Target crashed\n    at eval')],
    ['"page crashed" too', () => new Error('page.evaluate: Navigation failed because page crashed!')],
  ] as const) {
    test(label, async () => {
      const { d, tab } = setup(err, 'live');
      const r = await d.dispatch('probe', {});
      const text = textOf(r);
      assert.equal(r.isError, true);
      assert.doesNotMatch(text, /tab t1 crashed/, text);
      assert.equal(tab.crashed, false, 'a live renderer is not marked crashed');
    });
  }
});
