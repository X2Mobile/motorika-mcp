// Global ref allocation: one counter per server process, shared by all tabs and frames, never reused.
// A ref is bound to exactly one element: (tab, frame label, document id, document-local id).
// Records keep the frame's label, not the Playwright Frame, so detached frames are not pinned in memory
// (review P1); `get` resolves the label to the live frame and treats a vanished frame as an old document.

export interface RefRecord<F = unknown> {
  ref: number;
  tabId: string;
  frame: F;
  frameLabel: string;
  docId: string;
  localId: number;
  role: string;
  name: string;
  /** role+name was unique in its document when the ref was issued. */
  unique: boolean;
}

export interface RefIssue<F> {
  tabId: string;
  frame: F;
  docId: string;
  localId: number;
  role: string;
  name: string;
  /** undefined = not computed by this issuer; an existing record keeps its stored value (review W2). */
  unique?: boolean | undefined;
}

interface Stored {
  ref: number;
  tabId: string;
  frameLabel: string;
  docId: string;
  localId: number;
  role: string;
  name: string;
  unique: boolean;
  issuedAt: number;
  /** Position in its document's recency queue (C3). */
  seq: number;
}

export interface FrameNaming<F> {
  label(tabId: string, frame: F): string;
  resolve(tabId: string, label: string): F | undefined;
}

/**
 * How many forgotten refs keep an informative "closed tab / earlier document" reason (and their tab).
 * Older ones still answer with the stale-ref error (round 4, D2).
 */
export const FORGOTTEN_CAP = 10000;
/** Live refs per document (re-check item 11); the least recently issued are evicted (stale-ref error). */
export const LIVE_PER_DOC_CAP = 20000;

/**
 * A map that keeps at most `cap` entries, evicting the oldest insert first in amortised O(1) (round 3,
 * C4): deleting from the head of a JS Map or Set leaves holes that every new iterator walks again.
 */
class Recent<V> {
  private readonly m = new Map<number, V>();
  private q: number[] = [];
  private head = 0;
  constructor(private readonly cap: number) {}
  set(k: number, v: V): void {
    if (!this.m.has(k)) this.q.push(k);
    this.m.set(k, v);
    while (this.m.size > this.cap && this.head < this.q.length) this.m.delete(this.q[this.head++] as number);
    if (this.head > 1024 && this.head * 2 > this.q.length) {
      this.q = this.q.slice(this.head);
      this.head = 0;
    }
  }
  get(k: number): V | undefined {
    return this.m.get(k);
  }
  values(): IterableIterator<V> {
    return this.m.values();
  }
  get size(): number {
    return this.m.size;
  }
}

/**
 * Live refs of one document in issue recency (round 3, C3/C4): a re-issued ref moves to the tail, the
 * least recently issued is evicted first. A queue with lazy deletion: an entry is current only while its
 * sequence number matches the record's; stale entries are skipped and compacted away.
 */
interface DocQueue {
  refs: number[];
  seqs: number[];
  head: number;
  live: number;
}

export type MissingReason = 'closed-tab' | 'old-doc' | 'stale' | 'previous-session' | 'unknown';

export class RefRegistry<F = unknown> {
  private next = 1;
  /** Refs at or below this number were issued by an earlier browser session (takeover). */
  private previousSessionFloor = 0;
  private readonly byRef = new Map<number, Stored>();
  private readonly byKey = new Map<string, number>();
  private readonly closedRefs = new Recent<string>(FORGOTTEN_CAP);
  private readonly oldDocRefs = new Recent<string>(FORGOTTEN_CAP);
  /** Evicted by the per-document cap or retired by the in-page sweep: the stale-ref error (C3). */
  private readonly staleRefs = new Recent<string>(FORGOTTEN_CAP);
  private seq = 0;
  /** PN2: live refs by `tabId|frameLabel`, so forgetting a frame or tab never walks every ref. */
  private readonly byFrame = new Map<string, Set<number>>();
  private readonly framesOfTab = new Map<string, Set<string>>();
  /** Live refs by document, in issue recency (item 11 cap; round 3 C3/C4). */
  private readonly byDoc = new Map<string, DocQueue>();
  private readonly naming: FrameNaming<F>;

  constructor(naming?: FrameNaming<F>) {
    this.naming = naming ?? {
      label: (_t, f) => String(f),
      resolve: (_t, l) => l as unknown as F,
    };
  }

  /** Return the existing ref for this element, or allocate a new one. */
  issue(i: RefIssue<F>): number {
    const key = `${i.docId}:${i.localId}`;
    const existing = this.byKey.get(key);
    if (existing !== undefined) {
      const rec = this.byRef.get(existing);
      if (rec && rec.tabId === i.tabId) {
        rec.role = i.role;
        rec.name = i.name;
        if (i.unique !== undefined) rec.unique = i.unique;
        this.touch(rec);
        return existing;
      }
    }
    const ref = this.next++;
    const frameLabel = this.naming.label(i.tabId, i.frame);
    const rec: Stored = {
      ref,
      tabId: i.tabId,
      frameLabel,
      docId: i.docId,
      localId: i.localId,
      role: i.role,
      name: i.name,
      unique: i.unique ?? false,
      issuedAt: Date.now(),
      seq: 0,
    };
    this.byRef.set(ref, rec);
    this.byKey.set(key, ref);
    const fk = `${i.tabId}|${frameLabel}`;
    let fs = this.byFrame.get(fk);
    if (!fs) {
      fs = new Set();
      this.byFrame.set(fk, fs);
      let tf = this.framesOfTab.get(i.tabId);
      if (!tf) {
        tf = new Set();
        this.framesOfTab.set(i.tabId, tf);
      }
      tf.add(fk);
    }
    fs.add(ref);
    let dq = this.byDoc.get(i.docId);
    if (!dq) {
      dq = { refs: [], seqs: [], head: 0, live: 0 };
      this.byDoc.set(i.docId, dq);
    }
    dq.live++;
    this.touch(rec);
    this.evict(dq);
    return ref;
  }

  /** Move a live ref to the tail of its document's queue (it was just issued or re-issued). */
  private touch(rec: Stored): void {
    const dq = this.byDoc.get(rec.docId);
    if (!dq) return;
    rec.seq = ++this.seq;
    dq.refs.push(rec.ref);
    dq.seqs.push(rec.seq);
    this.compact(dq);
  }

  /**
   * Keep a queue O(live): drop the consumed head once it is most of the array, and drop superseded
   * entries once they outnumber the live ones (every snapshot re-issues its refs). Amortised O(1).
   */
  private compact(dq: DocQueue): void {
    if (dq.head > 1024 && dq.head * 2 > dq.refs.length) {
      dq.refs = dq.refs.slice(dq.head);
      dq.seqs = dq.seqs.slice(dq.head);
      dq.head = 0;
    }
    if (dq.refs.length - dq.head > 2 * dq.live + 1024) {
      const refs: number[] = [];
      const seqs: number[] = [];
      for (let k = dq.head; k < dq.refs.length; k++) {
        const r = dq.refs[k] as number;
        const sq = dq.seqs[k] as number;
        if (this.byRef.get(r)?.seq === sq) {
          refs.push(r);
          seqs.push(sq);
        }
      }
      dq.refs = refs;
      dq.seqs = seqs;
      dq.head = 0;
    }
  }

  /** Past the cap, retire the least recently issued live refs of this document (stale-ref error). */
  private evict(dq: DocQueue): void {
    while (dq.live > LIVE_PER_DOC_CAP && dq.head < dq.refs.length) {
      const r = dq.refs[dq.head] as number;
      const sq = dq.seqs[dq.head] as number;
      dq.head++;
      const v = this.byRef.get(r);
      if (v && v.seq === sq) this.retire(r, v, this.staleRefs);
    }
    this.compact(dq);
  }

  /** The record with its live frame; undefined when unknown or its frame is gone (then: old document). */
  get(ref: number): RefRecord<F> | undefined {
    const s = this.byRef.get(ref);
    if (!s) return undefined;
    const frame = this.naming.resolve(s.tabId, s.frameLabel);
    if (frame === undefined) {
      this.retire(ref, s, this.oldDocRefs);
      return undefined;
    }
    const { issuedAt: _t, seq: _s, ...rest } = s;
    return { ...rest, frame };
  }

  private retire(ref: number, s: Stored, into: Recent<string>): void {
    this.byRef.delete(ref);
    const fk = `${s.tabId}|${s.frameLabel}`;
    const fs = this.byFrame.get(fk);
    if (fs) {
      fs.delete(ref);
      if (fs.size === 0) {
        this.byFrame.delete(fk);
        const tf = this.framesOfTab.get(s.tabId);
        tf?.delete(fk);
        if (tf && tf.size === 0) this.framesOfTab.delete(s.tabId);
      }
    }
    const dq = this.byDoc.get(s.docId);
    if (dq) {
      // Its queue entries are now superseded (no record matches their seq) and are skipped or compacted.
      dq.live--;
      if (dq.live <= 0) this.byDoc.delete(s.docId);
    }
    if (this.byKey.get(`${s.docId}:${s.localId}`) === ref) this.byKey.delete(`${s.docId}:${s.localId}`);
    into.set(ref, s.tabId);
  }

  isClosedTab(tabId: string): boolean {
    for (const t of this.closedRefs.values()) if (t === tabId) return true;
    return false;
  }

  /** Live refs of one frame (a copy: retiring while iterating is safe). */
  private frameRefs(tabId: string, frameLabel: string): number[] {
    return [...(this.byFrame.get(`${tabId}|${frameLabel}`) ?? [])];
  }

  private tabRefs(tabId: string): number[] {
    const out: number[] = [];
    for (const fk of this.framesOfTab.get(tabId) ?? []) out.push(...(this.byFrame.get(fk) ?? []));
    return out;
  }

  /** Drop refs of a closed tab; their numbers are never reused. */
  forgetTab(tabId: string): void {
    for (const ref of this.tabRefs(tabId)) {
      const s = this.byRef.get(ref);
      if (s) this.retire(ref, s, this.closedRefs);
    }
  }

  /** Drop refs of documents no longer current (kept for callers that know the live doc ids). */
  forgetDocs(tabId: string, keepDocIds: Set<string>): void {
    for (const ref of this.tabRefs(tabId)) {
      const s = this.byRef.get(ref);
      if (s && !keepDocIds.has(s.docId)) this.retire(ref, s, this.oldDocRefs);
    }
  }

  /** A frame detached: refs in it belong to a document that no longer exists. */
  forgetFrame(tabId: string, frameLabel: string): void {
    for (const ref of this.frameRefs(tabId, frameLabel)) {
      const s = this.byRef.get(ref);
      if (s) this.retire(ref, s, this.oldDocRefs);
    }
  }

  /** A new document committed in this frame at `before`: refs issued earlier belong to the old one. */
  forgetFrameBefore(tabId: string, frameLabel: string, before: number): void {
    for (const ref of this.frameRefs(tabId, frameLabel)) {
      const s = this.byRef.get(ref);
      if (s && s.issuedAt < before) this.retire(ref, s, this.oldDocRefs);
    }
  }

  /** Refs whose elements the in-page sweep found gone are retired with the stale-ref error (item 11). */
  retireLocals(docId: string, localIds: Iterable<number>): void {
    for (const id of localIds) {
      const ref = this.byKey.get(`${docId}:${id}`);
      const s = ref === undefined ? undefined : this.byRef.get(ref);
      if (ref !== undefined && s) this.retire(ref, s, this.staleRefs);
    }
  }

  /** After a takeover: continue above every ref number the previous session showed (review item 8). */
  continueAbove(highestSeen: number): void {
    if (!Number.isSafeInteger(highestSeen) || highestSeen > 1e9) return; // R-C3 sanity bound
    if (highestSeen > this.previousSessionFloor) this.previousSessionFloor = highestSeen;
    if (this.next <= highestSeen) this.next = highestSeen + 1;
  }

  /** Why a ref is unknown: closed tab, earlier document, a previous browser session, or never issued. */
  whyMissing(ref: number): { reason: MissingReason; tabId?: string } {
    const closed = this.closedRefs.get(ref);
    if (closed !== undefined) return { reason: 'closed-tab', tabId: closed };
    const old = this.oldDocRefs.get(ref);
    if (old !== undefined) return { reason: 'old-doc', tabId: old };
    const stale = this.staleRefs.get(ref);
    if (stale !== undefined) return { reason: 'stale', tabId: stale };
    // Round 4, D2: e0 was never issued by anyone (numbering starts at 1), so it is never a previous session's.
    if (ref >= 1 && ref <= this.previousSessionFloor && !this.byRef.has(ref)) return { reason: 'previous-session' };
    // Round 4, D2: the informative maps above forget after FORGOTTEN_CAP retirements; any other number
    // this process issued that is not live is stale. O(1), no growing memory; the tab is no longer known.
    if (Number.isSafeInteger(ref) && ref >= 1 && ref < this.next && !this.byRef.has(ref)) return { reason: 'stale' };
    return { reason: 'unknown' };
  }

  get issued(): number {
    return this.next - 1;
  }

  /** Live records (for memory checks). */
  get size(): number {
    return this.byRef.size;
  }

  get forgottenSize(): number {
    return this.closedRefs.size + this.oldDocRefs.size + this.staleRefs.size;
  }
}
