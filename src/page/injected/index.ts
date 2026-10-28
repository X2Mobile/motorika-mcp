// Injected engine entry. Bundled by esbuild into one IIFE string; installed with frame.evaluate(<string>)
// (CDP, not subject to page CSP). Stored at window[Symbol.for('motorika.engine')].
import type { ElementKind, QuietResult, ScrollState, SnapNode, SnapshotOptions } from '../protocol.js';
import {
  attr, bumpDocVersion, deepActiveElement, setMutationFlush, elementById, idOf, innerTextOf, isShown, nameOf, norm, optionLabel, parentComposed, qsa, rectOf,
  styleOf, visibleLabelFor,
} from './dom.js';
import { read } from './read.js';
import { describe, find, resolveUnique, snapshot } from './snapshot.js';

const KEY = Symbol.for('motorika.engine');
const OVERLAY_ATTR = 'data-motorika-overlay';

const nativeSetTimeout = window.setTimeout.bind(window);
const nativeClearTimeout = window.clearTimeout.bind(window);
const NativeMO = window.MutationObserver;
const nativeCreate = Document.prototype.createElement;
const nativeAppend = Node.prototype.appendChild;
const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
const taValueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;

function randomId(): string {
  let s = '';
  for (let i = 0; i < 4; i++) s += Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  return s;
}

function mustGet(id: number): Element {
  const el = elementById(id);
  if (!el) throw new Error('motorika:stale');
  return el;
}

// ---- self-changing nodes (review P5, re-check item 7) ----
// A long-lived observer remembers when each node changed. A node that changes periodically on its own
// (a clock, a progress bar, a ticker) is background: settle ignores its mutations, so a page that changes
// every 50 ms by itself does not hold every action to the quiet cap. Changes an action causes are always
// waited for: a node counts as periodic only after 3 consecutive changes at a steady interval, none of
// them inside the previous action's settle window, and only if that was established before the current
// action began. The period sticks while the changes keep it; an off-beat change resets it.
// Changes are tracked per node and per channel (text, tree, one per attribute), so a click that appends
// an element to a ticking panel is not hidden by the panel's text ticks.
const CHURN_MAX_PERIOD_MS = 1500;
const CHURN_RING = 16;
interface Churn {
  times: number[];
  /** The steady interval once established, else 0. */
  period: number;
  establishedAt: number;
}
const churn = new WeakMap<Node, Map<string, Churn>>();
/** Settle windows of recent actions: [action start, quiet end]; `to` is Infinity while settling. */
const windows: { from: number; to: number }[] = [];
/** The previous action's settle window: the last closed one (the open one, if any, is the current action's). */
function previousWindow(): { from: number; to: number } | undefined {
  const last = windows[windows.length - 1];
  return last && last.to === Number.POSITIVE_INFINITY ? windows[windows.length - 2] : last;
}
const steadyTol = (p: number): number => Math.max(20, p * 0.3);

function mutationKey(r: MutationRecord): [Node, string] {
  if (r.type === 'characterData') return [r.target.parentNode ?? r.target, 'text'];
  if (r.type === 'attributes') return [r.target, `a:${r.attributeName ?? ''}`];
  const structural = (l: NodeList) => Array.prototype.some.call(l, (n: Node) => n.nodeType === Node.ELEMENT_NODE);
  return [r.target, structural(r.addedNodes) || structural(r.removedNodes) ? 'tree' : 'text'];
}

function noteOne(node: Node, ch: string, now: number): void {
  let m = churn.get(node);
  if (!m) churn.set(node, (m = new Map()));
  let st = m.get(ch);
  if (!st) m.set(ch, (st = { times: [], period: 0, establishedAt: 0 }));
  const last = st.times[st.times.length - 1];
  if (st.period > 0 && (last === undefined || Math.abs(now - last - st.period) > steadyTol(st.period))) st.period = 0;
  st.times.push(now);
  if (st.times.length > CHURN_RING) st.times.shift();
  if (st.period > 0) return;
  const n = st.times.length;
  if (n < 3) return;
  const a = st.times[n - 3] ?? 0;
  const b = st.times[n - 2] ?? 0;
  const g1 = b - a;
  const g2 = now - b;
  if (g1 <= 0 || g2 <= 0 || g1 > CHURN_MAX_PERIOD_MS || g2 > CHURN_MAX_PERIOD_MS) return;
  if (Math.abs(g1 - g2) > steadyTol(Math.min(g1, g2))) return;
  // PLAN item 7: none of the three inside the previous action's settle window. Changes inside the current
  // window may establish the period, but only for later actions (wasChurning needs establishedAt < cutoff).
  const prev = previousWindow();
  if (prev && [a, b, now].some((t) => t >= prev.from && t <= prev.to)) return;
  st.period = (g1 + g2) / 2;
  st.establishedAt = now;
}

function noteMutations(records: MutationRecord[]): void {
  if (records.length === 0) return;
  bumpDocVersion();
  const now = Date.now();
  const seen = new Map<Node, Set<string>>(); // one batch counts once per node and channel
  for (const r of records) {
    const [k, ch] = mutationKey(r);
    let chs = seen.get(k);
    if (!chs) seen.set(k, (chs = new Set()));
    if (chs.has(ch)) continue;
    chs.add(ch);
    noteOne(k, ch, now);
  }
}

/** The node's channel was periodic on its own before the action started at `cutoff`, and still is. */
function wasChurning(k: [Node, string], cutoff: number): boolean {
  const st = churn.get(k[0])?.get(k[1]);
  return st !== undefined && st.period > 0 && st.establishedAt < cutoff;
}

/** Open (or reopen) the settle window of the action that started at `from`. Settle calls of one action
 * pass the same start up to clock jitter (20 ms); the tab queue never runs two actions that close. */
function openWindow(from: number): { from: number; to: number } {
  const lastW = windows[windows.length - 1];
  if (lastW && Math.abs(lastW.from - from) <= 20) {
    lastW.to = Number.POSITIVE_INFINITY;
    return lastW;
  }
  const w = { from, to: Number.POSITIVE_INFINITY };
  windows.push(w);
  if (windows.length > 8) windows.shift();
  return w;
}

const tracker = new NativeMO(noteMutations);
tracker.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
setMutationFlush(() => noteMutations(tracker.takeRecords()));

/**
 * Resolves after quietMs without relevant mutations (capped at capMs). Mutations of nodes that were
 * already churning before the action (which started actionAgoMs ago) do not count. The live-region
 * texts are returned with the result, which saves a round trip.
 */
function quiet(quietMs: number, capMs: number, actionAgoMs = 0): Promise<QuietResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const cutoff = start - Math.max(0, actionAgoMs);
    const win = actionAgoMs > 0 ? openWindow(cutoff) : undefined;
    let timer = 0;
    let done = false;
    const finish = (q: boolean) => {
      if (done) return;
      done = true;
      mo.disconnect();
      if (win) win.to = Date.now();
      nativeClearTimeout(timer);
      nativeClearTimeout(cap);
      let live: string[] = [];
      try {
        live = liveTexts();
      } catch {
        /* page torn down */
      }
      resolve({ quiet: q, waited: Date.now() - start, live });
    };
    const arm = () => {
      nativeClearTimeout(timer);
      timer = nativeSetTimeout(() => finish(true), quietMs);
    };
    // The long-lived tracker notes these records (it was created first, so its callback runs first).
    const mo = new NativeMO((records) => {
      for (const r of records) {
        if (!wasChurning(mutationKey(r), cutoff)) {
          arm();
          return;
        }
      }
    });
    mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    const cap = nativeSetTimeout(() => finish(false), capMs);
    arm();
  });
}

function liveTexts(): string[] {
  const out: string[] = [];
  for (const el of qsa(document, '[role=alert], [role=status], [role=log], [aria-live]:not([aria-live=off]), output')) {
    if (!isShown(el)) continue;
    const t = norm(innerTextOf(el));
    if (t) out.push(t);
  }
  return out;
}

function scrollState(target: Element | null): ScrollState {
  if (target && target !== document.documentElement && target !== document.body) {
    return {
      y: Math.round(target.scrollTop),
      x: Math.round(target.scrollLeft),
      scrollHeight: target.scrollHeight,
      scrollWidth: target.scrollWidth,
      viewport: target.clientHeight,
      viewportWidth: target.clientWidth,
    };
  }
  const se = document.scrollingElement ?? document.documentElement;
  return {
    y: Math.round(window.scrollY),
    x: Math.round(window.scrollX),
    scrollHeight: se.scrollHeight,
    scrollWidth: se.scrollWidth,
    viewport: window.innerHeight,
    viewportWidth: window.innerWidth,
  };
}

function scroll(id: number | null, direction: string | null, amount: number | null, to: string | null): ScrollState {
  const target = id === null ? null : mustGet(id);
  const isWin = !target || target === document.documentElement || target === document.body;
  const st0 = scrollState(target);
  let dx = 0;
  let dy = 0;
  if (to === 'top') dy = -st0.scrollHeight;
  else if (to === 'bottom') dy = st0.scrollHeight;
  else {
    const vert = direction === 'up' || direction === 'down';
    const amt = amount ?? Math.round((vert ? st0.viewport : st0.viewportWidth) * 0.8);
    if (direction === 'down') dy = amt;
    else if (direction === 'up') dy = -amt;
    else if (direction === 'right') dx = amt;
    else if (direction === 'left') dx = -amt;
  }
  if (isWin) window.scrollBy({ left: dx, top: dy, behavior: 'instant' });
  else target.scrollBy({ left: dx, top: dy, behavior: 'instant' });
  return scrollState(target);
}

function kind(el: Element): ElementKind {
  const tag = el.localName;
  const type = el instanceof HTMLInputElement ? el.type : '';
  const k: ElementKind = {
    tag,
    type,
    role: attr(el, 'role') ?? '',
    contentEditable: el instanceof HTMLElement && el.isContentEditable,
    multiple: el instanceof HTMLSelectElement ? el.multiple : el instanceof HTMLInputElement ? el.multiple : false,
    visible: isShown(el),
  };
  if (!k.visible) {
    const l = visibleLabelFor(el);
    if (l) k.labelId = idOf(l);
  }
  if (el instanceof HTMLInputElement && (type === 'checkbox' || type === 'radio')) k.checked = el.checked;
  else if (attr(el, 'aria-checked') !== null) k.checked = attr(el, 'aria-checked') === 'true';
  if (el instanceof HTMLSelectElement) k.options = Array.from(el.options).map((o) => ({ value: o.value, label: optionLabel(o) }));
  if (el instanceof HTMLInputElement && type === 'radio' && el.name) {
    const scope: ParentNode = el.form ?? (el.getRootNode() as ParentNode);
    const members = Array.from(scope.querySelectorAll('input[type=radio]')).filter(
      (r): r is HTMLInputElement => r instanceof HTMLInputElement && r.name === el.name,
    );
    k.group = members.map((r) => ({
      id: idOf(r),
      value: r.value,
      label: norm(Array.from(r.labels ?? []).map((l) => innerTextOf(l)).join(' ')) || norm(attr(r, 'aria-label')),
      checked: r.checked,
    }));
  } else if (tag === 'fieldset' || k.role.trim().toLowerCase().split(/\s+/).includes('radiogroup')) {
    // Contract answer 11: a radio group is targeted by the fieldset/radiogroup that contains the radios.
    const radios = qsa(el, 'input[type=radio], [role=radio]');
    if (radios.length > 0) {
      k.radioGroup = true;
      k.group = radios.map((r) => ({
        id: idOf(r),
        value: r instanceof HTMLInputElement ? r.value : (attr(r, 'data-value') ?? ''),
        label: nameOf(r, 'radio'),
        checked: r instanceof HTMLInputElement ? r.checked : attr(r, 'aria-checked') === 'true',
      }));
    }
  }
  return k;
}

function setValue(el: Element, value: string): void {
  if (el instanceof HTMLInputElement && valueSetter) valueSetter.call(el, value);
  else if (el instanceof HTMLTextAreaElement && taValueSetter) taValueSetter.call(el, value);
  else throw new Error('motorika:not-settable');
  el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function caretToEnd(el: Element): void {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    el.focus();
    const n = el.value.length;
    try {
      el.setSelectionRange(n, n);
    } catch {
      /* some input types do not support selection */
    }
    return;
  }
  if (el instanceof HTMLElement) {
    el.focus();
    const sel = window.getSelection();
    if (sel) {
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }
}

function annotate(items: [number, number][]): number {
  unannotate();
  const host = nativeCreate.call(document, 'div') as HTMLDivElement;
  host.setAttribute(OVERLAY_ATTR, '');
  const hs = host.style;
  hs.setProperty('position', 'fixed', 'important');
  hs.setProperty('inset', '0', 'important');
  hs.setProperty('pointer-events', 'none', 'important');
  hs.setProperty('z-index', '2147483647', 'important');
  let n = 0;
  for (const [id, ref] of items) {
    const el = elementById(id);
    if (!el || !isShown(el)) continue;
    const r = rectOf(el);
    if (r.bottom < 0 || r.right < 0 || r.top > window.innerHeight || r.left > window.innerWidth) continue;
    const box = nativeCreate.call(document, 'div') as HTMLDivElement;
    const bs = box.style;
    bs.setProperty('position', 'fixed', 'important');
    bs.setProperty('left', `${r.left}px`, 'important');
    bs.setProperty('top', `${r.top}px`, 'important');
    bs.setProperty('width', `${r.width}px`, 'important');
    bs.setProperty('height', `${r.height}px`, 'important');
    bs.setProperty('outline', '2px solid #ff2d55', 'important');
    bs.setProperty('box-sizing', 'border-box', 'important');
    const label = nativeCreate.call(document, 'span') as HTMLSpanElement;
    label.textContent = `e${ref}`;
    const ls = label.style;
    ls.setProperty('position', 'absolute', 'important');
    ls.setProperty('left', '0', 'important');
    ls.setProperty('top', r.top > 14 ? '-14px' : '0', 'important');
    ls.setProperty('background', '#ff2d55', 'important');
    ls.setProperty('color', '#fff', 'important');
    ls.setProperty('font', 'bold 11px/13px monospace', 'important');
    ls.setProperty('padding', '0 2px', 'important');
    nativeAppend.call(box, label);
    nativeAppend.call(host, box);
    n++;
  }
  nativeAppend.call(document.documentElement, host);
  return n;
}

function unannotate(): void {
  for (const el of qsa(document, `[${OVERLAY_ATTR}]`)) el.remove();
}

function hasText(text: string): boolean {
  const body = document.body;
  if (!body) return false;
  return innerTextOf(body).includes(text);
}

/** JSON-safe copy of an evaluate result; DOM elements become markers resolved by the server. */
function serialize(value: unknown): { json: string; nodes: SnapNode[] } {
  const nodes: SnapNode[] = [];
  const seen = new WeakSet<object>();
  const conv = (v: unknown, depth: number): unknown => {
    if (v === undefined) return null;
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
    if (typeof v === 'bigint') return `${v.toString()}n`;
    if (typeof v === 'function') return `[function ${(v as { name?: string }).name ?? ''}]`;
    if (typeof v === 'symbol') return v.toString();
    if (v instanceof Element) {
      nodes.push(describe(v, false));
      return `\u0000el:${nodes.length - 1}`;
    }
    if (v instanceof Node) return `[${v.nodeName}]`;
    if (typeof v !== 'object') return String(v);
    if (seen.has(v)) return '[circular]';
    if (depth > 20) return '[depth]';
    seen.add(v);
    if (v instanceof Date) return v.toISOString();
    if (v instanceof RegExp) return v.toString();
    if (v instanceof Error) return { name: v.name, message: v.message };
    if (v instanceof Map) return Object.fromEntries(Array.from(v.entries()).map(([k, x]) => [String(k), conv(x, depth + 1)]));
    if (v instanceof Set) return Array.from(v).map((x) => conv(x, depth + 1));
    if (Array.isArray(v) || v instanceof NodeList || v instanceof HTMLCollection) {
      return Array.from(v as ArrayLike<unknown>).slice(0, 10000).map((x) => conv(x, depth + 1));
    }
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).slice(0, 10000)) {
      try {
        out[k] = conv((v as Record<string, unknown>)[k], depth + 1);
      } catch {
        out[k] = '[unreadable]';
      }
    }
    return out;
  };
  return { json: JSON.stringify(conv(value, 0)) ?? 'null', nodes };
}

function rectForId(id: number): { x: number; y: number; width: number; height: number } {
  const r = rectOf(mustGet(id));
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

const engine = {
  docId: randomId(),
  ping: () => true,
  snapshot: (opts: SnapshotOptions) => snapshot(opts),
  describe: (el: Element, unique: boolean) => describe(el, unique),
  describeId: (id: number, unique: boolean) => describe(mustGet(id), unique),
  idOf: (el: Element) => idOf(el),
  byId: (id: number) => elementById(id),
  alive: (id: number) => elementById(id) !== null,
  find: (query: string, role: string | null, limit: number) => find(query, role ?? undefined, limit),
  resolveUnique: (role: string, name: string) => resolveUnique(role, name),
  quiet,
  liveTexts,
  scroll,
  scrollState: (id: number | null) => scrollState(id === null ? null : mustGet(id)),
  kind: (el: Element) => kind(el),
  setValue,
  caretToEnd,
  annotate,
  unannotate,
  read: (id: number | null, format: 'markdown' | 'text') => ({
    title: document.title,
    url: location.href,
    body: read(id === null ? null : mustGet(id), format),
  }),
  hasText,
  serialize,
  rectForId,
  parentOf: (el: Element) => parentComposed(el),
  active: () => deepActiveElement(),
  style: (el: Element, prop: string) => styleOf(el).getPropertyValue(prop),
};

export type Engine = typeof engine;

const w = window as unknown as Record<symbol, unknown>;
if (!w[KEY]) {
  Object.defineProperty(window, KEY, { value: engine, configurable: true, enumerable: false, writable: false });
}
