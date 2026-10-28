// Server side of the injected engine: CSP-safe install (CDP evaluate of a prebuilt IIFE string) and calls.
//
// Fix round 5 (sec): this is the trust boundary. `window[Symbol.for('motorika.engine')]` is page code a page,
// or a cross-origin iframe, can plant before ours, so every engine answer is untrusted:
//   - the page side runs the call inside try/catch and hands back ONE primitive string (no object crosses
//     CDP, so no page getter runs during Playwright's serialisation); a throw comes back as a flag, and the
//     page's message is never shown (only the real engine's `motorika:stale` sentinel is recognised);
//   - the Node side parses that string and coerces the result to the shape of the method (SHAPES below:
//     types and known fields only; strings stay strings, line breaks in them are escaped by the printers).
// SHAPES is typed over every engine method, so a new method without a shape does not compile; a new
// method or tool must also be added to test/regress/forged-lines-matrix.test.ts.
import { readFileSync } from 'node:fs';
import type { ElementHandle, Frame, JSHandle } from 'playwright-core';
import type { Engine } from './injected/index.js';
import type { ElementKind, FindHit, QuietResult, ScrollState, SnapAttrs, SnapNode, SnapshotResult } from './protocol.js';
import { ToolError, isClosedError, isNavigationContextError } from '../util/errors.js';
import { safeRole } from '../util/format.js';
import { log } from '../util/log.js';

let source: string | undefined;

function engineSource(): string {
  // dist/page/engine.js -> dist/injected.js
  source ??= readFileSync(new URL('../injected.js', import.meta.url), 'utf8');
  return source;
}

const MISSING = 'motorika:no-engine';

/** Engine members that are methods (docId is a field). */
type Method = { [K in keyof Engine]: Engine[K] extends (...a: never[]) => unknown ? K : never }[keyof Engine];
type Fn<M extends Method> = Engine[M] extends (...a: infer A) => infer R ? (...a: A) => R : never;
type Boxed<T> = T extends Element ? ElementHandle<Node> | ElementHandle<Element> : T;
type BoxTuple<A extends unknown[]> = { [K in keyof A]: Boxed<A[K]> };
type Args<M extends Method> = BoxTuple<Parameters<Fn<M>>>;
type Ret<M extends Method> = Awaited<ReturnType<Fn<M>>>;

export interface EngineCall<T> {
  docId: string;
  value: T;
}

/**
 * Round 6 (security, item 6): a main-world evaluation's rejection can carry page text. Playwright evaluates in
 * the page's main world through `globalThis.eval(…)` (its UtilityScript), so a page that replaces
 * `window.eval` (or a builtin that path uses) decides the error message, and our in-page try/catch never
 * runs. So EVERY rejection is replaced by an error of our own: a lost context and a closed page keep their
 * meaning as fixed texts the callers recognise; anything else becomes a fixed ToolError naming the operation.
 * Round 7: crash wording is not recognised (the dispatcher asks the browser after any failed call). Page text
 * never leaves.
 * A page can still make these fail for its own frame (the known limitation in PLAN.md, round 6).
 */
export function mainWorldError(e: unknown, what: string): Error {
  if (e instanceof ToolError) return e;
  if (isClosedError(e)) return new Error('Target page, context or browser has been closed');
  if (isNavigationContextError(e)) return new Error('Execution context was destroyed, most likely because of a navigation');
  return new ToolError(`the page's script engine failed (${what})`, 'take a new snapshot and retry');
}

/**
 * Round 7 (item 4): the budget of one frame in a fan-out over frames (snapshot, find, wait text). A frame
 * that does not answer in time (a scriptless about:blank#x iframe whose context never comes, even nested in a
 * cross-origin frame) is reported as unavailable and never holds the others: an unbounded Promise.all made
 * snapshot, find and wait time out and navigate take 31 s.
 */
export const FRAME_BUDGET_MS = 500;

/** Round 7 (item 8): the largest engine answer accepted, in chars (a real 5,000-element snapshot is ~2 MB). */
export const ENGINE_ANSWER_MAX = 8 * 1024 * 1024;

/** Resolves with `fallback` when `p` has not settled within `ms` (or rejects); the timer is cleared. */
export async function inTime<T, F>(p: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  let h: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<F>((resolve) => {
    h = setTimeout(() => resolve(fallback), Math.max(0, ms));
  });
  try {
    return await Promise.race([p.catch(() => fallback), t]);
  } finally {
    clearTimeout(h);
  }
}

/**
 * Round 7b (C2): one frame's answer in a fan-out that decides something. `unanswered` is its own state and
 * never reads as absent, gone or zero: a frame busy for longer than its budget may still hold the text, the
 * hit or the video (round 7 read it as "not there": `wait text_gone` succeeded at 502 ms while the text was
 * on the page). A failed call is unanswered too (a frame mid-navigation, a broken engine), unless the frame is
 * detached by then: `gone`, it holds nothing.
 */
export type FrameAnswer<T> = { state: 'answered'; value: T } | { state: 'unanswered' } | { state: 'gone' };

/** Asks one frame within `ms` (inTime's budget, but the three states are kept apart). */
export async function askFrame<T>(frame: Frame, p: Promise<T>, ms: number): Promise<FrameAnswer<T>> {
  let h: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    h = setTimeout(() => resolve(null), Math.max(0, ms));
  });
  try {
    const r = await Promise.race([p.then((value) => ({ value }), () => 'failed' as const), late]);
    if (r === null) return { state: 'unanswered' };
    if (r === 'failed') return frame.isDetached() ? { state: 'gone' } : { state: 'unanswered' };
    return { state: 'answered', value: r.value };
  } finally {
    clearTimeout(h);
  }
}

/**
 * Round 7b: how find, wait and video name the frames that did not answer, so the three read alike (and
 * docs/tools.md "Frames"): `1 frame unavailable (no answer within 500 ms): f2`, or with a total,
 * `1 of 3 frames …`.
 */
export function unavailableFrames(labels: string[], total?: number): string {
  const n = labels.length;
  const count = total === undefined ? `${n} frame${n === 1 ? '' : 's'}` : `${n} of ${total} frame${total === 1 ? '' : 's'}`;
  return `${count} unavailable (no answer within ${FRAME_BUDGET_MS} ms): ${labels.join(', ')}`;
}

/** A main-world evaluation whose rejection never carries page text (mainWorldError). */
export async function mainWorld<T>(p: Promise<T>, what: string): Promise<T> {
  try {
    return await p;
  } catch (e) {
    throw mainWorldError(e, what);
  }
}

async function install(frame: Frame): Promise<void> {
  await mainWorld(frame.evaluate(engineSource()), 'install');
}

function isMissing(e: unknown): boolean {
  return e instanceof Error && e.message.includes(MISSING);
}

// ---- the result guard (fix round 5, sec) ----

/** A count or id reported by the page: a finite, non-negative safe integer, anything else 0. */
export function pageCount(v: unknown): number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0;
}

/** Nesting deeper than this from an engine is cut (a real DOM walk never comes close). */
export const MAX_NODE_DEPTH = 256;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const optStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const bool = (v: unknown): boolean => v === true;
const optBool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const posInt = (v: unknown): number | undefined => (pageCount(v) > 0 ? (v as number) : undefined);
const obj = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const ids = (v: unknown): number[] => arr(v).filter((x): x is number => pageCount(x) > 0);
const strings = (v: unknown): string[] => arr(v).filter((x): x is string => typeof x === 'string');
const tri = (v: unknown): SnapAttrs['checked'] => (v === 'true' || v === 'false' || v === 'mixed' ? v : undefined);
/** Tag names and input types are printed bare (fill_form): only a token, else ''. */
const TOKEN = /^[a-z][a-z0-9-]{0,63}$/;
const token = (v: unknown): string => (typeof v === 'string' && TOKEN.test(v) ? v : '');

/** Copies the defined entries of `src` onto a fresh object (exactOptionalPropertyTypes-safe). */
function defined<T extends object>(src: { [K in keyof T]: T[K] | undefined }): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) if (v !== undefined) out[k] = v;
  return out as T;
}

/** Snapshot attributes: the known fields with their types, nothing else (printers check values again). */
export function safeAttrs(v: unknown): SnapAttrs | undefined {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const a = v as Record<string, unknown>;
  return defined<SnapAttrs>({
    level: posInt(a.level),
    type: optStr(a.type),
    password: optBool(a.password),
    checked: tri(a.checked),
    selected: optBool(a.selected),
    pressed: tri(a.pressed),
    expanded: optBool(a.expanded),
    disabled: optBool(a.disabled),
    readonly: optBool(a.readonly),
    required: optBool(a.required),
    invalid: optBool(a.invalid),
    focused: optBool(a.focused),
    value: optStr(a.value),
    valueRedacted: optBool(a.valueRedacted),
    options: Array.isArray(a.options) ? strings(a.options) : undefined,
    optionsTotal: Array.isArray(a.options) && pageCount(a.optionsTotal) > 0 ? (a.optionsTotal as number) : undefined,
    href: optStr(a.href),
  });
}

/**
 * P9: a snapshot node from an engine, made safe to print: the id is a positive integer or the node is
 * dropped, the role is one of the vocabulary (else `group`; `text` stays a text line), the name a string,
 * the attributes the known fields, the children an array.
 */
export function safeNode(v: unknown, depth = 0): SnapNode | null {
  if (v === null || typeof v !== 'object' || depth > MAX_NODE_DEPTH) return null;
  const n = v as Record<string, unknown>;
  const name = typeof n.name === 'string' ? n.name : undefined;
  if (n.role === 'text') return name === undefined ? null : { id: 0, role: 'text', name };
  const id = pageCount(n.id);
  if (id === 0) return null;
  const out: SnapNode = { id, role: safeRole(n.role) };
  if (name !== undefined) out.name = name;
  const attrs = safeAttrs(n.attrs);
  if (attrs) out.attrs = attrs;
  if (typeof n.unique === 'boolean') out.unique = n.unique;
  if (Array.isArray(n.children)) out.children = safeNodes(n.children, depth + 1);
  return out;
}

export function safeNodes(v: unknown, depth = 0): SnapNode[] {
  if (!Array.isArray(v)) return [];
  const out: SnapNode[] = [];
  for (const x of v) {
    const n = safeNode(x, depth);
    if (n) out.push(n);
  }
  return out;
}

/** A node that may be printed with a ref: never a text line. */
const elementNode = (v: unknown): SnapNode | null => {
  const n = safeNode(v);
  return n && n.role !== 'text' ? n : null;
};

function safeKind(v: unknown): ElementKind {
  const k = obj(v);
  const options = Array.isArray(k.options)
    ? k.options.map(obj).filter((o) => typeof o.value === 'string' && typeof o.label === 'string').map((o) => ({ value: o.value as string, label: o.label as string }))
    : undefined;
  const group = Array.isArray(k.group)
    ? k.group
        .map(obj)
        .filter((g) => posInt(g.id) !== undefined && typeof g.value === 'string' && typeof g.label === 'string')
        .map((g) => ({ id: g.id as number, value: g.value as string, label: g.label as string, checked: bool(g.checked) }))
    : undefined;
  return defined<ElementKind>({
    tag: token(k.tag),
    type: token(k.type),
    // The raw role attribute (only compared, never printed).
    role: str(k.role),
    contentEditable: bool(k.contentEditable),
    multiple: bool(k.multiple),
    visible: bool(k.visible),
    labelId: posInt(k.labelId),
    checked: optBool(k.checked),
    options,
    group,
    radioGroup: optBool(k.radioGroup),
  });
}

function safeScrollState(v: unknown): ScrollState {
  const o = obj(v);
  return { y: num(o.y), x: num(o.x), scrollHeight: num(o.scrollHeight), scrollWidth: num(o.scrollWidth), viewport: num(o.viewport), viewportWidth: num(o.viewportWidth) };
}

function safeSnapshot(v: unknown): SnapshotResult {
  const o = obj(v);
  return defined<SnapshotResult>({
    title: str(o.title),
    url: str(o.url),
    nodes: safeNodes(o.nodes),
    iframes: ids(o.iframes),
    omitted: pageCount(o.omitted),
    droppedIframes: Array.isArray(o.droppedIframes) ? ids(o.droppedIframes) : undefined,
    offscreen: pageCount(o.offscreen),
  });
}

function safeHits(v: unknown): FindHit[] {
  const out: FindHit[] = [];
  for (const h of arr(v)) {
    const x = obj(h);
    const node = elementNode(x.node);
    if (!node) continue;
    const hit: FindHit = { node, exact: x.exact === true };
    const context = elementNode(x.context);
    if (context) hit.context = context;
    out.push(hit);
  }
  return out;
}

function safeQuiet(v: unknown): QuietResult {
  const o = obj(v);
  return { quiet: bool(o.quiet), waited: num(o.waited), live: strings(o.live) };
}

function safeSerialized(v: unknown): { json: string; nodes: SnapNode[] } {
  const o = obj(v);
  // Indexed by marker position (evaluate.ts): an invalid node is a hole, never dropped (that would shift
  // every later index onto another element).
  const nodes: SnapNode[] = [];
  arr(o.nodes).forEach((n, i) => {
    const s = elementNode(n);
    if (s) nodes[i] = s;
  });
  return { json: typeof o.json === 'string' ? o.json : 'null', nodes };
}

function safeRect(v: unknown): { x: number; y: number; width: number; height: number } {
  const o = obj(v);
  return { x: num(o.x), y: num(o.y), width: num(o.width), height: num(o.height) };
}

type Shapes = { [M in Method]: (v: unknown) => Ret<M> };

/** What each engine method may return, coerced. Elements never come back through call(): null. */
const SHAPES = {
  ping: () => true as const,
  snapshot: safeSnapshot,
  describe: (v) => elementNode(v) as SnapNode,
  describeId: (v) => elementNode(v) as SnapNode,
  idOf: pageCount,
  byId: () => null,
  alive: bool,
  find: safeHits,
  resolveUnique: (v) => posInt(v) ?? null,
  quiet: safeQuiet,
  liveTexts: strings,
  scroll: safeScrollState,
  scrollState: safeScrollState,
  kind: safeKind,
  setValue: () => undefined,
  caretToEnd: () => undefined,
  annotate: pageCount,
  unannotate: () => undefined,
  read: (v) => {
    const o = obj(v);
    return { title: str(o.title), url: str(o.url), body: str(o.body) };
  },
  hasText: bool,
  serialize: safeSerialized,
  rectForId: safeRect,
  parentOf: () => null,
  active: () => null,
  style: str,
} satisfies Shapes as Shapes;

/**
 * A document id is a ref-registry key only (never printed). It is kept as the page gave it when it is a
 * string, so it equals what refHandle compares in the page; a non-string is replaced, and refHandle then
 * finds no matching document (old-doc), the same answer on both sides.
 */
export function safeDocId(v: unknown): string {
  return typeof v === 'string' ? v : 'motorika-bad-doc';
}

/** The page's answer: `M` no engine, `S` the real engine's stale-element throw, `T` any other throw, `R[docId,value]` (JSON). */
const STALE = 'motorika:stale';

function invoke<M extends Method>(frame: Frame, method: M, args: unknown[]): Promise<EngineCall<Ret<M>> | typeof MISSING> {
  return frame
    .evaluate(
      async ({ m, a }) => {
        // Everything that runs page code is inside the try; only a primitive string leaves.
        try {
          const e = (window as unknown as Record<symbol, Record<string, unknown> | undefined>)[Symbol.for('motorika.engine')];
          if (!e) return 'M';
          const f = e[m] as (...x: unknown[]) => unknown;
          const value = await f.apply(e, a);
          const json = JSON.stringify([e.docId, value === undefined ? null : value]);
          return typeof json === 'string' ? `R${json}` : 'T';
        } catch (x) {
          let stale = false;
          try {
            stale = x instanceof Error && x.message === 'motorika:stale';
          } catch {
            stale = false;
          }
          return stale ? 'S' : 'T';
        }
      },
      { m: method as string, a: args },
    )
    .then((r): EngineCall<Ret<M>> | typeof MISSING => {
      if (r === 'M') return MISSING;
      if (r === 'S') throw new ToolError('the element was removed from the page', 'take a new snapshot');
      // Round 7 (item 8): an answer over the cap is refused before it is parsed (a page can return anything).
      if (typeof r === 'string' && r.length > ENGINE_ANSWER_MAX) {
        throw new ToolError(`the page's script engine answered too much (${method})`, 'take a new snapshot and retry');
      }
      if (typeof r !== 'string' || r[0] !== 'R') {
        log.debug(`engine ${method}: the page's engine threw`);
        throw new ToolError(`the page's script engine failed (${method})`, 'take a new snapshot and retry');
      }
      let pair: unknown = null;
      try {
        pair = JSON.parse(r.slice(1));
      } catch {
        // Never rethrown: a JSON SyntaxError quotes its input, and the input is page text.
        pair = null;
      }
      const [docId, value] = Array.isArray(pair) ? pair : [undefined, null];
      return { docId: safeDocId(docId), value: (SHAPES[method] as (v: unknown) => unknown)(value) as Ret<M> };
    })
    .catch((e: unknown) => {
      // Round 6 (item 6): a rejection of the evaluation itself (a replaced eval) never prints page text.
      throw mainWorldError(e, method);
    });
}

async function withInstall<M extends Method>(frame: Frame, method: M, args: unknown[]): Promise<EngineCall<Ret<M>>> {
  const r = await invoke(frame, method, args);
  if (r !== MISSING) return r;
  await install(frame);
  const again = await invoke(frame, method, args);
  if (again === MISSING) throw new Error(MISSING);
  return again;
}

/**
 * Call an engine method in a frame. Installs the engine (and retries once) when the document is new.
 * Arguments may contain ElementHandles (Playwright passes them through). The result is the method's shape
 * (SHAPES), whatever the page's engine returned.
 */
export async function call<M extends Method>(frame: Frame, method: M, ...args: Args<M>): Promise<EngineCall<Ret<M>>> {
  return withInstall(frame, method, args as unknown[]);
}

/**
 * Same as call. Every result now crosses CDP as one JSON string (review P2: a nested object tree is
 * serialised by the protocol 4-6x slower; fix round 5: no page object is serialised by Playwright).
 */
export async function callJson<M extends Method>(frame: Frame, method: M, ...args: Args<M>): Promise<EngineCall<Ret<M>>> {
  return withInstall(frame, method, args as unknown[]);
}

/** A ref's element in one round trip: 'old-doc' when the frame shows another document, null when gone. */
export async function refHandle(frame: Frame, docId: string, localId: number): Promise<ElementHandle<Element> | null | 'old-doc'> {
  let h: JSHandle;
  try {
    h = await frame.evaluateHandle(
      ({ id, doc }) => {
        // Fix round 5: page code runs only inside the tries; the only throw is our own sentinel.
        let same = false;
        let e: { docId: string; byId: (n: number) => Element | null } | undefined;
        try {
          e = (window as unknown as Record<symbol, { docId: string; byId: (n: number) => Element | null } | undefined>)[Symbol.for('motorika.engine')];
          // The same test as safeDocId on the Node side: a string, compared as given.
          same = !!e && typeof e.docId === 'string' && e.docId === doc;
        } catch {
          same = false;
        }
        if (!same || !e) throw new Error('motorika:old-doc');
        try {
          const el = e.byId(id);
          return el instanceof Element ? el : null;
        } catch {
          return null;
        }
      },
      { id: localId, doc: docId },
    );
  } catch (e) {
    // No engine means a document the ref was not issued in.
    if (isMissing(e) || (e instanceof Error && e.message.includes('motorika:old-doc'))) return 'old-doc';
    throw mainWorldError(e, 'resolve a ref');
  }
  const el = h.asElement();
  if (!el) {
    await h.dispose().catch(() => undefined);
    return null;
  }
  return el as ElementHandle<Element>;
}

/** Current document id of a frame (installs the engine if needed). */
export async function docIdOf(frame: Frame): Promise<string> {
  const r = await call(frame, 'ping');
  return r.docId;
}

/** Element handle for a document-local id, or null if the element is gone. */
export async function handleFor(frame: Frame, localId: number): Promise<ElementHandle<Element> | null> {
  let h: JSHandle;
  try {
    h = await frame.evaluateHandle((id) => {
      let e: { byId: (n: number) => Element | null } | undefined;
      try {
        e = (window as unknown as Record<symbol, { byId: (n: number) => Element | null } | undefined>)[Symbol.for('motorika.engine')];
      } catch {
        e = undefined;
      }
      if (!e) throw new Error('motorika:no-engine');
      try {
        const el = e.byId(id);
        return el instanceof Element ? el : null;
      } catch {
        return null;
      }
    }, localId);
  } catch (e) {
    if (isMissing(e)) return null;
    throw mainWorldError(e, 'resolve an element');
  }
  const el = h.asElement();
  if (!el) {
    await h.dispose().catch(() => undefined);
    return null;
  }
  return el as ElementHandle<Element>;
}
