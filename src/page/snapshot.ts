// Server side of snapshots: per-frame engine calls, iframe stitching (incl. OOPIF), ref issuing, lines.
import type { ElementHandle, Frame } from 'playwright-core';
import type { Session } from '../browser/session.js';
import type { Tab } from '../browser/tabs.js';
import { elementLine, safeRole, snapshotHeader, textLine } from '../util/format.js';
import { FRAME_BUDGET_MS, askFrame, callJson, inTime, pageCount, safeDocId, safeNode, safeNodes } from './engine.js';
import type { SnapNode, SnapshotOptions } from './protocol.js';

export interface SnapshotRequest {
  mode: 'interactive' | 'full';
  viewportOnly: boolean;
  scope?: { frame: Frame; localId: number };
  /** Receives every issued ref (screenshot annotate). */
  collect?: { frame: Frame; localId: number; ref: number }[];
  /**
   * Build at most this many lines per frame (review P2/S2: offset + what max_chars can hold); the rest
   * are only counted. Unset builds everything.
   */
  limit?: number;
  /** The automatic snapshot: uniqueness counts from the walk itself (see SnapshotOptions.countsFromWalk). */
  countsFromWalk?: boolean;
}

export interface BuiltSnapshot {
  header: string;
  lines: string[];
  /** Lines that exist but were not built (see limit). */
  omitted: number;
  /** viewport_only: elements left out because they lie outside the viewport (iframes in view included). */
  offscreen: number;
}

/** Lines needed to fill max_chars from offset: an output line is at least 8 chars ("- link e1"). */
export function lineLimit(offset: number, maxChars: number): number {
  return offset + Math.ceil(maxChars / 8) + 1;
}

interface FrameResult {
  docId: string;
  nodes: SnapNode[];
  title: string;
  omitted: number;
  offscreen: number;
  /** Child frames by the id of their iframe element; `result` null: the frame did not answer (unavailable). */
  children: Map<number, { frame: Frame; result: FrameResult | null }>;
  /**
   * Round 7b (W1): iframes of this frame whose content is not shown: the frame did not answer within its
   * budget, its call failed, or no frame could be matched to the iframe. Their lines carry `unavailable`.
   */
  unavailable: Set<number>;
  /** Iframe ids in the snapshot, and those past the cut (only counted, see `limit`). */
  iframeIds: Set<number>;
  droppedIds: Set<number>;
}

// P9 / fix round 5: node validation lives at the engine boundary (engine.ts); re-exported for callers.
export { MAX_NODE_DEPTH, pageCount, safeNode, safeNodes } from './engine.js';

const idList = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => pageCount(x) > 0) : []);

/**
 * Round 7b (W2): the fan-out below the snapshot's own frame ends this long after that frame answered. Each
 * frame's own answer has FRAME_BUDGET_MS; its children are asked once it answered, so nested frames add up,
 * and this bounds the whole tree (a chain of frames that each answer just in time).
 */
export const FRAME_TREE_MS = 3 * FRAME_BUDGET_MS;

/** One frame's own engine answer, without its child frames. */
async function ownSnapshot(frame: Frame, opts: SnapshotOptions): Promise<FrameResult> {
  // One JSON string across CDP (review P2).
  const r = await callJson(frame, 'snapshot', opts);
  const v = (r.value !== null && typeof r.value === 'object' ? r.value : {}) as Partial<Record<keyof typeof r.value, unknown>>;
  return {
    docId: safeDocId(r.docId),
    nodes: safeNodes(v.nodes),
    title: typeof v.title === 'string' ? v.title : '',
    omitted: pageCount(v.omitted),
    offscreen: pageCount(v.offscreen),
    children: new Map(),
    unavailable: new Set(),
    iframeIds: new Set(idList(v.iframes)),
    droppedIds: new Set(idList(v.droppedIframes)),
  };
}

/**
 * Asks the child frames of a frame that answered. Round 7 gave each child 500 ms for its whole subtree, so a
 * frame that answered but held a hanging child was shown as unavailable with all its content (W2). Now a
 * child's budget covers its own answer (and the mapping of its iframes); a child that answered shows its
 * content, and only a child that did not is marked.
 */
async function addChildren(frame: Frame, res: FrameResult, opts: SnapshotOptions, treeEnd: number): Promise<void> {
  if (res.iframeIds.size === 0 && res.droppedIds.size === 0) return;
  const left = (): number => Math.min(FRAME_BUDGET_MS, treeEnd - Date.now());
  const kids = frame.childFrames().filter((f) => !f.isDetached());
  // Map child frames to their iframe ids in one page call (was two round trips per child frame).
  const els = (await Promise.all(kids.map((k) => inTime(k.frameElement(), left(), null)))) as (ElementHandle<Element> | null)[];
  let ids: (number | null)[] = [];
  try {
    const mapped = await inTime(
      frame.evaluate((list) => {
        const e = (window as unknown as Record<symbol, { idOf: (el: Element) => number } | undefined>)[Symbol.for('motorika.engine')];
        return list.map((el) => (el && e ? e.idOf(el) : null));
      }, els),
      left(),
      null,
    );
    // Fix round 5: the page's idOf is untrusted too: only positive integers map a child frame.
    ids = (Array.isArray(mapped) ? mapped : []).map((x) => (pageCount(x) > 0 ? (x as number) : null));
  } finally {
    for (const el of els) void el?.dispose().catch(() => undefined);
  }
  const childOpts: SnapshotOptions = { mode: opts.mode, viewportOnly: opts.viewportOnly };
  if (opts.limit !== undefined) childOpts.limit = opts.limit;
  if (opts.countsFromWalk !== undefined) childOpts.countsFromWalk = opts.countsFromWalk;
  await Promise.all(
    kids.map(async (child, i) => {
      const id = ids[i];
      if (id === null || id === undefined) return;
      // Re-check item 10: an iframe past the cut still counts its frame's lines in the footer. Limit 0
      // sends no nodes, only the count (and its own nested iframes are counted the same way).
      const dropped = res.droppedIds.has(id);
      if (!dropped && !res.iframeIds.has(id)) return;
      const o = dropped ? { ...childOpts, limit: 0 } : childOpts;
      const a = await askFrame(child, ownSnapshot(child, o), left());
      if (a.state !== 'answered') {
        if (!dropped) res.children.set(id, { frame: child, result: null }); // marked below, with its frame id
        return;
      }
      await addChildren(child, a.value, o, treeEnd);
      if (dropped) res.omitted += omittedIn(a.value);
      else res.children.set(id, { frame: child, result: a.value });
    }),
  );
  for (const id of res.iframeIds) if (!res.children.get(id)?.result) res.unavailable.add(id);
}

function omittedIn(fr: FrameResult): number {
  let n = fr.omitted;
  for (const c of fr.children.values()) if (c.result) n += omittedIn(c.result);
  return n;
}

function offscreenIn(fr: FrameResult): number {
  let n = fr.offscreen;
  for (const c of fr.children.values()) if (c.result) n += offscreenIn(c.result);
  return n;
}

export function issueRef(session: Session, tab: Tab, frame: Frame, docId: string, node: SnapNode): number {
  return session.refs.issue({
    tabId: tab.id,
    frame,
    docId,
    localId: node.id,
    role: node.role,
    name: node.name ?? '',
    // W2: undefined when the describer did not compute uniqueness (a selector target, a strict-mode
    // listing); the registry then keeps the value it had (core's refs.ts change). Never lower it here.
    unique: node.unique as boolean,
  });
}

type Collect = SnapshotRequest['collect'];

function render(session: Session, tab: Tab, frame: Frame, fr: FrameResult, nodes: SnapNode[], depth: number, pageUrl: string, out: string[], collect: Collect): void {
  for (const n of nodes) {
    if (n.role === 'text') {
      out.push(textLine(depth, n.name ?? ''));
      continue;
    }
    const ref = issueRef(session, tab, frame, fr.docId, n);
    collect?.push({ frame, localId: n.id, ref });
    const iframe = n.role === 'iframe';
    const child = iframe ? fr.children.get(n.id) : undefined;
    const unavailable = iframe && fr.unavailable.has(n.id);
    out.push(elementLine(depth, n.role, n.name, ref, n.attrs, pageUrl, child ? tab.frameLabel(child.frame) : undefined, unavailable));
    if (n.children) render(session, tab, frame, fr, n.children, depth + 1, pageUrl, out, collect);
    // P9: a frame's URL is Playwright's, never what its engine reports.
    if (child?.result) render(session, tab, child.frame, child.result, child.result.nodes, depth + 1, child.frame.url(), out, collect);
  }
}

export async function buildSnapshot(session: Session, tab: Tab, req: SnapshotRequest): Promise<BuiltSnapshot> {
  const frame = req.scope?.frame ?? tab.page.mainFrame();
  const opts: SnapshotOptions = { mode: req.mode, viewportOnly: req.viewportOnly };
  if (req.scope) opts.scope = req.scope.localId;
  if (req.limit !== undefined) opts.limit = req.limit;
  if (req.countsFromWalk) opts.countsFromWalk = true;
  const fr = await ownSnapshot(frame, opts);
  await addChildren(frame, fr, opts, Date.now() + FRAME_TREE_MS);
  const lines: string[] = [];
  render(session, tab, frame, fr, fr.nodes, 0, frame.url(), lines, req.collect);
  let title = fr.title;
  if (frame !== tab.page.mainFrame()) title = await tab.page.title().catch(() => title);
  // P9: the header URL is Playwright's (the tab's main frame), never the engine's.
  return { header: snapshotHeader(tab.id, title, tab.page.url()), lines, omitted: omittedIn(fr), offscreen: offscreenIn(fr) };
}

/** Snapshot line text for a single described node (find hits, strict listings, evaluate results). */
export function nodeLine(session: Session, tab: Tab, frame: Frame, docId: string, n: SnapNode, depth = 0): string {
  // P9: a described node is engine output too (find hits, strict listings, evaluate results).
  const safe = safeNode(n) ?? { id: 0, role: safeRole(undefined) };
  const ref = issueRef(session, tab, frame, docId, safe);
  return elementLine(depth, safe.role, safe.name, ref, safe.attrs, frame.url());
}
