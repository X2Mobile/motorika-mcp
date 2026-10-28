// Rendered text over the composed (flattened) tree, for read and find (fix round 4, E1).
// `innerText` follows the node tree: it never includes a shadow root, and a <slot>'s innerText is its
// fallback, not what is assigned to it. Here a shadow host contributes its shadow tree, a slot its
// assigned nodes (or its fallback when nothing is assigned), and a host's unassigned light DOM nothing.
// Closed shadow roots are unreachable from the page (`el.shadowRoot` is null) and stay out.
// Cost: native innerText wherever the subtree holds no shadow host or slot; only the composed ancestors
// of those are walked here, so a page without shadow DOM pays one `querySelectorAll('*')`.
import { composedChildren, innerTextOf, parentComposed, qsa, styleOf, visibility } from './dom.js';

const NO_TEXT = new Set(['script', 'style', 'template', 'noscript', 'head', 'meta', 'link', 'title', 'datalist']);

interface Scope {
  /** Shadow hosts, slots and every composed ancestor of one: native innerText is wrong for these. */
  marked: Set<Element>;
  memo: Map<Element, string>;
  /**
   * Round 5, item 2: composed-tree pre-order position of every element (enter) and the last position inside
   * its subtree (exit), from one walk, built on the first compare that needs it. Compares are then O(1).
   */
  enter?: Map<Element, number>;
  exit?: Map<Element, number>;
}
let scope: Scope | null = null;

function buildMarks(): Set<Element> {
  const marked = new Set<Element>();
  const mark = (el: Element): void => {
    for (let cur: Element | null = el; cur && !marked.has(cur); cur = parentComposed(cur)) marked.add(cur);
  };
  const roots: (Document | ShadowRoot)[] = [document];
  for (let i = 0; i < roots.length; i++) {
    const r = roots[i]!;
    const els = r instanceof Document ? qsa(r, '*') : Array.from(r.querySelectorAll('*'));
    for (const el of els) {
      const sr = el.shadowRoot;
      if (sr) {
        mark(el);
        roots.push(sr);
      } else if (el instanceof HTMLSlotElement && r instanceof ShadowRoot) mark(el);
    }
  }
  return marked;
}

/** Runs fn with one marks set and one text memo (valid while the DOM does not change). */
export function withComposedText<T>(fn: () => T): T {
  if (scope) return fn();
  scope = { marked: buildMarks(), memo: new Map() };
  try {
    return fn();
  } finally {
    scope = null;
  }
}

/** True when nothing in el's composed subtree is a shadow host or slot (native innerText is right). */
function plain(el: Element): boolean {
  return !(scope ? scope.marked.has(el) : el.shadowRoot || el instanceof HTMLSlotElement);
}

/**
 * The rendered text of el in the composed tree, like innerText: element boundaries that are not inline
 * become a newline, hidden subtrees and script/style are left out. Not normalised.
 */
export function composedText(el: Element): string {
  return plain(el) ? innerTextOf(el) : walkText(el);
}

/** The composed walk; also for a display:contents element, which has no box for innerText to use. */
function walkText(el: Element): string {
  const memo = scope?.memo;
  const hit = memo?.get(el);
  if (hit !== undefined) return hit;
  const ownHidden = styleOf(el).visibility !== 'visible' && styleOf(el).display !== 'contents';
  let s = '';
  for (const c of composedChildren(el)) {
    if (c.nodeType === Node.TEXT_NODE) {
      if (!ownHidden) s += c.textContent ?? '';
      continue;
    }
    if (!(c instanceof Element) || NO_TEXT.has(c.localName)) continue;
    const st = styleOf(c);
    if (visibility(c, st) === 'skip') continue;
    const contents = st.display === 'contents';
    const t = contents ? walkText(c) : composedText(c);
    s += contents || st.display.startsWith('inline') ? t : `\n${t}\n`;
  }
  memo?.set(el, s);
  return s;
}

/** a is b or a composed ancestor of b. */
export function composedContains(a: Element, b: Element): boolean {
  const sc = order();
  const ea = sc?.enter?.get(a);
  const eb = sc?.enter?.get(b);
  if (ea !== undefined && eb !== undefined) return ea <= eb && eb <= sc!.exit!.get(a)!;
  for (let cur: Element | null = b; cur; cur = parentComposed(cur)) if (cur === a) return true;
  return false;
}

/** One iterative pre-order walk of the composed tree from the document element. */
function buildOrder(sc: Scope): void {
  const enter = new Map<Element, number>();
  const exit = new Map<Element, number>();
  const root = document.documentElement;
  let n = 0;
  // Frames: an element, then its children pushed in reverse; a null marks "close the element below".
  const stack: (Element | null)[] = [root];
  const open: Element[] = [];
  while (stack.length > 0) {
    const el = stack.pop();
    if (el === null) {
      exit.set(open.pop()!, n - 1);
      continue;
    }
    if (el === undefined || enter.has(el)) continue;
    enter.set(el, n++);
    open.push(el);
    stack.push(null);
    const kids = composedChildren(el);
    for (let i = kids.length - 1; i >= 0; i--) {
      const k = kids[i];
      if (k instanceof Element) stack.push(k);
    }
  }
  sc.enter = enter;
  sc.exit = exit;
}

/** The scope's order maps when the page has shadow DOM (built once), else undefined. */
function order(): Scope | undefined {
  if (!scope || scope.marked.size === 0) return undefined;
  if (!scope.enter) buildOrder(scope);
  return scope;
}

function chain(el: Element): Element[] {
  const out: Element[] = [];
  for (let cur: Element | null = el; cur; cur = parentComposed(cur)) out.push(cur);
  return out.reverse();
}

function docOrder(a: Node, b: Node): number {
  const pos = a.compareDocumentPosition(b);
  return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : pos & Node.DOCUMENT_POSITION_PRECEDING ? 1 : 0;
}

/** Composed-tree order: negative when a renders before b (an ancestor before its descendants). */
export function composedCompare(a: Element, b: Element): number {
  if (a === b) return 0;
  // No shadow host or slot on the page: the composed tree is the node tree.
  if (scope && scope.marked.size === 0) return docOrder(a, b);
  const sc = order();
  const ea = sc?.enter?.get(a);
  const eb = sc?.enter?.get(b);
  if (ea !== undefined && eb !== undefined) return ea - eb;
  // Not in the composed tree (unassigned light DOM): the ancestor-chain compare below.
  const ca = chain(a);
  const cb = chain(b);
  let i = 0;
  while (i < ca.length && i < cb.length && ca[i] === cb[i]) i++;
  if (i === ca.length) return -1;
  if (i === cb.length) return 1;
  const x = ca[i]!;
  const y = cb[i]!;
  // Siblings in one node tree (light children, or nodes assigned to one slot) keep tree order.
  if (x.parentNode === y.parentNode) return docOrder(x, y);
  if (i > 0) {
    const kids = composedChildren(ca[i - 1]!);
    const ix = kids.indexOf(x);
    const iy = kids.indexOf(y);
    if (ix >= 0 && iy >= 0) return ix - iy;
  }
  return docOrder(x, y);
}
