// Snapshot walker + find. Produces structured nodes with document-local ids; the server formats lines.
import type { FindHit, SnapNode, SnapshotOptions, SnapshotResult } from '../protocol.js';
import {
  CONTAINERS, FULL_ONLY, INTERACTIVE, LANDMARKS, LEAF, LIVE, NAME_FROM_CONTENT,
  attr, attrsOf, capOut, composedChildren, currentDocVersion, deepActiveElement, elementById, hasAttr, idOf, inViewport,
  innerTextOf, labelsOf, nameOf, norm, parentComposed, rectOf, roleOf, styleOf, sweepIds, visibility, visibleLabelFor, withLabelMap,
} from './dom.js';
import { composedCompare, composedContains, composedText, withComposedText } from './read-text.js';

const SKIP_TAGS = new Set(['script', 'style', 'template', 'noscript', 'head', 'meta', 'link', 'title', 'datalist', 'option', 'optgroup']);
const BREAK: SnapNode = { id: -1, role: '\u0000break' };

interface Ctx {
  mode: 'interactive' | 'full';
  viewportOnly: boolean;
  active: Element | null;
  suppressText: boolean;
  /** Text nodes here belong to a hidden element (visibility:hidden or zero size): not emitted. */
  textHidden: boolean;
  inInteractive: boolean;
  counts: Map<string, number>;
  /** element -> node (for uniqueness fix-up and find). */
  out: { el: Element; node: SnapNode }[];
  iframes: number[];
  /** viewport_only: elements that would be listed but lie outside the viewport. */
  offscreen: number;
  /**
   * viewport_only: nodes the same walk without viewport_only would list but this one leaves out (off-screen
   * elements, and containers holding only those). They are counted in `counts`, so `counts` equals the
   * whole-document counts of that walk without a second walk.
   */
  ghosts: number;
  /** Inside an off-screen leaf: the walk without viewport_only never descends here, so nothing counts. */
  noCount: number;
}

function key(role: string, name: string | undefined): string {
  return `${role}\u0001${name ?? ''}`;
}

function isBlock(st: CSSStyleDeclaration): boolean {
  const d = st.display;
  return !(d.startsWith('inline') || d === 'contents' || d === 'none');
}

function clickable(el: Element, st: CSSStyleDeclaration, parentCursor: string | undefined): boolean {
  if (st.cursor === 'pointer' && parentCursor !== 'pointer') return true;
  if (hasAttr(el, 'onclick') || (el instanceof HTMLElement && el.onclick !== null)) return true;
  const ti = attr(el, 'tabindex');
  if (ti !== null && Number(ti) >= 0) return true;
  return false;
}

function includeRole(role: string, name: string, ctx: Ctx): 'yes' | 'container' | 'no' {
  if (role === 'generic') return 'no';
  if (INTERACTIVE.has(role)) return 'yes';
  if (role === 'heading' || role === 'dialog' || role === 'alertdialog' || LIVE.has(role)) return 'yes';
  if (role === 'iframe' || role === 'video' || role === 'audio') return 'yes';
  if (LANDMARKS.has(role)) {
    if ((role === 'form' || role === 'region') && name === '') return ctx.mode === 'full' ? 'container' : 'no';
    // Contract answer 12: a named landmark is always kept, even when it holds only text.
    return name !== '' ? 'yes' : 'container';
  }
  if (CONTAINERS.has(role)) return ctx.mode === 'full' ? 'yes' : 'container';
  if (ctx.mode === 'full') {
    if (role === 'img') return name !== '' ? 'yes' : 'no';
    if (FULL_ONLY.has(role)) return 'yes';
    if (role === 'progressbar') return 'yes';
  } else if (role === 'progressbar') return 'yes';
  return 'no';
}

function walkChildren(el: Element, ctx: Ctx, parentCursor: string | undefined): SnapNode[] {
  const items: SnapNode[] = [];
  for (const child of composedChildren(el)) {
    if (child.nodeType === Node.TEXT_NODE) {
      if (ctx.mode === 'full' && !ctx.suppressText && !ctx.textHidden) {
        const t = norm(child.textContent);
        if (t !== '') items.push({ id: 0, role: 'text', name: t });
      }
      continue;
    }
    if (child instanceof Element) items.push(...walk(child, ctx, parentCursor));
  }
  return items;
}

function walk(el: Element, ctx: Ctx, parentCursor: string | undefined): SnapNode[] {
  if (SKIP_TAGS.has(el.localName)) return [];
  if (el.localName === 'br') return ctx.mode === 'full' ? [BREAK] : [];
  const st = styleOf(el);
  const vis = visibility(el, st);
  if (vis === 'skip') return [];
  let role = roleOf(el);
  if (role === 'none') return [];
  if (role === 'generic' && !ctx.inInteractive && el !== document.documentElement && el !== document.body && clickable(el, st, parentCursor)) {
    role = 'clickable';
  }
  if (role === 'option' && el instanceof HTMLOptionElement) return [];
  let shown = vis === 'visible';
  if (!shown && vis === 'descend' && INTERACTIVE.has(role) && el instanceof HTMLInputElement && visibleLabelFor(el)) {
    // Visually hidden focusable input with a visible label (custom checkbox/radio).
    shown = true;
  }
  let offscreen = false;
  let ghost = false;
  if (shown && ctx.viewportOnly && !inViewport(el)) {
    shown = false;
    offscreen = true;
  }
  let name = '';
  let inc: 'yes' | 'container' | 'no' = 'no';
  if (role !== 'generic') {
    name = capOut(nameOf(el, role));
    inc = includeRole(role, name, ctx);
    // Hidden landmarks/containers still pass their visible children through.
    if (!shown && inc === 'yes') {
      if (offscreen) {
        // P8: an iframe is a frame holder, not an element: it never counts as off-screen (a 1x1 tracking
        // frame used to read as "2 more off-screen").
        if (role !== 'iframe') ctx.offscreen++;
        ghost = true;
      }
      inc = 'no';
    }
  }
  // An off-screen element the walk without viewport_only would list (a tiny iframe it would skip).
  if (ghost && role === 'iframe') {
    const r = rectOf(el);
    if (r.width < 2 || r.height < 2) ghost = false;
  }
  if (ghost && ctx.noCount === 0) {
    ctx.ghosts++;
    ctx.counts.set(key(role, name), (ctx.counts.get(key(role, name)) ?? 0) + 1);
  }
  const ghostsBefore = ctx.ghosts;
  const ghostLeaf = ghost && (LEAF.has(role) || el instanceof HTMLSelectElement);
  if (ghostLeaf) ctx.noCount++;
  const isInteractive = INTERACTIVE.has(role);
  const savedSuppress = ctx.suppressText;
  const savedInteractive = ctx.inInteractive;
  const savedTextHidden = ctx.textHidden;
  // A hidden element's own text is hidden too; a descendant that is visible again shows its text.
  // display:contents has no box of its own and keeps the parent's state.
  if (vis === 'visible') ctx.textHidden = false;
  else if (st.display !== 'contents') ctx.textHidden = true;
  let children: SnapNode[] = [];
  if (!(inc !== 'no' && LEAF.has(role)) && !(role === 'combobox' && el instanceof HTMLSelectElement) && !(el instanceof HTMLSelectElement)) {
    if (inc !== 'no' && (NAME_FROM_CONTENT.has(role) || role === 'textbox')) ctx.suppressText = true;
    if (isInteractive) ctx.inInteractive = true;
    children = walkChildren(el, ctx, st.cursor);
    ctx.suppressText = savedSuppress;
    ctx.inInteractive = savedInteractive;
  }
  ctx.textHidden = savedTextHidden;
  if (ghostLeaf) ctx.noCount--;
  if (role === 'iframe' && inc === 'yes') {
    const r = rectOf(el);
    if (r.width < 2 || r.height < 2) return [];
  }
  if (inc === 'no') {
    if (ctx.mode === 'full' && isBlock(st) && children.length > 0) return [BREAK, ...children, BREAK];
    return children;
  }
  children = mergeText(children);
  if (inc === 'container' && children.length === 0) {
    // Named form/region and landmarks are omitted when nothing is included under them, except in full mode where text counts.
    // Without viewport_only it would hold its off-screen descendants: count it as they are counted.
    if (ctx.ghosts > ghostsBefore && ctx.noCount === 0) {
      ctx.ghosts++;
      ctx.counts.set(key(role, name), (ctx.counts.get(key(role, name)) ?? 0) + 1);
    }
    return [];
  }
  const node: SnapNode = { id: idOf(el), role, attrs: attrsOf(el, role, ctx.active) };
  if (name !== '') node.name = name;
  if (children.length > 0) node.children = children;
  if (role === 'iframe') ctx.iframes.push(node.id);
  if (ctx.noCount === 0) ctx.counts.set(key(role, name), (ctx.counts.get(key(role, name)) ?? 0) + 1);
  ctx.out.push({ el, node });
  return [node];
}

function mergeText(items: SnapNode[]): SnapNode[] {
  const out: SnapNode[] = [];
  let buf = '';
  const flush = () => {
    if (buf !== '') {
      out.push({ id: 0, role: 'text', name: buf.length > 200 ? `${buf.slice(0, 199)}…` : buf });
      buf = '';
    }
  };
  for (const it of items) {
    if (it === BREAK) {
      flush();
      continue;
    }
    if (it.role === 'text') {
      buf = buf === '' ? (it.name ?? '') : `${buf} ${it.name ?? ''}`;
      continue;
    }
    flush();
    out.push(it);
  }
  flush();
  return out;
}

function newCtx(mode: 'interactive' | 'full', viewportOnly: boolean): Ctx {
  return {
    mode,
    viewportOnly,
    active: deepActiveElement(),
    suppressText: false,
    textHidden: false,
    inInteractive: false,
    counts: new Map(),
    out: [],
    iframes: [],
    offscreen: 0,
    ghosts: 0,
    noCount: 0,
  };
}

function walkRoot(root: Element, ctx: Ctx): SnapNode[] {
  // The scope root itself is included if it qualifies. One label map per walk (review P3).
  return withLabelMap(() => mergeText(walk(root, ctx, undefined)));
}

let countsCache: { version: number; counts: Map<string, number> } | undefined;

/**
 * role+name counts over the whole document (both modes' element set). Review P4: cached until the DOM
 * changes, so scope, viewport_only and describe(el, true) do not walk the whole document every time.
 */
function documentCounts(): Map<string, number> {
  const v = currentDocVersion();
  if (countsCache && countsCache.version === v) return countsCache.counts;
  const ctx = newCtx('full', false);
  walkRoot(document.documentElement, ctx);
  countsCache = { version: v, counts: ctx.counts };
  return ctx.counts;
}

/**
 * Review P2 / S2: keep at most `limit` output lines (pre-order, as the server renders them) and count
 * the rest, so a huge page does not cross CDP whole. Iframes after the cut are dropped from `iframes`.
 */
function cut(nodes: SnapNode[], limit: number, iframes: number[]): { nodes: SnapNode[]; omitted: number; dropped: number[] } {
  let left = limit;
  let omitted = 0;
  const dropped = new Set<number>();
  const count = (n: SnapNode): number => {
    let c = 1;
    if (n.role === 'iframe') dropped.add(n.id);
    for (const k of n.children ?? []) c += count(k);
    return c;
  };
  const keep = (list: SnapNode[]): SnapNode[] => {
    const out: SnapNode[] = [];
    for (const n of list) {
      if (left <= 0) {
        omitted += count(n);
        continue;
      }
      left--;
      if (n.children) {
        const kids = keep(n.children);
        out.push(kids.length > 0 ? { ...n, children: kids } : { ...n, children: undefined });
      } else out.push(n);
    }
    return out;
  };
  const kept = keep(nodes);
  if (dropped.size > 0) {
    const rest = iframes.filter((id) => !dropped.has(id));
    iframes.length = 0;
    iframes.push(...rest);
  }
  return { nodes: kept, omitted, dropped: [...dropped] };
}

export function snapshot(opts: SnapshotOptions): SnapshotResult {
  sweepIds();
  let root: Element = document.documentElement;
  if (opts.scope !== undefined) {
    const s = elementById(opts.scope);
    if (!s) throw new Error('motorika:stale-scope');
    root = s;
  }
  const ctx = newCtx(opts.mode, opts.viewportOnly);
  const nodes = walkRoot(root, ctx);
  // The attached snapshot (countsFromWalk) counts the off-screen nodes in its own walk: one walk, and the
  // same counts as the walk without viewport_only.
  const counts = opts.scope === undefined && (!opts.viewportOnly || opts.countsFromWalk === true) ? ctx.counts : documentCounts();
  for (const { node } of ctx.out) node.unique = (counts.get(key(node.role, node.name)) ?? 0) === 1;
  if (opts.limit !== undefined) {
    const c = cut(nodes, opts.limit, ctx.iframes);
    return { title: document.title, url: location.href, nodes: c.nodes, iframes: ctx.iframes, omitted: c.omitted, droppedIframes: c.dropped, offscreen: ctx.offscreen };
  }
  return { title: document.title, url: location.href, nodes, iframes: ctx.iframes, offscreen: ctx.offscreen };
}

/** Describe one element as a snapshot node (no children). */
export function describe(el: Element, withUnique: boolean): SnapNode {
  let role = roleOf(el);
  if (role === 'generic' || role === 'none') role = clickableRole(el);
  // Non-semantic elements have no vocabulary role; they are described as a group.
  if (role === 'generic') role = 'group';
  const name = capOut(withLabelMap(() => nameOf(el, role)));
  const node: SnapNode = { id: idOf(el), role, attrs: attrsOf(el, role, deepActiveElement()) };
  if (name !== '') node.name = name;
  if (withUnique) node.unique = (documentCounts().get(key(role, name)) ?? 0) === 1;
  return node;
}

function clickableRole(el: Element): string {
  const st = styleOf(el);
  const pst = el.parentElement ? styleOf(el.parentElement).cursor : undefined;
  return clickable(el, st, pst) ? 'clickable' : 'generic';
}

/** Find a unique current element with role+name (stale ref re-resolution). */
export function resolveUnique(role: string, name: string): number | null {
  const ctx = newCtx('full', false);
  walkRoot(document.documentElement, ctx);
  const hits = ctx.out.filter(({ node }) => node.role === role && (node.name ?? '') === name);
  return hits.length === 1 && hits[0] ? hits[0].node.id : null;
}

const STRUCTURAL = new Set([...LANDMARKS, 'list', 'table', 'row', 'grid', 'tree', 'menu', 'menubar', 'tablist', 'tabpanel', 'toolbar', 'group', 'article', 'figure', 'dialog', 'alertdialog', 'listbox', 'iframe']);

export function find(query: string, role: string | undefined, limit: number): FindHit[] {
  // E1 (round 4): text is matched over the composed tree (open shadow roots, slotted light DOM).
  return withLabelMap(() => withComposedText(() => findIn(query, role, limit)));
}

/** Elements whose text is never searched by the text pass (form controls keep their values to themselves). */
const NO_TEXT_SEARCH = new Set([...SKIP_TAGS, 'input', 'textarea', 'select', 'button', 'svg', 'iframe', 'canvas', 'video', 'audio']);

function lowerText(el: Element): string {
  return norm(composedText(el)).toLowerCase();
}

/**
 * P4: text split across elements (`<span>21</span> comment karma`). The smallest visible elements whose
 * combined text contains q: descend into every child that still contains it; an element none of whose
 * children does is a hit. At most `max` hits.
 */
function textHits(q: string, max: number): Element[] {
  const out: Element[] = [];
  const visit = (el: Element): void => {
    let deeper = false;
    for (const c of composedChildren(el)) {
      if (out.length >= max) return;
      if (!(c instanceof Element) || NO_TEXT_SEARCH.has(c.localName)) continue;
      if (visibility(c, styleOf(c)) === 'skip' || !lowerText(c).includes(q)) continue;
      deeper = true;
      visit(c);
    }
    if (!deeper && out.length < max) out.push(el);
  };
  const body = document.body;
  if (body && lowerText(body).includes(q)) visit(body);
  return out;
}

function findIn(query: string, role: string | undefined, limit: number): FindHit[] {
  const q = query.toLowerCase().trim();
  const ctx = newCtx('full', false);
  walkRoot(document.documentElement, ctx);
  for (const { node } of ctx.out) node.unique = (ctx.counts.get(key(node.role, node.name)) ?? 0) === 1;
  const hits: { el: Element; node: SnapNode; exact: boolean; order: number }[] = [];
  let order = 0;
  for (const { el, node } of ctx.out) {
    order++;
    if (role && node.role !== role) continue;
    if (q === '') {
      // P5: an empty query lists every element of the role (the server refuses it without a role).
      if (role) hits.push({ el, node: { ...node, children: undefined }, exact: false, order });
      continue;
    }
    const fields: string[] = [];
    if (node.name) fields.push(node.name);
    if (!node.attrs?.password && node.attrs?.value) fields.push(node.attrs.value);
    const ph = attr(el, 'placeholder');
    if (ph) fields.push(ph);
    // Values leave the page capped; match on the element's own value (never a password's).
    if (!node.attrs?.password && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.value.length > 101) {
      fields.push(el.value.slice(0, 2000));
    }
    for (const l of labelsOf(el)) fields.push(norm(innerTextOf(l)));
    if (!STRUCTURAL.has(node.role) && !node.attrs?.password) fields.push(norm(composedText(el)).slice(0, 2000));
    const lower = fields.map((f) => f.toLowerCase());
    if (!lower.some((f) => f.includes(q))) continue;
    hits.push({ el, node: { ...node, children: undefined }, exact: lower.some((f) => f.trim() === q), order });
  }
  if (q !== '') {
    // P4: text no single element holds by itself. Never a hit that is, holds or sits inside a hit above.
    for (const el of textHits(q, limit + 1)) {
      if (hits.some((h) => composedContains(h.el, el) || composedContains(el, h.el))) continue;
      const node = describe(el, false);
      if (role && node.role !== role) continue;
      // A non-semantic element has no name of its own: its text is what was found, so it is shown.
      if (!node.name) {
        const t = capOut(norm(composedText(el)));
        if (t !== '') node.name = t;
      }
      node.unique = (ctx.counts.get(key(node.role, node.name)) ?? 0) === 1;
      hits.push({ el, node, exact: lowerText(el) === q, order: ++order });
    }
  }
  // ctx.out is in post-order; sort by composed-tree (rendering) position for stable output.
  hits.sort((a, b) => {
    if (a.exact !== b.exact) return a.exact ? -1 : 1;
    return composedCompare(a.el, b.el) || a.order - b.order;
  });
  const headings = ctx.out.filter(({ node }) => node.role === 'heading');
  // Round 5, item 2: one landmark map per call, not one per hit.
  const landmarkEls = new Map<Element, SnapNode>();
  for (const { el: e, node } of ctx.out) if (LANDMARKS.has(node.role) || node.role === 'dialog' || node.role === 'alertdialog') landmarkEls.set(e, node);
  return hits.slice(0, limit).map((h) => {
    const hit: FindHit = { node: stripChildren(h.node), exact: h.exact };
    const c = contextFor(h.el, headings, landmarkEls);
    if (c) hit.context = stripChildren(c);
    return hit;
  });
}

function stripChildren(n: SnapNode): SnapNode {
  const { children: _c, ...rest } = n;
  return rest;
}

function contextFor(el: Element, headings: { el: Element; node: SnapNode }[], landmarkEls: Map<Element, SnapNode>): SnapNode | undefined {
  // Nearest landmark ancestor.
  let landmark: { el: Element; node: SnapNode } | undefined;
  for (let cur: Element | null = parentComposed(el); cur; cur = parentComposed(cur)) {
    const n = landmarkEls.get(cur);
    if (n) {
      landmark = { el: cur, node: n };
      break;
    }
  }
  // Nearest preceding heading inside the same landmark (or anywhere if no landmark).
  let best: { el: Element; node: SnapNode } | undefined;
  for (const h of headings) {
    if (h.el === el) continue;
    if (composedCompare(h.el, el) >= 0) continue;
    if (landmark && !composedContains(landmark.el, h.el)) continue;
    if (!best || composedCompare(best.el, h.el) < 0) best = h;
  }
  return (best ?? landmark)?.node;
}
