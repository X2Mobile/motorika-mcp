// DOM primitives for the injected engine: cached natives, ids, visibility, roles, accessible names.
// Rules: no eval/Function, no innerHTML/outerHTML (Trusted Types and CSP safe).
import type { SnapAttrs, Tri } from '../protocol.js';

// ---- cached natives (pages sometimes monkey-patch prototypes) ----
const ElementProto = Element.prototype;
const nativeRect = ElementProto.getBoundingClientRect;
const nativeGetAttr = ElementProto.getAttribute;
const nativeHasAttr = ElementProto.hasAttribute;
const nativeQSA = ElementProto.querySelectorAll;
const nativeDocQSA = Document.prototype.querySelectorAll;
const nativeGetById = Document.prototype.getElementById;
const nativeCheckVis = (ElementProto as { checkVisibility?: (o?: { visibilityProperty?: boolean }) => boolean }).checkVisibility;
const nativeGCS = window.getComputedStyle.bind(window);
const innerTextDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'innerText');

export function rectOf(el: Element): DOMRect {
  return nativeRect.call(el);
}
export function attr(el: Element, name: string): string | null {
  return nativeGetAttr.call(el, name);
}
export function hasAttr(el: Element, name: string): boolean {
  return nativeHasAttr.call(el, name);
}
export function qsa(root: Element | Document, sel: string): Element[] {
  return Array.from(root instanceof Document ? nativeDocQSA.call(root, sel) : nativeQSA.call(root, sel));
}
export function styleOf(el: Element): CSSStyleDeclaration {
  return nativeGCS(el);
}
export function innerTextOf(el: Element): string {
  if (el instanceof HTMLElement && innerTextDesc?.get) return String(innerTextDesc.get.call(el) ?? '');
  return el.textContent ?? '';
}
export function byIdIn(el: Element, id: string): Element | null {
  const root = el.getRootNode();
  if (root instanceof Document) return nativeGetById.call(root, id);
  if (root instanceof ShadowRoot) return root.getElementById(id);
  return null;
}

// ---- ids ----
const ids = new WeakMap<Element, number>();
const byIdMap = new Map<number, WeakRef<Element>>();
let counter = 0;

export function idOf(el: Element): number {
  let id = ids.get(el);
  if (id === undefined) {
    id = ++counter;
    ids.set(el, id);
    byIdMap.set(id, new WeakRef(el));
  } else if (!byIdMap.has(id)) {
    // Swept while detached, now walked again (re-attached): keep its id.
    byIdMap.set(id, new WeakRef(el));
  }
  return id;
}

/** Bumped by the engine's long-lived MutationObserver; caches keyed on it are valid until the DOM changes. */
let docVersion = 0;
export function bumpDocVersion(): void {
  docVersion++;
}
let flushPending: () => void = () => undefined;
/** The engine registers how to deliver the observer's pending records before a cache is read. */
export function setMutationFlush(fn: () => void): void {
  flushPending = fn;
}
export function currentDocVersion(): number {
  flushPending();
  return docVersion;
}

let sweptAt = 0;
/**
 * Review P7: drop id-map entries whose element was garbage-collected, so a single-page app that
 * re-renders keeps the map near the size of the live heap. Runs at the start of a walk once the map has
 * grown by half since the last sweep. Only dead WeakRefs are dropped: a detached element that is still
 * alive keeps its entry, so its ref works again once it is re-attached.
 */
export function sweepIds(): void {
  if (byIdMap.size < 2000 || byIdMap.size < sweptAt * 1.5) return;
  for (const [id, ref] of byIdMap) {
    if (!ref.deref()) byIdMap.delete(id);
  }
  sweptAt = byIdMap.size;
}
export function elementById(id: number): Element | null {
  const el = byIdMap.get(id)?.deref();
  return el && el.isConnected ? el : null;
}

// ---- text helpers ----
export function norm(s: string | null | undefined): string {
  return (s ?? '').replace(/[\s ]+/g, ' ').trim();
}

/**
 * Review P2: names and values leave the page capped. 101 chars keeps the server's "truncated at 100
 * with …" rule exact (it still sees that the text was longer than 100).
 */
export const OUT_CAP = 101;
export function capOut(s: string): string {
  return s.length > OUT_CAP ? s.slice(0, OUT_CAP) : s;
}
/** aria-labelledby text is capped at 400 chars before it is used as a name. */
const LABELLEDBY_CAP = 400;

// ---- labels (review P3) ----
// `.labels` re-searches the document after any DOM change. A walk builds one control -> labels map
// from a single pass over the document's labels and uses it for every control it meets.
let labelMap: Map<Element, HTMLLabelElement[]> | null = null;

export function withLabelMap<T>(fn: () => T): T {
  if (labelMap) return fn();
  const m = new Map<Element, HTMLLabelElement[]>();
  for (const l of qsa(document, 'label')) {
    const c = (l as HTMLLabelElement).control;
    if (!c) continue;
    const arr = m.get(c);
    if (arr) arr.push(l as HTMLLabelElement);
    else m.set(c, [l as HTMLLabelElement]);
  }
  labelMap = m;
  try {
    return fn();
  } finally {
    labelMap = null;
  }
}

/** The labels of a control: from the walk's map for document controls, else `.labels` (shadow roots). */
export function labelsOf(el: Element): HTMLLabelElement[] {
  if (labelMap && el.getRootNode() === document) return labelMap.get(el) ?? [];
  const ls = (el as HTMLInputElement).labels;
  return ls ? Array.from(ls) : [];
}

// ---- visibility ----
export type Vis = 'skip' | 'descend' | 'visible';

/** 'skip' = subtree not rendered; 'descend' = element itself hidden, children may show; 'visible'. */
export function visibility(el: Element, st: CSSStyleDeclaration): Vis {
  if (attr(el, 'aria-hidden') === 'true') return 'skip';
  if (hasAttr(el, 'inert')) return 'skip';
  if (st.display === 'contents') return 'descend';
  if (st.display === 'none') return 'skip';
  if (nativeCheckVis && !nativeCheckVis.call(el)) return 'skip';
  // Not rendered (contract answer 3): checkVisibility({ visibilityProperty: true }) is false. A
  // visibility:hidden element is excluded itself, but a descendant may set visibility:visible again.
  if (nativeCheckVis ? !nativeCheckVis.call(el, { visibilityProperty: true }) : st.visibility !== 'visible') return 'descend';
  const r = rectOf(el);
  if (r.width <= 0 || r.height <= 0) return 'descend';
  return 'visible';
}

/** Fully visible to a user (for labels, hidden-input exception, annotate). */
export function isShown(el: Element): boolean {
  let cur: Element | null = el;
  while (cur) {
    if (attr(cur, 'aria-hidden') === 'true' || hasAttr(cur, 'inert')) return false;
    cur = cur.parentElement ?? ((cur.getRootNode() as ShadowRoot).host ?? null);
  }
  if (nativeCheckVis ? !nativeCheckVis.call(el, { visibilityProperty: true }) : styleOf(el).visibility !== 'visible') return false;
  const r = rectOf(el);
  return r.width > 0 && r.height > 0;
}

export function inViewport(el: Element): boolean {
  const r = rectOf(el);
  return r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
}

// ---- roles ----
export const VOCAB = new Set([
  'link', 'button', 'textbox', 'searchbox', 'combobox', 'listbox', 'option', 'checkbox', 'radio', 'switch',
  'slider', 'spinbutton', 'tab', 'tablist', 'tabpanel', 'menu', 'menubar', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'tree', 'treeitem', 'grid', 'row', 'cell', 'columnheader', 'rowheader', 'heading', 'img',
  'dialog', 'alertdialog', 'alert', 'status', 'log', 'progressbar', 'banner', 'navigation', 'main',
  'complementary', 'contentinfo', 'search', 'form', 'region', 'list', 'listitem', 'table', 'figure',
  'article', 'group', 'toolbar', 'iframe', 'video', 'audio', 'canvas', 'file',
]);

const ROLE_ALIASES: Record<string, string> = {
  image: 'img',
  radiogroup: 'group',
  gridcell: 'cell',
  treegrid: 'grid',
  marquee: 'log',
  timer: 'status',
  rowgroup: 'generic',
  presentation: 'generic',
  none: 'generic',
  document: 'generic',
  application: 'generic',
  note: 'generic',
  paragraph: 'generic',
};

export const INTERACTIVE = new Set([
  'link', 'button', 'textbox', 'searchbox', 'combobox', 'listbox', 'option', 'checkbox', 'radio', 'switch',
  'slider', 'spinbutton', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem', 'file', 'clickable',
]);
export const LANDMARKS = new Set(['banner', 'navigation', 'main', 'complementary', 'contentinfo', 'search', 'form', 'region']);
export const LIVE = new Set(['alert', 'status', 'log']);
/** Containers kept in interactive mode only when something is included under them. */
export const CONTAINERS = new Set(['tablist', 'tabpanel', 'menu', 'menubar', 'tree', 'grid', 'toolbar', 'listbox', 'row']);
/** Extra roles in full mode. */
export const FULL_ONLY = new Set(['img', 'list', 'listitem', 'table', 'row', 'cell', 'columnheader', 'rowheader', 'article', 'figure', 'group', 'canvas']);
/** Roles whose name comes from content; their text is not repeated as text lines. */
export const NAME_FROM_CONTENT = new Set([
  'link', 'button', 'heading', 'option', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem',
  'cell', 'columnheader', 'rowheader', 'checkbox', 'radio', 'switch', 'clickable', 'alert', 'status', 'log',
]);
/** Leaf roles: no structural descent. */
export const LEAF = new Set(['textbox', 'searchbox', 'combobox', 'slider', 'spinbutton', 'file', 'img', 'video', 'audio', 'canvas', 'iframe', 'progressbar']);

const SECTIONING = 'article, aside, main, nav, section, [role=article], [role=complementary], [role=main], [role=navigation], [role=region]';

function textInputRole(el: HTMLInputElement): string {
  return hasAttr(el, 'list') ? 'combobox' : 'textbox';
}

export function implicitRole(el: Element): string {
  const tag = el.localName;
  switch (tag) {
    case 'a':
    case 'area':
      return hasAttr(el, 'href') ? 'link' : 'generic';
    case 'button':
      return 'button';
    case 'summary':
      return 'button';
    case 'input': {
      const t = (el as HTMLInputElement).type;
      switch (t) {
        case 'hidden':
          return 'none';
        case 'button':
        case 'submit':
        case 'reset':
        case 'image':
          return 'button';
        case 'checkbox':
          return 'checkbox';
        case 'radio':
          return 'radio';
        case 'range':
          return 'slider';
        case 'number':
          return 'spinbutton';
        case 'file':
          return 'file';
        case 'search':
          return hasAttr(el, 'list') ? 'combobox' : 'searchbox';
        default:
          return textInputRole(el as HTMLInputElement);
      }
    }
    case 'select': {
      const s = el as HTMLSelectElement;
      return s.multiple || s.size > 1 ? 'listbox' : 'combobox';
    }
    case 'textarea':
      return 'textbox';
    case 'option':
      return 'option';
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return 'heading';
    case 'img':
      return attr(el, 'alt') === '' ? 'generic' : 'img';
    case 'svg':
      return 'generic';
    case 'nav':
      return 'navigation';
    case 'main':
      return 'main';
    case 'aside':
      return 'complementary';
    case 'header':
      return el.parentElement?.closest(SECTIONING) ? 'generic' : 'banner';
    case 'footer':
      return el.parentElement?.closest(SECTIONING) ? 'generic' : 'contentinfo';
    case 'form':
      return 'form';
    case 'section':
      return 'region';
    case 'search':
      return 'search';
    case 'dialog':
      return 'dialog';
    case 'ul':
    case 'ol':
    case 'menu':
      return 'list';
    case 'li':
      return 'listitem';
    case 'table':
      return 'table';
    case 'tr':
      return 'row';
    case 'td':
      return 'cell';
    case 'th':
      return attr(el, 'scope') === 'row' ? 'rowheader' : 'columnheader';
    case 'figure':
      return 'figure';
    case 'article':
      return 'article';
    case 'fieldset':
    case 'details':
    case 'optgroup':
      return 'group';
    case 'iframe':
    case 'frame':
      return 'iframe';
    case 'video':
      return 'video';
    case 'audio':
      return 'audio';
    case 'canvas':
      return 'canvas';
    case 'progress':
    case 'meter':
      return 'progressbar';
    case 'output':
      return 'status';
    default:
      break;
  }
  if (el instanceof HTMLElement && el.isContentEditable && !(el.parentElement?.isContentEditable ?? false)) return 'textbox';
  return 'generic';
}

export function roleOf(el: Element): string {
  const explicit = attr(el, 'role');
  if (explicit) {
    for (const tok of explicit.trim().toLowerCase().split(/\s+/)) {
      const r = ROLE_ALIASES[tok] ?? tok;
      if (r === 'generic') {
        // Presentational roles are ignored on focusable or labelled elements (ARIA conflict resolution).
        if (el instanceof HTMLElement && el.tabIndex >= 0 && hasAttr(el, 'tabindex')) break;
        return 'generic';
      }
      if (VOCAB.has(r)) {
        if (r === 'checkbox' && el instanceof HTMLInputElement && el.type === 'checkbox' && tok === 'switch') return 'switch';
        return r;
      }
    }
  }
  return implicitRole(el);
}

// ---- accessible name (simplified accname) ----
function textOfRefs(el: Element, idrefs: string): string {
  let out = '';
  for (const id of idrefs.split(/\s+/)) {
    const t = byIdIn(el, id);
    if (!t) continue;
    out += ` ${attr(t, 'aria-label') ?? innerTextOf(t) ?? t.textContent ?? ''}`;
    if (out.length > LABELLEDBY_CAP * 2) break;
  }
  return norm(out).slice(0, LABELLEDBY_CAP);
}

function labelText(control: Element): string {
  const labels = labelsOf(control);
  if (labels.length === 0) return '';
  const parts: string[] = [];
  for (const l of labels) {
    let t = '';
    // Label text minus nested control values.
    for (const n of Array.from(l.childNodes)) {
      if (n === control) continue;
      if (n instanceof Element) {
        if (n.matches('input, select, textarea')) continue;
        t += ` ${innerTextOf(n) || n.textContent || ''}`;
      } else if (n.nodeType === Node.TEXT_NODE) t += ` ${n.textContent ?? ''}`;
    }
    parts.push(norm(t));
  }
  return norm(parts.join(' '));
}

function contentName(el: Element): string {
  let t = norm(innerTextOf(el));
  if (t !== '') return t;
  // Images / svg titles / aria-labels inside (icon buttons and links).
  for (const c of qsa(el, 'img[alt], [aria-label], svg title')) {
    t = norm(c.localName === 'title' ? c.textContent : (attr(c, 'aria-label') ?? attr(c, 'alt')));
    if (t !== '') return t;
  }
  return norm(el.textContent);
}

export function nameOf(el: Element, role: string): string {
  const lb = attr(el, 'aria-labelledby');
  if (lb) {
    const t = textOfRefs(el, lb);
    if (t) return t;
  }
  const al = norm(attr(el, 'aria-label'));
  if (al) return al;
  const tag = el.localName;
  if (tag === 'input') {
    const inp = el as HTMLInputElement;
    if (['button', 'submit', 'reset'].includes(inp.type)) {
      return norm(inp.value) || (inp.type === 'submit' ? 'Submit' : inp.type === 'reset' ? 'Reset' : '');
    }
    if (inp.type === 'image') return norm(attr(el, 'alt')) || 'Submit';
    const l = labelText(el);
    if (l) return l;
    return norm(attr(el, 'title')) || norm(attr(el, 'placeholder'));
  }
  if (tag === 'select' || tag === 'textarea' || tag === 'meter' || tag === 'progress' || tag === 'output') {
    const l = labelText(el);
    if (l) return l;
    return norm(attr(el, 'title')) || norm(attr(el, 'placeholder'));
  }
  if (tag === 'img' || tag === 'area') return norm(attr(el, 'alt')) || norm(attr(el, 'title'));
  if (tag === 'fieldset') {
    const lg = el.querySelector(':scope > legend');
    if (lg) return norm(innerTextOf(lg));
  }
  if (tag === 'table') {
    const cap = (el as HTMLTableElement).caption;
    if (cap) return norm(innerTextOf(cap));
  }
  if (tag === 'figure') {
    const fc = el.querySelector(':scope > figcaption');
    if (fc) return norm(innerTextOf(fc));
  }
  if (tag === 'details') {
    const s = el.querySelector(':scope > summary');
    if (s) return norm(innerTextOf(s));
  }
  if (tag === 'iframe' || tag === 'frame') return norm(attr(el, 'title')) || norm(attr(el, 'name'));
  if (role === 'textbox' && el instanceof HTMLElement && el.isContentEditable) {
    return norm(attr(el, 'title')) || norm(attr(el, 'aria-placeholder')) || norm(attr(el, 'placeholder'));
  }
  if (NAME_FROM_CONTENT.has(role)) {
    const c = contentName(el);
    if (c) return c.length > 400 ? c.slice(0, 400) : c;
  }
  return norm(attr(el, 'title'));
}

// ---- states ----
function tri(v: string | null): Tri | undefined {
  if (v === 'true' || v === 'false' || v === 'mixed') return v;
  return undefined;
}

export function deepActiveElement(): Element | null {
  let a: Element | null = document.activeElement;
  while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
  return a;
}

/** Grammar: `type=<input type other than text/password>`; every other input type is shown. */
const NO_TYPE_ATTR = new Set(['text', 'password']);

export function optionLabel(o: HTMLOptionElement): string {
  return norm(o.label || o.text);
}

export function attrsOf(el: Element, role: string, active: Element | null): SnapAttrs {
  const a: SnapAttrs = {};
  if (role === 'heading') {
    const lv = Number(attr(el, 'aria-level'));
    const m = /^h([1-6])$/.exec(el.localName);
    a.level = lv > 0 ? lv : m ? Number(m[1]) : 2;
  }
  const isInput = el instanceof HTMLInputElement;
  if (isInput && !NO_TYPE_ATTR.has(el.type)) a.type = el.type;
  const isPassword = isInput && el.type === 'password';
  if (isPassword) a.password = true;
  if (role === 'checkbox' || role === 'radio' || role === 'switch' || role === 'menuitemcheckbox' || role === 'menuitemradio') {
    if (isInput && (el.type === 'checkbox' || el.type === 'radio')) {
      a.checked = el.indeterminate ? 'mixed' : el.checked ? 'true' : 'false';
    } else {
      a.checked = tri(attr(el, 'aria-checked')) ?? 'false';
    }
  }
  if (role === 'option' || role === 'tab' || role === 'treeitem' || role === 'row' || role === 'cell') {
    if (el instanceof HTMLOptionElement ? el.selected : attr(el, 'aria-selected') === 'true') a.selected = true;
  }
  const pressed = tri(attr(el, 'aria-pressed'));
  if (pressed && role === 'button') a.pressed = pressed;
  const exp = attr(el, 'aria-expanded');
  if (exp === 'true' || exp === 'false') a.expanded = exp === 'true';
  else if (el.localName === 'summary' && el.parentElement instanceof HTMLDetailsElement) a.expanded = el.parentElement.open;
  let disabled = attr(el, 'aria-disabled') === 'true';
  try {
    if (el.matches(':disabled')) disabled = true;
  } catch {
    /* ignore */
  }
  if (disabled) a.disabled = true;
  if (((isInput || el instanceof HTMLTextAreaElement) && (el as HTMLInputElement).readOnly) || attr(el, 'aria-readonly') === 'true') {
    a.readonly = true;
  }
  if (((isInput || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) && (el as HTMLInputElement).required) || attr(el, 'aria-required') === 'true') {
    a.required = true;
  }
  let invalid = attr(el, 'aria-invalid') === 'true';
  try {
    if (!invalid && el.matches(':user-invalid')) invalid = true;
  } catch {
    /* older engines */
  }
  if (invalid) a.invalid = true;
  if (active === el) a.focused = true;

  // value
  if (isInput && !['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'hidden'].includes(el.type)) {
    if (el.type === 'file') {
      const names = Array.from(el.files ?? []).map((f) => f.name);
      if (names.length > 0) a.value = names.join(', ');
    } else if (isPassword) {
      if (el.value !== '') a.valueRedacted = true;
    } else if (el.value !== '') a.value = capOut(el.value);
    if (hasAttr(el, 'list')) {
      const dl = el.list;
      if (dl) {
        const opts = dl.options;
        a.options = Array.from(opts).slice(0, 10).map((o) => capOut(optionLabel(o)));
        a.optionsTotal = opts.length;
      }
    }
  } else if (el instanceof HTMLTextAreaElement) {
    if (el.value !== '') a.value = capOut(el.value);
  } else if (el instanceof HTMLSelectElement) {
    const sel = Array.from(el.selectedOptions).slice(0, 20).map(optionLabel);
    if (sel.length > 0) a.value = capOut(sel.join(', '));
    const opts = el.options;
    a.options = Array.from(opts).slice(0, 10).map((o) => capOut(optionLabel(o)));
    a.optionsTotal = opts.length;
  } else if (role === 'textbox' && el instanceof HTMLElement && el.isContentEditable) {
    const v = norm(innerTextOf(el));
    if (v !== '') a.value = capOut(v);
  } else if (role === 'slider' || role === 'spinbutton' || role === 'progressbar') {
    const v = attr(el, 'aria-valuetext') ?? attr(el, 'aria-valuenow') ?? (el as HTMLProgressElement).value?.toString();
    if (v !== undefined && v !== null && v !== '') a.value = capOut(String(v));
  } else if (role === 'combobox' || role === 'textbox' || role === 'searchbox') {
    const v = attr(el, 'aria-valuetext') ?? attr(el, 'aria-valuenow');
    if (v) a.value = capOut(v);
  }
  if (role === 'link') {
    const href = (el as HTMLAnchorElement).href;
    if (typeof href === 'string' && href !== '') a.href = href;
  }
  return a;
}

/** A label that is visible and associated with this (visually hidden) control. */
export function visibleLabelFor(el: Element): Element | null {
  for (const l of labelsOf(el)) if (isShown(l)) return l;
  const lb = attr(el, 'aria-labelledby');
  if (lb) {
    for (const id of lb.split(/\s+/)) {
      const t = byIdIn(el, id);
      if (t && isShown(t)) return t;
    }
  }
  return null;
}

export function composedChildren(el: Element): Node[] {
  if (el instanceof HTMLSlotElement) {
    const assigned = el.assignedNodes({ flatten: true });
    return assigned.length > 0 ? assigned : Array.from(el.childNodes);
  }
  if (el.shadowRoot) return Array.from(el.shadowRoot.childNodes);
  return Array.from(el.childNodes);
}

export function parentComposed(el: Element): Element | null {
  if (el.assignedSlot) return el.assignedSlot;
  if (el.parentElement) return el.parentElement;
  const root = el.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}
