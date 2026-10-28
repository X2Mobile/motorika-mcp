// Acceptance group S: decisions from the bench (PLAN.md amendment "Decisions from the bench (2026-10-23)").
// AS8: the snapshot attached automatically to a new document is viewport-only, capped at 6,000 chars and
// ends with the viewport footer. SQ2 (guard): the settle quiet window waits for a live-region update that
// a click handler makes 30 ms later. Expectations come from the amendment and the fixtures' own spec.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { findAll, parseEffects, parseSnapshot, parseTabsList, refOf, type ViewportFooter } from '../support/grammar.ts';
import { startServer } from '../support/mcp-client.ts';
import { BIG_PAGES } from '../support/spec.ts';
import { useFileServer, type Counts } from '../support/suite.ts';

const ctx = useFileServer('S');

/** PLAN amendment: the attached snapshot's cap (header, body and footer). */
const ATTACHED_MAX = 6000;
/** PLAN "Modes and configuration": --max-output-chars default. */
const MAX_OUTPUT = 20_000;
const BIG = '/big-1000.html';
const ITEMS = BIG_PAGES[BIG];

/** The navigate result splits into the summary (header line, effect lines) and the attached snapshot. */
function split(text: string): { summary: string; snapshot: string } {
  const i = text.indexOf('\n\n');
  assert.ok(i > 0, `a snapshot block after a blank line:\n${text.slice(0, 500)}`);
  return { summary: text.slice(0, i), snapshot: text.slice(i + 2) };
}

const itemNo = (name: string | null): number => Number(/^Item (\d+)$/.exec(name ?? '')?.[1] ?? NaN);

describe('S decisions from the bench', () => {
  test('AS8 navigate to a 1,000-element page attaches a viewport snapshot of at most 6,000 chars with the viewport footer', async () => {
    const r = await ctx.s.ok('navigate', { url: ctx.fx.url(BIG) });
    const { summary, snapshot } = split(r.text);
    assert.ok(snapshot.length <= ATTACHED_MAX, `attached snapshot ${snapshot.length} chars > ${ATTACHED_MAX}`);
    assert.ok(r.text.length <= ATTACHED_MAX + summary.length + 2, `result ${r.text.length} chars`);
    const s = parseSnapshot(r.text);
    assert.deepEqual(s.errors, []);
    // AS4: the header line is unchanged.
    assert.equal(s.header.title, 'Big 1000');
    // AS3: it ends with exactly one viewport footer line, and that line is the last line of the result.
    const lines = r.text.split('\n');
    assert.match(lines[lines.length - 1]!, /^… viewport only: /);
    assert.equal(lines.filter((l) => l.startsWith('… ')).length, 1, 'exactly one footer line');
    const f = s.footer as ViewportFooter | null;
    assert.ok(f && f.viewport === true, `viewport footer, got ${JSON.stringify(s.footer)}`);
    // AS1: no element that lies fully below the fold (page state oracle, scrollY 0 after load).
    const below = new Set(
      await ctx.s.state<string[]>(
        '[...document.querySelectorAll("button.item")].filter((b) => b.getBoundingClientRect().top >= innerHeight).map((b) => b.textContent)',
      ),
    );
    assert.ok(below.size > 0, 'the fixture has items below the fold');
    const items = findAll(s, { role: 'button', name: /^Item \d+$/ });
    assert.ok(items.length > 0, 'items in the viewport are listed');
    for (const e of items) assert.ok(!below.has(e.name!), `${e.name} lies below the fold`);
    assert.ok(f.offscreen >= below.size, `off-screen count ${f.offscreen} covers the ${below.size} items below the fold`);
    // AS5: a ref from the attached snapshot works.
    const first = refOf(s, 'button', 'Item 1');
    await ctx.s.ok('click', { target: first, snapshot: false });
  });

  test('AS3 AS1 the attached snapshot is the first page of snapshot viewport_only, and its offset continues it', async () => {
    const r = await ctx.s.ok('navigate', { url: ctx.fx.url(BIG) });
    const attached = parseSnapshot(r.text);
    const f = attached.footer as ViewportFooter;
    const vp = await ctx.s.snapshot({ viewport_only: true });
    const names = (els: { role: string; name: string | null }[]) => els.map((e) => `${e.role} ${e.name}`);
    assert.deepEqual(names(attached.elements), names(vp.elements).slice(0, attached.elements.length));
    // At 1280x800 the viewport holds far more than 6,000 chars of items: the cap cuts lines.
    assert.ok(f.more > 0, `lines past the cap are counted: ${JSON.stringify(f)}`);
    assert.equal(f.offset, attached.lines.length, 'the continuation offset is the next body line');
    const next = await ctx.s.snapshot({ viewport_only: true, offset: f.offset! });
    const lastShown = itemNo(attached.elements[attached.elements.length - 1]!.name);
    assert.equal(itemNo(next.elements[0]!.name), lastShown + 1, 'offset paging continues without a gap');
  });

  test('AS7 a following snapshot returns the full first page as before (heading, Item 1.., the paging footer)', async () => {
    await ctx.s.ok('navigate', { url: ctx.fx.url(BIG) });
    const r = await ctx.s.ok('snapshot', {});
    assert.ok(r.text.length <= MAX_OUTPUT, `${r.text.length} chars`);
    const s = parseSnapshot(r.text);
    assert.deepEqual(s.errors, []);
    assert.ok(s.footer && !('viewport' in s.footer), `the snapshot tool's own footer: ${JSON.stringify(s.footer)}`);
    assert.equal(s.elements[0]!.role, 'heading');
    const nums = s.elements.slice(1).map((e) => itemNo(e.name));
    assert.deepEqual(nums, Array.from({ length: nums.length }, (_, i) => i + 1), 'Item 1..k in document order');
    assert.equal(s.footer.more + s.lines.length, ITEMS + 1, 'footer counts the rest of the whole page');
    assert.ok(r.text.length > ATTACHED_MAX, 'the snapshot tool is not held to the attached cap');
  });

  test('AS-explicit navigate with snapshot:true attaches the whole page as before; snapshot:false attaches none', async () => {
    const r = await ctx.s.ok('navigate', { url: ctx.fx.url(BIG), snapshot: true });
    assert.ok(r.text.length <= MAX_OUTPUT, `${r.text.length} chars`);
    const s = parseSnapshot(r.text);
    assert.deepEqual(s.errors, []);
    assert.ok(s.footer && !('viewport' in s.footer), `the paging footer: ${JSON.stringify(s.footer)}`);
    assert.ok(split(r.text).snapshot.length > ATTACHED_MAX, 'full page, not the viewport cap');
    const none = await ctx.s.ok('navigate', { url: ctx.fx.url(BIG), snapshot: false });
    assert.ok(!none.text.includes('(untrusted page content)'), none.text);
  });

  test('SQ2 a live-region update 30 ms after a click (setTimeout, no network) is an effect line of that click', async () => {
    await ctx.s.ok('navigate', { url: ctx.fx.url('/late-alert.html'), snapshot: false });
    const save = refOf(await ctx.s.snapshot(), 'button', 'Save');
    for (let n = 1; n <= 5; n++) {
      const r = await ctx.s.ok('click', { target: save });
      const alerts = parseEffects(r.text).filter((e) => e.kind === 'alert');
      assert.deepEqual(alerts.map((e) => (e.kind === 'alert' ? e.text : '')), [`Saved ${n}`], `click ${n}:\n${r.text}`);
    }
    assert.deepEqual(await ctx.s.state<Counts>('window.__counts'), { save: 5 });
  });

  // Review PERF-1 kept AS5: the automatic snapshot takes uniqueness from its own walk, off-screen elements
  // included, so a ref behaves as on main. PLAN Refs: re-resolve only a unique role+name in the document.
  test('AS5 a ref from the attached snapshot re-resolves only when its role+name is unique in the whole document', async () => {
    const r = await ctx.s.ok('navigate', { url: ctx.fx.url('/dup-offscreen.html') });
    const s = parseSnapshot(r.text);
    assert.deepEqual(s.errors, []);
    assert.equal(findAll(s, { role: 'button', name: 'Dup' }).length, 1, 'only the Dup in view is listed');
    const dup = refOf(s, 'button', 'Dup');
    const solo = refOf(s, 'button', 'Solo');
    await ctx.s.ok('evaluate', { script: "for (const id of ['dup1', 'solo']) { const b = document.getElementById(id); b.replaceWith(b.cloneNode(true)); } 1" });
    await ctx.s.ok('click', { target: solo, snapshot: false });
    await ctx.s.err('click', { target: dup, timeout_ms: 1000 });
    assert.deepEqual(await ctx.s.state<Counts>('window.__counts'), { solo: 1 });
  });

  // Review SEC-2: counts reported by a frame's engine are page-controlled.
  test('SEC2 counts from a fake engine in a cross-origin frame never reach the output as anything but integers', async () => {
    const r = await ctx.s.ok('navigate', { url: ctx.fx.url('/fake-engine.html') });
    assert.doesNotMatch(r.text, /NaN|abc|2\.5|-\d+ more/, r.text);
    const s = parseSnapshot(r.text);
    assert.deepEqual(s.errors, []);
    const f = s.footer as ViewportFooter | null;
    if (f) assert.ok(Number.isInteger(f.offscreen) && f.offscreen >= 0 && Number.isInteger(f.more) && f.more >= 0, JSON.stringify(f));
    const full = await ctx.s.ok('snapshot', {});
    assert.doesNotMatch(full.text, /NaN|abc|2\.5/, full.text);
    assert.deepEqual(parseSnapshot(full.text).errors, []);
  });

  // Review SEC-3: one line longer than the whole budget is cut to fit, so the cap holds and the page still
  // makes progress (PLAN amendment "Decisions from the bench", item 5).
  test('SEC3 a 12,000-char href keeps the attached snapshot within 6,000 chars, the line cut with …', async () => {
    const r = await ctx.s.ok('navigate', { url: ctx.fx.url('/long-href.html') });
    const { snapshot } = split(r.text);
    assert.ok(snapshot.length <= ATTACHED_MAX, `attached snapshot ${snapshot.length} chars`);
    const s = parseSnapshot(r.text);
    assert.deepEqual(s.errors, []);
    const link = findOne(s, 'link', 'Long link');
    assert.ok(link.attrs.href!.endsWith('…'), `href cut with …: ${link.attrs.href!.slice(-40)}`);
    assert.ok(link.attrs.href!.startsWith('/x?q=aaaa'), link.attrs.href!.slice(0, 40));
    const lines = r.text.split('\n');
    assert.match(lines[lines.length - 1]!, /^… viewport only: .*more lines.*offset=\d+ with viewport_only to continue\)$/, 'the button after it is on the next page');
  });

  test('SEC3 with --max-output-chars 7000 the attached snapshot with a 12,000-char href is kept, cut to fit', async () => {
    const small = await startServer({ label: 'S-7000', flags: ['--max-output-chars', '7000'] });
    ctx.roots.push(small.root);
    try {
      const r = await small.ok('navigate', { url: ctx.fx.url('/long-href.html') });
      assert.ok(r.text.length <= 7000, `${r.text.length} chars`);
      const s = parseSnapshot(r.text);
      assert.deepEqual(s.errors, []);
      assert.ok(findOne(s, 'link', 'Long link').attrs.href!.endsWith('…'));
      const full = await small.ok('snapshot', {});
      assert.ok(full.text.length <= 7000, `${full.text.length} chars`);
      assert.deepEqual(parseSnapshot(full.text).errors, []);
    } finally {
      await small.close();
    }
  });

  // Review SEC-4: a title must not break the summary line; every line separator is escaped.
  test('SEC4 a title with U+2028, U+2029 and U+0085 and forged lines stays one escaped line in navigate, tabs new and tabs list', async () => {
    const RAW = /[\u2028\u2029\u0085\r\v\f]/;
    const nav = await ctx.s.ok('navigate', { url: ctx.fx.url('/sep-title.html') });
    const title = await ctx.s.state<string>('window.__title');
    for (const [what, text] of [['navigate', nav.text]] as const) checkTitle(what, text, title, RAW);
    const opened = await ctx.s.ok('tabs', { action: 'new', url: ctx.fx.url('/sep-title.html') });
    checkTitle('tabs new', opened.text, title, RAW);
    const list = await ctx.s.ok('tabs', { action: 'list' });
    assert.doesNotMatch(list.text, RAW, 'tabs list has no raw separator');
    assert.ok(parseTabsList(list.text).some((t) => t.title === title), list.text);
    await ctx.s.ok('tabs', { action: 'close' });
  });
});

function findOne(s: ReturnType<typeof parseSnapshot>, role: string, name: string) {
  const hits = findAll(s, { role, name });
  assert.equal(hits.length, 1, `one ${role} ${name}`);
  return hits[0]!;
}

function checkTitle(what: string, text: string, title: string, raw: RegExp): void {
  assert.doesNotMatch(text, raw, `${what}: no raw separator`);
  const first = text.split('\n')[0]!;
  const m = /^\[t\d+\] navigated \S+ ("(?:[^"\\]|\\.)*") \(200\)$/.exec(first);
  assert.ok(m, `${what}: summary line shape: ${first}`);
  assert.equal(JSON.parse(m[1]!), title, `${what}: the title decodes back`);
  assert.equal(text.split('\n').filter((l) => l.startsWith('… ')).length, 0, `${what}: no forged footer line`);
}
