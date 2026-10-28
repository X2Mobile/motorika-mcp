// Acceptance group B: tabs. One fresh server for the file; B1 runs first on it.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseEffects, parseTabsList, refOf, tabIdOf, type TabLine } from '../support/grammar.ts';
import { useFileServer, until, type Counts } from '../support/suite.ts';

const ctx = useFileServer('B');

const ids = new Set<string>(); // every tab id this server ever reported (B4: never reused)
const num = (id: string) => Number(id.slice(1));

async function list(): Promise<TabLine[]> {
  const tabs = parseTabsList((await ctx.s.ok('tabs', { action: 'list' })).text);
  for (const t of tabs) ids.add(t.id);
  return tabs;
}

async function newTab(path: string, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await ctx.s.ok('tabs', { action: 'new', url: ctx.fx.url(path), ...extra });
  const id = tabIdOf(r.text);
  assert.ok(id, `tabs new names its tab:\n${r.text.slice(0, 200)}`);
  ids.add(id);
  return id;
}

function oneActive(tabs: TabLine[]): TabLine {
  const active = tabs.filter((t) => t.active);
  assert.equal(active.length, 1, `exactly one (active) marker:\n${tabs.map((t) => t.raw).join('\n')}`);
  return active[0]!;
}

describe('B tabs', () => {
  // CONTRACT-QUESTION: does a lazily launched browser start with a blank tab that takes t1? Most literal
  // reading of B1 (three `tabs new` -> t1..t3) is that it does not. Proposed: "the first `tabs new` on a
  // fresh server is t1".
  test('B1 three tabs new calls give t1..t3 with title, URL and one (active) marker', async () => {
    const opened = [await newTab('/nav-a.html'), await newTab('/click.html'), await newTab('/nav-b.html')];
    assert.deepEqual(opened, ['t1', 't2', 't3']);
    const tabs = await list();
    const byId = new Map(tabs.map((t) => [t.id, t]));
    assert.deepEqual([...byId.keys()].filter((k) => opened.includes(k)).sort(), ['t1', 't2', 't3']);
    assert.equal(byId.get('t1')!.title, 'Nav A');
    assert.equal(byId.get('t1')!.url, ctx.fx.url('/nav-a.html'));
    assert.equal(byId.get('t2')!.title, 'Click cases');
    assert.equal(byId.get('t3')!.title, 'Nav B');
    assert.equal(oneActive(tabs).id, 't3');
  });

  test('B2 click and type on a non-active tab via tab (headless); the active marker tells the truth', async () => {
    const bg = await newTab('/click.html');
    const fg = await newTab('/nav-a.html');
    let tabs = await list();
    assert.equal(oneActive(tabs).id, fg);
    const snap = await ctx.s.snapshot({ tab: bg });
    await ctx.s.ok('click', { target: refOf(snap, 'button', 'Plain'), tab: bg });
    await ctx.s.ok('type', { target: refOf(snap, 'textbox', 'Tab input'), text: 'typed in background', tab: bg });
    assert.deepEqual(await ctx.s.state<Counts>('window.__counts', { tab: bg }), { plain: 1 });
    assert.equal(await ctx.s.state<string>('document.getElementById("tab-input").value', { tab: bg }), 'typed in background');
    tabs = await list();
    const active = oneActive(tabs);
    // Truth: a call without `tab` acts on the tab the marker names.
    assert.equal(await ctx.s.state<string>('location.href'), active.url);
  });

  test('B3 target=_blank and window.open report "→ new tab tN <url>", listed and active', async () => {
    const opener = await newTab('/tabs.html');
    const snap = await ctx.s.snapshot({ tab: opener });
    for (const [role, name, via] of [['link', 'Open blank', 'blank'], ['button', 'Window open', 'open']] as const) {
      const r = await ctx.s.ok('click', { target: refOf(snap, role, name), tab: opener });
      const nt = parseEffects(r.text).find((e) => e.kind === 'new tab');
      assert.ok(nt && nt.kind === 'new tab', `new tab effect:\n${r.text}`);
      assert.match(nt.url, new RegExp(`/tab-target\\.html\\?via=${via}$`));
      ids.add(nt.tab);
      const tabs = await list();
      const line = tabs.find((t) => t.id === nt.tab);
      assert.ok(line, `${nt.tab} is listed`);
      assert.equal(oneActive(tabs).id, nt.tab, 'the popup is active');
    }
  });

  test('B4 closing the active tab activates the previously active one; ids are never reused', async () => {
    const a = await newTab('/nav-a.html');
    const b = await newTab('/nav-b.html');
    const c = await newTab('/click.html');
    await ctx.s.ok('tabs', { action: 'select', tab: a });
    assert.equal(oneActive(await list()).id, a);
    await ctx.s.ok('tabs', { action: 'close' }); // closes a (active); previously active was c, not neighbour b
    const tabs = await list();
    assert.ok(!tabs.some((t) => t.id === a), 'closed tab is gone');
    assert.equal(oneActive(tabs).id, c);
    assert.ok(tabs.some((t) => t.id === b));
    const maxSeen = Math.max(...[...ids].map(num));
    const d = await newTab('/nav-a.html');
    assert.ok(num(d) > maxSeen, `${d} must be new (max seen t${maxSeen})`);
  });

  test('B5 a ref acts on its own tab without `tab`; a mismatched `tab` is an error', async () => {
    const t1 = await newTab('/click.html');
    const snap = await ctx.s.snapshot({ tab: t1 });
    const plain = refOf(snap, 'button', 'Plain');
    const t2 = await newTab('/nav-a.html');
    assert.equal(oneActive(await list()).id, t2);
    await ctx.s.ok('click', { target: plain });
    assert.deepEqual(await ctx.s.state<Counts>('window.__counts', { tab: t1 }), { plain: 1 });
    await ctx.s.err('click', { target: plain, tab: t2 });
    assert.deepEqual(await ctx.s.state<Counts>('window.__counts', { tab: t1 }), { plain: 1 }, 'no second click');
  });

  test('B6 concurrent calls on two tabs both complete; on one tab they run serially', async () => {
    const x = await newTab('/click.html');
    const y = await newTab('/click.html');
    const [sx, sy] = [await ctx.s.snapshot({ tab: x }), await ctx.s.snapshot({ tab: y })];
    await Promise.all([
      ctx.s.ok('click', { target: refOf(sx, 'button', 'Plain'), tab: x }),
      ctx.s.ok('click', { target: refOf(sy, 'button', 'Plain'), tab: y }),
    ]);
    assert.deepEqual(await ctx.s.state<Counts>('window.__counts', { tab: x }), { plain: 1 });
    assert.deepEqual(await ctx.s.state<Counts>('window.__counts', { tab: y }), { plain: 1 });

    // Same tab: "Order A" starts a 700 ms fetch that A's settle waits for; B is sent right after A.
    // Serial in arrival order => the page sees A-start, A-end, B (harness proves overlap gives A-start, B, A-end).
    await Promise.all([
      ctx.s.ok('click', { target: refOf(sx, 'button', 'Order A'), tab: x }),
      ctx.s.ok('click', { target: refOf(sx, 'button', 'Order B'), tab: x }),
    ]);
    const ev = await until(async () => {
      const e = await ctx.s.state<string[]>('window.__events', { tab: x });
      return e.length >= 3 ? e : null;
    }, 3000);
    assert.deepEqual(ev, ['A-start', 'A-end', 'B']);
  });
});
