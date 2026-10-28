// Target strings -> ref handle | strict selector handle | point.
import type { ElementHandle, Frame, Locator } from 'playwright-core';
import type { Session } from '../browser/session.js';
import type { ShotMap, Tab } from '../browser/tabs.js';
import { ToolError, firstLine, isTimeout } from '../util/errors.js';
import { q, safeRole } from '../util/format.js';
import { call, handleFor, mainWorld, refHandle } from './engine.js';
import type { SnapNode } from './protocol.js';
import { issueRef, nodeLine, safeNode } from './snapshot.js';

export type Target =
  | { kind: 'element'; handle: ElementHandle<Element>; frame: Frame; ref: number; node: SnapNode; desc: string; note?: string }
  | { kind: 'point'; x: number; y: number; desc: string; note?: string };

export function parseRef(s: string | undefined): number | null {
  if (s === undefined) return null;
  const m = /^\s*e(\d+)\s*$/.exec(s);
  return m ? Number(m[1]) : null;
}

export function parsePoint(s: string): { x: number; y: number } | null {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(s);
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
}

/** Image px -> CSS px. page=true means document coordinates (scroll into view first). */
export function mapPoint(shot: ShotMap | undefined, x: number, y: number): { x: number; y: number; page: boolean } {
  if (!shot) return { x, y, page: false };
  return { x: shot.originX + x / shot.ratio, y: shot.originY + y / shot.ratio, page: shot.page };
}

/**
 * Round 4, F2 (the rest of P9): the role and name come from the engine, which page code can replace (a
 * cross-origin frame too), so the role is one of the snapshot vocabulary and the name is JSON-quoted,
 * as on a snapshot line.
 */
export function describeShort(ref: number, n: SnapNode): string {
  const name = typeof n.name === 'string' ? n.name : '';
  return `e${ref} ${safeRole(n.role)}${name ? ` ${q(name)}` : ''}`;
}

/** Which tab a ref belongs to (for routing). Throws a ToolError for unknown/closed/old refs. */
export function tabOfRef(session: Session, ref: number): string {
  const rec = session.refs.get(ref);
  if (rec) return rec.tabId;
  const why = session.refs.whyMissing(ref);
  if (why.reason === 'closed-tab') throw new ToolError(`e${ref} belongs to closed tab ${why.tabId ?? ''}`.trim(), 'take a new snapshot of an open tab');
  if (why.reason === 'old-doc') {
    throw new ToolError(`e${ref} is from an earlier document of ${why.tabId ?? 'its tab'} (the page navigated)`, 'take a new snapshot');
  }
  // Round 3 C3: a ref retired by the per-document cap (or the in-page sweep) gets the stale-ref error.
  if (why.reason === 'stale') throw new ToolError(`e${ref} is stale (element removed)`, 'take a new snapshot');
  throw new ToolError(`e${ref} is not a known ref`, 'take a snapshot (or find) to get current refs');
}

async function describe(session: Session, tab: Tab, frame: Frame, handle: ElementHandle<Element>, unique: boolean): Promise<{ ref: number; node: SnapNode; docId: string }> {
  const r = await call(frame, 'describe', handle, unique);
  // Round 4, F2: the engine's node is validated like a snapshot node before it is issued or printed.
  const node = safeNode(r.value);
  if (!node || node.role === 'text') throw new ToolError('the page did not describe the element', 'take a new snapshot and retry');
  return { ref: issueRef(session, tab, frame, r.docId, node), node, docId: r.docId };
}

type Rec = NonNullable<ReturnType<Session['refs']['get']>>;

/** The ref's record, checked against this tab (unknown, closed-tab, other-tab and detached-frame errors). */
function refRecord(session: Session, tab: Tab, ref: number): Rec {
  const rec = session.refs.get(ref);
  if (!rec) {
    tabOfRef(session, ref);
    throw new ToolError(`e${ref} is not a known ref`, 'take a new snapshot');
  }
  if (rec.tabId !== tab.id) throw new ToolError(`e${ref} belongs to ${rec.tabId}, not ${tab.id}`, `omit tab (refs locate their own tab) or pass tab=${rec.tabId}`);
  if (rec.frame.isDetached()) throw new ToolError(`e${ref} is in a frame that no longer exists`, 'take a new snapshot');
  return rec;
}

function oldDocError(ref: number, tab: Tab): ToolError {
  return new ToolError(`e${ref} is from an earlier document of ${tab.id} (the page navigated)`, 'take a new snapshot');
}

/**
 * A ref's current element, with the same document check as an action (C5: wait target=<ref> must not
 * look at an element of a later document): the handle, null when the element is gone, or a ToolError
 * when the ref is from an earlier document. The caller disposes the handle.
 * With `goneOk` (R-W11: wait detached|hidden), a ref whose document or frame is gone, or that was
 * retired as stale, is null ("not there") instead of an error.
 */
export async function refState(session: Session, tab: Tab, ref: number, opts: { goneOk?: boolean } = {}): Promise<ElementHandle<Element> | null> {
  if (opts.goneOk) {
    const live = session.refs.get(ref);
    if (!live) {
      const why = session.refs.whyMissing(ref);
      // Round 4, D2: a stale ref forgotten past the cap has no tab; it is gone from every tab.
      if ((why.reason === 'old-doc' || why.reason === 'stale') && (why.tabId === tab.id || why.tabId === undefined)) return null;
    } else if (live.tabId === tab.id && live.frame.isDetached()) {
      return null;
    }
  }
  const rec = refRecord(session, tab, ref);
  const h = await refHandle(rec.frame, rec.docId, rec.localId);
  if (h === 'old-doc') {
    if (opts.goneOk) return null;
    throw oldDocError(ref, tab);
  }
  return h;
}

async function resolveRef(session: Session, tab: Tab, ref: number): Promise<Target> {
  const rec = refRecord(session, tab, ref);
  const frame = rec.frame;
  // One round trip for the document check and the element (was ping + byId).
  const handle = await refHandle(frame, rec.docId, rec.localId);
  if (handle === 'old-doc') throw oldDocError(ref, tab);
  if (handle) {
    const node: SnapNode = { id: rec.localId, role: rec.role };
    if (rec.name) node.name = rec.name;
    return { kind: 'element', handle, frame, ref, node, desc: describeShort(ref, node) };
  }
  // Stale: re-resolve only on a unique role+name in the same document.
  if (rec.unique) {
    const r = await call(frame, 'resolveUnique', rec.role, rec.name);
    if (r.docId === rec.docId && r.value !== null) {
      const h2 = await handleFor(frame, r.value);
      if (h2) {
        const d = await describe(session, tab, frame, h2, true).catch(async (e: unknown) => {
          await h2.dispose().catch(() => undefined);
          throw e;
        });
        const note = `(re-resolved e${ref} -> ${describeShort(d.ref, d.node)})`;
        return { kind: 'element', handle: h2, frame, ref: d.ref, node: d.node, desc: describeShort(d.ref, d.node), note };
      }
    }
  }
  throw new ToolError(`e${ref} is stale (element removed)`, 'take a new snapshot');
}

async function strictListing(session: Session, tab: Tab, loc: Locator, selector: string): Promise<never> {
  const handles = (await loc.elementHandles().catch(() => [])) as ElementHandle<Element>[];
  const lines: string[] = [];
  for (const h of handles.slice(0, 5)) {
    const frame = (await h.ownerFrame()) ?? tab.page.mainFrame();
    try {
      const r = await call(frame, 'describe', h, false);
      lines.push(nodeLine(session, tab, frame, r.docId, r.value, 1));
    } catch {
      /* gone */
    }
  }
  for (const h of handles) await h.dispose().catch(() => undefined);
  throw new ToolError(
    `selector ${JSON.stringify(selector)} matches ${handles.length} elements:\n${lines.join('\n')}${handles.length > 5 ? `\n  - … +${handles.length - 5} more` : ''}\n`,
    'use one of these refs or a more specific selector',
  );
}

export interface ResolveOpts {
  timeoutMs: number;
}

export async function resolveTarget(session: Session, tab: Tab, target: string, opts: ResolveOpts): Promise<Target> {
  const ref = parseRef(target);
  if (ref !== null) return resolveRef(session, tab, ref);
  const pt = parsePoint(target);
  if (pt) {
    const m = mapPoint(tab.lastShot, pt.x, pt.y);
    if (m.page) {
      // Round 6 (item 6): a hostile page decides this evaluation's error; it never reaches the output.
      const v = await mainWorld(tab.page.evaluate(
        ([x, y]) => {
          const vw = window.innerWidth;
          const vh = window.innerHeight;
          if (x < window.scrollX || x >= window.scrollX + vw || y < window.scrollY || y >= window.scrollY + vh) {
            window.scrollTo({ left: x - vw / 2, top: y - vh / 2, behavior: 'instant' });
          }
          return [x - window.scrollX, y - window.scrollY] as [number, number];
        },
        [m.x, m.y] as [number, number],
      ), 'map a point');
      return { kind: 'point', x: v[0], y: v[1], desc: `point ${pt.x},${pt.y}` };
    }
    return { kind: 'point', x: m.x, y: m.y, desc: `point ${pt.x},${pt.y}` };
  }
  const loc = tab.page.locator(target);
  let handle: ElementHandle<Element> | null;
  try {
    handle = (await loc.elementHandle({ timeout: opts.timeoutMs })) as ElementHandle<Element> | null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/strict mode violation/i.test(msg)) return strictListing(session, tab, loc, target);
    if (isTimeout(e)) throw new ToolError(`no element matches ${JSON.stringify(target)} after ${opts.timeoutMs}ms`, 'check the selector, or take a snapshot and use a ref');
    throw new ToolError(`invalid target ${JSON.stringify(target)}: ${firstLine(e)}`, 'use a ref (e12), "x,y", or a Playwright selector such as text=…, role=button[name="…"], #id');
  }
  if (!handle) throw new ToolError(`no element matches ${JSON.stringify(target)}`, 'take a snapshot and use a ref');
  const frame = (await handle.ownerFrame()) ?? tab.page.mainFrame();
  const d = await describe(session, tab, frame, handle, false);
  return { kind: 'element', handle, frame, ref: d.ref, node: d.node, desc: describeShort(d.ref, d.node) };
}

/** Element-only targets (scope, upload, evaluate target, etc). */
export async function resolveElement(session: Session, tab: Tab, target: string, opts: ResolveOpts): Promise<Extract<Target, { kind: 'element' }>> {
  const t = await resolveTarget(session, tab, target, opts);
  if (t.kind !== 'element') throw new ToolError(`${target} is a point; this parameter needs an element`, 'pass a ref or a selector');
  return t;
}
