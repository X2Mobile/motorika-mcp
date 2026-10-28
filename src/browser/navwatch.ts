// Main-frame navigation watch (round 5, D1; round 7: document identity). Which navigation requests started,
// got a response or failed (Playwright's request events), and whether a NEW document committed.
//
// Round 7: a commit is never inferred from URLs. Round 6 matched the committed URL against the requested
// URLs plus "a response arrived", and redirects broke it: a 302 hop's response set the flag and its URL was in
// the set, so an old page's `history.replaceState(location.href)` counted as the commit (v1.mjs, v1b.mjs 6/6),
// as did a back to an entry with the current URL (v2.mjs) and a click on a link to the page's own URL (v4.mjs).
// Now a commit is the main frame's CDP `Page.frameNavigated` with a loaderId other than the document's at the
// start (Tab.trackDocuments). Same-document changes come as `Page.navigatedWithinDocument` and never commit; a
// redirect hop never commits, only the final document does; a bfcache restore commits with its own loaderId.
import type { Frame, Request, Response } from 'playwright-core';
import type { DocEvent, Tab } from './tabs.js';

/** A URL without its fragment. */
export function withoutFragment(u: string): string {
  const i = u.indexOf('#');
  return i < 0 ? u : u.slice(0, i);
}

export type NavOutcome = 'commit' | 'failed' | 'timeout';

/** The longest delay setTimeout honours. */
const MAX_TIMER_MS = 2_147_483_647;

export interface MainNavWatch {
  /** A main-frame navigation request started since the watch began. */
  readonly requested: boolean;
  /** One of them got a response: unless it fails, its commit is under way (a redirect hop's response too). */
  readonly responded: boolean;
  /** The latest of them failed (cancelled, aborted, refused) and nothing committed. */
  readonly failed: boolean;
  /** The failed request's error text (`net::ERR_…`), Chrome's, never page text. */
  readonly failure: string | undefined;
  /** A new main-frame document committed (another loaderId), or the same-document history step asked for. */
  readonly committed: boolean;
  /** The URL that commit landed on (the browser's). */
  readonly committedUrl: string | undefined;
  /** The commit restored a document from the back-forward cache (it is loaded already: no load events). */
  readonly restored: boolean;
  /** The latest main-frame navigation response (the committed one once committed), for the status. */
  readonly response: Response | undefined;
  /** Document identity is known for this tab (false: no commit can be seen, callers must not assume one). */
  readonly tracking: boolean;
  /** 'commit' or 'failed' as soon as either is known (at once if it already is), else 'timeout' after `ms`. */
  next(ms: number): Promise<NavOutcome>;
  dispose(): void;
}

export interface MainNavOptions {
  /**
   * A history step (back, forward). A step to a same-document entry has no new document: Chrome announces it as
   * `Page.frameStartedNavigating` with `historySameDocument`, and its arrival is the next
   * `Page.navigatedWithinDocument`. A page's own `replaceState` is never such a step (v2.mjs).
   */
  history?: boolean;
}

/**
 * Starts watching (after the tab's document tracking is up, so the starting loaderId is known). Start it
 * before the action, so nothing is missed.
 */
export async function watchMainNav(tab: Tab, opts: MainNavOptions = {}): Promise<MainNavWatch> {
  const tracking = await tab.trackDocuments();
  const page = tab.page;
  const startLoader = tab.mainLoaderId;
  const mine = new Set<Request>();
  let latest: Request | undefined;
  let requested = false;
  let responded = false;
  let failed = false;
  let failure: string | undefined;
  let committed = false;
  let committedUrl: string | undefined;
  let restored = false;
  let sameDocStep = false;
  let response: Response | undefined;
  const waiters = new Set<(o: NavOutcome) => void>();
  const wake = (o: NavOutcome) => {
    const ws = [...waiters];
    waiters.clear();
    for (const w of ws) w(o);
  };
  const commit = (url: string) => {
    if (committed) return;
    committed = true;
    committedUrl = url;
    failed = false;
    wake('commit');
  };
  const isMain = (f: Frame | null | undefined) => f !== null && f !== undefined && f === page.mainFrame();
  const onRequest = (r: Request) => {
    if (!r.isNavigationRequest() || !isMain(safeFrame(r))) return;
    mine.add(r);
    latest = r;
    requested = true;
    failed = false;
  };
  const onResponse = (r: Response) => {
    if (!mine.has(r.request())) return;
    responded = true;
    if (!committed) response = r;
  };
  const onFailed = (r: Request) => {
    if (!mine.has(r) || r !== latest || committed) return;
    failed = true;
    try {
      failure = r.failure()?.errorText;
    } catch {
      failure = undefined;
    }
    wake('failed');
  };
  const onDoc = (e: DocEvent) => {
    if (committed) return;
    if (e.kind === 'commit') {
      if (e.loaderId === startLoader) return;
      restored = e.restore;
      commit(e.url);
      return;
    }
    if (e.kind === 'start') {
      if (opts.history) sameDocStep = e.type === 'historySameDocument';
      return;
    }
    if (sameDocStep) commit(e.url);
  };
  const offDoc = tab.onDocument(onDoc);
  page.on('request', onRequest);
  page.on('response', onResponse);
  page.on('requestfailed', onFailed);
  return {
    get requested() {
      return requested;
    },
    get responded() {
      return responded;
    },
    get failed() {
      return failed;
    },
    get failure() {
      return failure;
    },
    get committed() {
      return committed;
    },
    get committedUrl() {
      return committedUrl;
    },
    get restored() {
      return restored;
    },
    get response() {
      return response;
    },
    tracking,
    next(ms: number): Promise<NavOutcome> {
      if (committed) return Promise.resolve('commit');
      if (failed) return Promise.resolve('failed');
      if (ms <= 0) return Promise.resolve('timeout');
      return new Promise<NavOutcome>((resolve) => {
        const done = (o: NavOutcome) => {
          clearTimeout(t);
          waiters.delete(done);
          resolve(o);
        };
        // setTimeout reads anything above 2^31-1 ms (Infinity included) as 1 ms.
        const t = setTimeout(() => done('timeout'), Math.min(ms, MAX_TIMER_MS));
        waiters.add(done);
      });
    },
    dispose() {
      offDoc();
      page.off('request', onRequest);
      page.off('response', onResponse);
      page.off('requestfailed', onFailed);
      wake('timeout');
    },
  };
}

/** `request.frame()` throws for a service-worker request; such a request is never the main frame's. */
function safeFrame(r: Request): Frame | undefined {
  try {
    return r.frame();
  } catch {
    return undefined;
  }
}
