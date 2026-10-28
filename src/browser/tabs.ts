// Tab registry entries: ids, per-tab queue, buffers (console, network), pending dialog, events, frames.
import { mkdir, stat, writeFile } from 'node:fs/promises';
import type { CDPSession, ConsoleMessage, Dialog, Download, Frame, Page, Request } from 'playwright-core';
import { ARROW, LINE_BREAK, effect, jsonQuote } from '../util/format.js';
import { uniquePathIn } from '../util/paths.js';
import { safeUrl } from '../util/secrets.js';
import { guardLanding, type UrlPolicy } from '../util/urls.js';
import { log } from '../util/log.js';

/** Effect line ordering (the fixed order of the effect summary). */
export const RANK = {
  navigated: 1,
  url: 2,
  newTab: 3,
  tabClosed: 4,
  dialog: 5,
  download: 6,
  alert: 7,
  console: 8,
  notice: 0,
  blocked: 1,
} as const;

/** Round 7: a main-frame document event from CDP (see Tab.trackDocuments). */
export type DocEvent =
  | { kind: 'commit'; loaderId: string; url: string; restore: boolean }
  | { kind: 'same'; url: string }
  /** `Page.frameStartedNavigating`: `historySameDocument`, `historyDifferentDocument`, `differentDocument`, … */
  | { kind: 'start'; type: string; url: string };

export interface TabEvent {
  rank: number;
  line: string;
}

export interface ConsoleEntry {
  level: string;
  time: number;
  text: string;
  url?: string;
  line?: number;
}

export interface NetEntry {
  id: string;
  request: Request;
  method: string;
  url: string;
  type: string;
  start: number;
  end?: number;
  status?: number;
  failure?: string;
  size?: number;
}

/** Last screenshot mapping: image px -> CSS px. */
export interface ShotMap {
  /** image px per CSS px */
  ratio: number;
  /** CSS origin of the image (page coords when page=true, else viewport coords). */
  originX: number;
  originY: number;
  page: boolean;
}

export interface PendingDialog {
  dialog: Dialog;
  type: string;
  message: string;
  since: number;
}

export const CONSOLE_CAP = 500;
/** Each stored console message is clipped to this many chars, ending with … (review item 3). */
export const CONSOLE_MESSAGE_CAP = 4096;
export const NETWORK_CAP = 1000;
const SETTLE_TYPES = new Set(['document', 'fetch', 'xhr']);

export interface TabHooks {
  nextRequestId(): string;
  /** Directory downloads are saved into (<output-dir>/downloads). */
  downloadsDir: string;
  /** Called when a dialog must be auto-handled or becomes pending. */
  onDialogPending?(tab: Tab): void;
  /** URL policy for the file: landing guard and download sources (review item 1). */
  urlPolicy?: UrlPolicy;
  /** A new main-frame document reached DOMContentLoaded; it committed at `committedAt` (ms epoch). */
  onMainDocument?(tab: Tab, committedAt: number): void;
  /** A frame detached; its label is retired (refs in it can be forgotten). */
  onFrameDetached?(tab: Tab, label: string): void;
}

export function clipConsoleText(t: string): string {
  return t.length > CONSOLE_MESSAGE_CAP ? `${t.slice(0, CONSOLE_MESSAGE_CAP - 1)}\u2026` : t;
}

export class Tab {
  readonly id: string;
  readonly page: Page;
  owner: string;
  openerId: string | undefined;
  closed = false;
  crashed = false;
  /** The initial blank tab of a launch, never navigated: `tabs new` reuses it (contract Q10). */
  pristine = false;
  events: TabEvent[] = [];
  console: ConsoleEntry[] = [];
  /** Total error-level console entries ever seen (monotonic, survives buffer trimming). */
  errorCount = 0;
  network: NetEntry[] = [];
  readonly inflight = new Map<Request, { start: number; type: string }>();
  dialog: PendingDialog | undefined;
  /** >0 while our own navigate/tabs close runs (beforeunload is then auto-accepted). */
  ownNavigation = 0;
  lastShot: ShotMap | undefined;
  /** Bumped each time the landing guard sends a frame to about:blank (its own nav line is dropped). */
  guardBlanks = 0;
  /** Downloads in progress (saveAs promises). */
  readonly downloads = new Set<Promise<void>>();
  /** The last navigation request the origin lists refused (round 3, C8), for navigate's error. */
  private blockedNav: { url: string; reason: string; hint: string; at: number } | undefined;
  private readonly frameIds = new Map<Frame, string>();
  private readonly framesByLabel = new Map<string, Frame>();
  /** Commit time of the latest main-frame navigation (cross- or same-document). */
  private mainCommitAt = 0;
  private nextFrame = 1;
  private tail: Promise<unknown> = Promise.resolve();
  private dialogSignal: { promise: Promise<PendingDialog>; resolve: (d: PendingDialog) => void } | undefined;
  private cdpSession: Promise<CDPSession> | undefined;
  private readonly netById = new Map<Request, NetEntry>();

  constructor(id: string, page: Page, owner: string, private readonly hooks: TabHooks) {
    this.id = id;
    this.page = page;
    this.owner = owner;
    this.frameLabel(page.mainFrame());
    this.attach();
  }

  frameLabel(frame: Frame): string {
    let l = this.frameIds.get(frame);
    if (l === undefined) {
      l = `f${this.nextFrame++}`;
      this.frameIds.set(frame, l);
      this.framesByLabel.set(l, frame);
    }
    return l;
  }

  frameByLabel(label: string): Frame | undefined {
    const f = this.framesByLabel.get(label);
    return f && !f.isDetached() ? f : undefined;
  }

  /** Number of frames with a live label (bounded by the frames that exist; P1). */
  get frameCount(): number {
    return this.frameIds.size;
  }

  cdp(): Promise<CDPSession> {
    if (!this.cdpSession) {
      this.cdpSession = this.page.context().newCDPSession(this.page);
      this.cdpSession.catch(() => {
        this.cdpSession = undefined;
      });
    }
    return this.cdpSession;
  }

  /**
   * Round 7 (D1): the main frame's document identity, the CDP `loaderId` of its current document. A new
   * document commits as `Page.frameNavigated` (a bfcache restore too, with its own loaderId); a same-document
   * change (`pushState`, `replaceState`, a fragment) comes as `Page.navigatedWithinDocument` and keeps the
   * loaderId; a redirect hop never commits. Kept current from this tab's own CDP session once tracking starts.
   */
  mainLoaderId: string | undefined;
  private mainFrameId: string | undefined;
  private docTracking: Promise<boolean> | undefined;
  private readonly docListeners = new Set<(e: DocEvent) => void>();

  /** Starts tracking (once per tab). Resolves false when the CDP session cannot track (then nothing commits). */
  trackDocuments(): Promise<boolean> {
    this.docTracking ??= (async () => {
      const s = await this.cdp();
      s.on('Page.frameNavigated', (e: { frame: { id: string; parentId?: string; loaderId: string; url: string }; type?: string }) => {
        if (e.frame.parentId) return;
        this.mainFrameId = e.frame.id;
        this.mainLoaderId = e.frame.loaderId;
        this.emitDoc({ kind: 'commit', loaderId: e.frame.loaderId, url: e.frame.url, restore: e.type === 'BackForwardCacheRestore' });
      });
      s.on('Page.navigatedWithinDocument', (e: { frameId: string; url: string }) => {
        if (e.frameId !== this.mainFrameId) return;
        this.emitDoc({ kind: 'same', url: e.url });
      });
      s.on('Page.frameStartedNavigating', (e: { frameId: string; url: string; navigationType: string }) => {
        if (e.frameId !== this.mainFrameId) return;
        this.emitDoc({ kind: 'start', type: e.navigationType, url: e.url });
      });
      await s.send('Page.enable');
      const t = (await s.send('Page.getFrameTree')) as { frameTree: { frame: { id: string; loaderId: string } } };
      this.mainFrameId ??= t.frameTree.frame.id;
      this.mainLoaderId ??= t.frameTree.frame.loaderId;
      return true;
    })().catch((e: unknown) => {
      log.debug('document tracking unavailable', e);
      this.docTracking = undefined;
      return false;
    });
    return this.docTracking;
  }

  /** Subscribe to main-frame document events; returns the unsubscribe function. */
  onDocument(l: (e: DocEvent) => void): () => void {
    this.docListeners.add(l);
    return () => {
      this.docListeners.delete(l);
    };
  }

  private emitDoc(e: DocEvent): void {
    for (const l of [...this.docListeners]) l(e);
  }

  /** Serial per-tab queue: calls on one tab run in arrival order. */
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.catch(() => undefined);
    return run;
  }

  /** Per-call dialog waiters (dialogOpened with a signal); removed on abort, so nothing piles up. */
  private readonly dialogWaiters = new Set<(d: PendingDialog) => void>();

  /**
   * Resolves when a dialog is pending (immediately if one already is). With a signal, the waiter is
   * per call and is dropped when the signal aborts: the caller aborts once its race is over, so no
   * reaction stays attached to a promise that may never settle (review P6). Without a signal, the
   * shared promise is returned (kept for callers that have not moved to a signal yet).
   */
  dialogOpened(signal?: AbortSignal): Promise<PendingDialog> {
    if (this.dialog) return Promise.resolve(this.dialog);
    if (!this.dialogSignal) {
      let resolveShared: (d: PendingDialog) => void = () => undefined;
      const promise = new Promise<PendingDialog>((r) => {
        resolveShared = r;
      });
      const resolve = (d: PendingDialog) => {
        resolveShared(d);
        const ws = [...this.dialogWaiters];
        this.dialogWaiters.clear();
        for (const w of ws) w(d);
      };
      this.dialogSignal = { promise, resolve };
    }
    if (!signal) return this.dialogSignal.promise;
    return new Promise<PendingDialog>((resolve) => {
      if (signal.aborted) return;
      const off = () => {
        this.dialogWaiters.delete(waiter);
      };
      const waiter = (d: PendingDialog) => {
        signal.removeEventListener('abort', off);
        resolve(d);
      };
      this.dialogWaiters.add(waiter);
      signal.addEventListener('abort', off, { once: true });
    });
  }

  pushEvent(rank: number, line: string): void {
    this.events.push({ rank, line });
  }

  drainEvents(): TabEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  private attach(): void {
    const p = this.page;
    p.on('dialog', (d) => this.onDialog(d));
    p.on('console', (m) => this.onConsole(m));
    p.on('pageerror', (err) => {
      this.addConsole({ level: 'error', time: Date.now(), text: `Uncaught ${err.name ? `${err.name}: ` : ''}${err.message}` });
    });
    p.on('request', (r) => this.onRequest(r));
    p.on('response', (resp) => {
      const e = this.netById.get(resp.request());
      if (e) e.status = resp.status();
    });
    p.on('requestfinished', (r) => this.onRequestDone(r, undefined));
    p.on('requestfailed', (r) => {
      const failure = r.failure()?.errorText ?? 'failed';
      this.onRequestDone(r, failure);
      if (failure.includes('ERR_BLOCKED_BY_CLIENT') && r.isNavigationRequest()) this.onBlockedNavigation(r.url());
    });
    p.on('download', (d) => this.onDownload(d));
    p.on('framenavigated', (f) => {
      if (f === p.mainFrame()) {
        this.mainCommitAt = Date.now();
        if (f.url() !== 'about:blank') this.pristine = false;
      }
      this.guardLanding(f);
    });
    p.on('domcontentloaded', () => this.hooks.onMainDocument?.(this, this.mainCommitAt));
    p.on('framedetached', (f) => {
      const l = this.frameIds.get(f);
      if (l === undefined) return;
      this.frameIds.delete(f);
      if (this.framesByLabel.get(l) === f) this.framesByLabel.delete(l);
      this.hooks.onFrameDetached?.(this, l);
    });
    p.on('crash', () => {
      this.crashed = true;
      this.pushEvent(RANK.notice, `notice: tab ${this.id} crashed; close it with tabs close, or open a new tab with tabs new`);
    });
  }

  /**
   * Round 3 C8: the origin lists refuse a navigation request (a redirect hop included) inside Chrome, so
   * it never commits and the landing guard never sees it. Report it the same way.
   */
  private onBlockedNavigation(url: string): void {
    const policy = this.hooks.urlPolicy;
    if (!policy) return;
    const v = guardLanding(url, policy);
    if (v.ok) return;
    this.blockedNav = { url, reason: v.reason, hint: v.hint, at: Date.now() };
    this.pushEvent(RANK.blocked, `${ARROW}blocked ${safeUrl(url)} (${v.reason})`);
  }

  /** The navigation the origin lists refused at or after `since`, if any. */
  blockedNavSince(since: number): { url: string; reason: string; hint: string } | undefined {
    const b = this.blockedNav;
    return b && b.at >= since ? b : undefined;
  }

  /** A frame that landed on a disallowed file: URL (a click, a redirect, history) goes to about:blank. */
  private guardLanding(f: Frame): void {
    const policy = this.hooks.urlPolicy;
    if (!policy) return;
    const url = f.url();
    const v = guardLanding(url, policy);
    if (v.ok) return;
    this.pushEvent(RANK.blocked, `${ARROW}blocked ${safeUrl(url)} (${v.reason})`);
    if (f === this.page.mainFrame()) this.guardBlanks++;
    f.goto('about:blank').catch((e: unknown) => log.debug('file guard: about:blank failed', e));
  }

  private onDownload(d: Download): void {
    const policy = this.hooks.urlPolicy;
    const src = d.url();
    if (policy && /^file:/i.test(src)) {
      const v = guardLanding(src, policy);
      if (!v.ok) {
        d.cancel().catch(() => undefined);
        this.pushEvent(RANK.blocked, `${ARROW}blocked ${safeUrl(src)} (${v.reason})`);
        return;
      }
    }
    const dir = this.hooks.downloadsDir;
    // Round 3 C10: the name is page-controlled. Line separators never reach the file name (the saved path
    // is printed), and the failure line JSON-quotes it.
    const name = (d.suggestedFilename() || 'download').replace(new RegExp(LINE_BREAK.source, 'g'), '_');
    const job = (async () => {
      await mkdir(dir, { recursive: true });
      const target = uniquePathIn(dir, name);
      // Reserve the name immediately so concurrent downloads do not collide.
      await writeFile(target, '', { flag: 'wx' });
      await d.saveAs(target);
      const st = await stat(target);
      this.pushEvent(RANK.download, effect.download(target, st.size));
    })().catch((e: unknown) => {
      const why = (e instanceof Error ? e.message : String(e)).split(LINE_BREAK)[0] ?? '';
      this.pushEvent(RANK.download, `${ARROW}download failed: ${jsonQuote(d.suggestedFilename())} (${why})`);
    });
    this.downloads.add(job);
    void job.finally(() => this.downloads.delete(job));
  }

  private onDialog(d: Dialog): void {
    const type = d.type();
    const message = d.message();
    if (type === 'alert' || (type === 'beforeunload' && this.ownNavigation > 0)) {
      d.accept().catch((e: unknown) => log.debug('auto-accept failed', e));
      this.pushEvent(RANK.dialog, effect.dialogAccepted(type, message));
      return;
    }
    this.dialog = { dialog: d, type, message, since: Date.now() };
    const sig = this.dialogSignal;
    this.dialogSignal = undefined;
    sig?.resolve(this.dialog);
    this.hooks.onDialogPending?.(this);
  }

  private onConsole(m: ConsoleMessage): void {
    const t = m.type();
    const level = t === 'error' ? 'error' : t === 'warning' ? 'warning' : t;
    const loc = m.location();
    this.addConsole({
      level,
      time: Date.now(),
      text: m.text(),
      url: loc.url || undefined,
      line: loc.url ? loc.lineNumber + 1 : undefined,
    });
  }

  private addConsole(e: ConsoleEntry): void {
    e.text = clipConsoleText(e.text);
    if (e.level === 'error') this.errorCount++;
    this.console.push(e);
    if (this.console.length > CONSOLE_CAP) this.console.splice(0, this.console.length - CONSOLE_CAP);
  }

  /** Console errors after a given errorCount mark. */
  errorsSince(mark: number): ConsoleEntry[] {
    const n = this.errorCount - mark;
    if (n <= 0) return [];
    const errs = this.console.filter((c) => c.level === 'error');
    return errs.slice(Math.max(0, errs.length - n));
  }

  private onRequest(r: Request): void {
    const type = r.resourceType();
    const now = Date.now();
    const e: NetEntry = { id: this.hooks.nextRequestId(), request: r, method: r.method(), url: r.url(), type, start: now };
    this.netById.set(r, e);
    this.network.push(e);
    if (this.network.length > NETWORK_CAP) {
      const removed = this.network.splice(0, this.network.length - NETWORK_CAP);
      for (const x of removed) this.netById.delete(x.request);
    }
    if (SETTLE_TYPES.has(type)) this.inflight.set(r, { start: now, type });
  }

  private onRequestDone(r: Request, failure: string | undefined): void {
    this.inflight.delete(r);
    const e = this.netById.get(r);
    if (!e) return;
    e.end = Date.now();
    if (failure !== undefined) e.failure = failure;
    if (failure === undefined) {
      r.sizes()
        .then((s) => {
          e.size = s.responseBodySize;
        })
        .catch(() => undefined);
    }
  }

  entryByRequestId(id: string): NetEntry | undefined {
    return this.network.find((e) => e.id === id);
  }

  /** Requests (document/fetch/xhr) still in flight that started at or after `since`. */
  inflightSince(since: number): number {
    let n = 0;
    for (const v of this.inflight.values()) if (v.start >= since) n++;
    return n;
  }
}

export interface Client {
  id: string;
  active: string | undefined;
  /** Activation history, most recent last (for "previously active"). */
  history: string[];
  owned: Set<string>;
  /** Session-level notices for the top of this client's next result. */
  notices: string[];
}

export function newClient(id: string): Client {
  return { id, active: undefined, history: [], owned: new Set(), notices: [] };
}

export function activate(c: Client, tabId: string): void {
  c.active = tabId;
  c.history = c.history.filter((t) => t !== tabId);
  c.history.push(tabId);
}

/** Remove a tab from a client; if it was active, the previously active remaining tab becomes active. */
export function removeFromClient(c: Client, tabId: string): void {
  c.owned.delete(tabId);
  c.history = c.history.filter((t) => t !== tabId);
  if (c.active === tabId) {
    c.active = undefined;
    for (let i = c.history.length - 1; i >= 0; i--) {
      const t = c.history[i];
      if (t !== undefined && c.owned.has(t)) {
        c.active = t;
        break;
      }
    }
    if (c.active === undefined) {
      const first = [...c.owned][c.owned.size - 1];
      if (first !== undefined) c.active = first;
    }
  }
}
