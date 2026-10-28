import { z } from 'zod';
import type { Download, Frame, Page, Response } from 'playwright-core';
import { watchMainNav, type MainNavWatch } from '../browser/navwatch.js';
import type { Tab } from '../browser/tabs.js';
import { POST_SETTLE_RESERVE_MS } from '../page/effects.js';
import { ToolError, errorLog, escapeControls, isTimeout } from '../util/errors.js';
import { checkNavigation } from '../util/urls.js';
import { act, capMs, crashedError, crashedSoon, within } from './common.js';
import { defineTool, snapshotArg, tabArg, timeoutArg, type CallCtx, type ToolResult } from './types.js';
import { q, titleQ } from '../util/format.js';
import { safeUrl } from '../util/secrets.js';
import { log } from '../util/log.js';

/** Contract answer 13: scheme-less localhost, 127.0.0.1 and [::1] (optional port) get http://. */
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?([/?#]|$)/i;

export function normalizeUrl(raw: string): string {
  const u = raw.trim();
  if (LOCAL_HOST.test(u)) return `http://${u}`;
  if (/^[a-z][a-z0-9+.-]*:/i.test(u) && !/^[a-z0-9.-]+:\d+(\/|$)/i.test(u)) return u;
  if (u.startsWith('//')) return `https:${u}`;
  return `https://${u}`;
}

/** The URL policy and origin lists, checked before the browser is asked to load anything. */
export function assertNavigable(url: string, ctx: CallCtx): void {
  const v = checkNavigation(url, ctx.config);
  if (!v.ok) throw new ToolError(`navigation to ${escapeControls(url)} refused: ${v.reason}`, v.hint);
}

type WaitUntil = 'commit' | 'domcontentloaded' | 'load' | 'networkidle';

/** Cap on waiting for Chrome's error page after a network-level navigation failure. */
export const ERROR_PAGE_WAIT_MS = 2000;

/**
 * D10 root cause: a navigation that fails at the network level (DNS, TLS, refused) rejects in
 * Playwright before Chrome commits its chrome-error://chromewebdata/ page. That late commit then
 * interrupts the tab's next navigation ("is interrupted by another navigation to chrome-error://").
 * So the failing navigate does not return until its own error page has committed (capped, inside its own
 * budget), and the tab is idle for the next call. A retry of the interrupted goto does not work: the
 * interrupted navigation keeps running in Chrome and then interrupts the retry (measured 39/40).
 * ERR_ABORTED commits no error page and is not waited for.
 */
export interface ErrorPageWatch {
  /** Waits until this navigation's error page has committed in the main frame, at most `ms`. */
  settle(code: string, ms: number): Promise<void>;
  dispose(): void;
}

/** Start watching before the navigation, so an error page that commits early is not missed. */
export function watchErrorPage(page: Page): ErrorPageWatch {
  let committed = false;
  let wake: (() => void) | undefined;
  const on = (f: Frame) => {
    if (f === page.mainFrame() && f.url().startsWith('chrome-error:')) {
      committed = true;
      wake?.();
    }
  };
  page.on('framenavigated', on);
  return {
    async settle(code, ms) {
      // ERR_ABORTED (e.g. a 204 or a download) commits no error page.
      if (committed || code === 'net::ERR_ABORTED' || ms <= 0) return;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, Math.min(ERROR_PAGE_WAIT_MS, ms));
        wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
    },
    dispose: () => {
      page.off('framenavigated', on);
    },
  };
}

/**
 * Round 3 C1, round 5 D1: the wait for the commit ends this long before the call deadline, so a navigation
 * that has not committed can be stopped (STOP_ACK_MS), a commit that raced the stop or the request's
 * failure can still be seen (STOP_SETTLE_MS), and the URL the tab shows read before the dispatcher answers.
 */
export const NAV_STOP_MARGIN_MS = 300;
/** Round 5, D1: how long Page.stopLoading's answer is awaited. */
export const STOP_ACK_MS = 150;
/** Round 5, D1: after the stop, how long the request's failure (or a commit that raced the stop) is awaited. */
export const STOP_SETTLE_MS = 100;
/**
 * Round 5, D1: a navigation whose response arrived before the stop is committing (Chrome cannot cancel it);
 * its commit is awaited until this long before the call deadline, which leaves the title read and the answer.
 */
export const LATE_COMMIT_RESERVE_MS = 250;
/** Round 5, R6: how long a navigate that failed with ERR_ABORTED waits to learn whether the renderer crashed. */
export const CRASH_WAIT_MS = 4000;
/** Round 6: with less room than this for the commit (the queue ate the call deadline), navigate does not start. */
export const MIN_COMMIT_MS = 50;
/** Round 6 (item 5): how long a download's file name is awaited after Playwright reported the download. */
export const DOWNLOAD_NAME_MS = 1000;

/**
 * Stop a navigation that is still pending (Page.stopLoading, the stop button), so the tab cannot land on the
 * URL after the caller was told it did not (round 3, C1). Resolves true when Chrome answered, false when it
 * refused or did not answer within `ms`. Never rejects.
 */
async function stopLoading(tab: Tab, ms: number): Promise<boolean> {
  const stop = (async () => {
    const s = await tab.cdp();
    await s.send('Page.stopLoading');
    return true;
  })().catch((e: unknown) => {
    log.debug('Page.stopLoading failed', e);
    return false;
  });
  return within(stop, ms, false);
}

export type StopOutcome = 'committed' | 'stopped' | 'uncertain';

/**
 * Round 5, D1: the commit did not come within its time. Stop the navigation, then decide from what the
 * browser reports, never from the stop's answer alone (measured with Playwright 1.64.1 and Chrome 155):
 * - Chrome cannot cancel a navigation whose response has arrived. The stop then fails ("Not attached to an
 *   active page") or succeeds, and the commit lands 0-3 ms later, or once the old page's `pagehide`
 *   handlers have run. That commit is the navigation's success, not an error.
 * - A stopped request fails with net::ERR_ABORTED within a few ms: stopped before it committed.
 * - An answered stop with no response seen leaves nothing that could commit.
 * Anything else is 'uncertain', and the caller must not invite a retry.
 * `left` says how many ms remain before the call must answer; every wait here is capped by it.
 */
export async function stopBeforeCommit(nav: MainNavWatch, stop: () => Promise<boolean>, left: () => number): Promise<StopOutcome> {
  if (nav.committed) return 'committed';
  const settleMs = () => Math.min(STOP_SETTLE_MS, left() - STOP_GUARD_MS);
  const commitMs = () => left() - LATE_COMMIT_RESERVE_MS;
  let acked = await stop();
  // A refused stop with no response seen: one more try (with a response, the refusal means it is committing).
  if (!acked && !nav.responded && !nav.committed && !nav.failed) acked = await stop();
  let o = await nav.next(nav.responded ? commitMs() : settleMs());
  // A response event can trail the stop's answer: then the commit is under way after all.
  if (o === 'timeout' && nav.responded) o = await nav.next(commitMs());
  if (o === 'commit') return 'committed';
  if (o === 'failed') return 'stopped';
  return acked && !nav.responded ? 'stopped' : 'uncertain';
}
/** Room kept after the stop's settle wait for the error to reach the dispatcher. */
const STOP_GUARD_MS = 50;

/**
 * The page title, bounded by what remains of the call deadline (round 4, D1: a busy page stalls
 * `page.title()`, and an unbounded read pushed a committed navigation past the deadline).
 */
async function boundedTitle(ctx: CallCtx, page: Page, fallback: string): Promise<string> {
  const ms = Math.min(300, capMs(ctx, 300) - TITLE_GUARD_MS);
  if (ms <= 0) return fallback;
  let h: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<string>((r) => {
    h = setTimeout(() => r(fallback), ms);
  });
  try {
    return await Promise.race([page.title().catch(() => fallback), t]);
  } finally {
    clearTimeout(h);
  }
}
/** Room left after the title read for the result to reach the dispatcher. */
const TITLE_GUARD_MS = 50;

/** Round 5, D1: the note on a navigation that committed but did not reach `wait_until` in time. */
export function stillLoadingNote(waitUntil: WaitUntil, ms: number): string {
  return `(still loading: ${waitUntil} not reached in ${ms} ms)`;
}

/**
 * Round 5, D1 AC3: the hint of a navigation stopped before it committed. It never suggests
 * `wait_until=commit` (a navigation that commits is a success now, so that retry would only load it twice).
 */
export function stoppedHint(shows: string, queued: boolean): string {
  return queued
    ? `stopped before it committed; the tab still shows ${shows}; the call waited behind earlier calls on this tab, and retrying requests the page again`
    : `stopped before it committed; the tab still shows ${shows}; retrying requests the page again (a larger timeout_ms gives the server more time)`;
}

/** Round 5, D1 AC3: the hint when the stop was not confirmed (the navigation may still commit later). */
export const UNCONFIRMED_STOP_HINT = 'the navigation may still land; check the tab with snapshot before navigating again';

/** Round 6: how long reading the tab's history (Page.getNavigationHistory) may take. */
export const HISTORY_READ_MS = 1000;

interface HistoryEntry {
  id: number;
  url: string;
}

/**
 * Round 6 (D1 items 2 and 3): the history entry back or forward goes to, read from the browser before
 * navigating. `null`: there is none (a fact, so "no earlier history entry" is never a guess from a URL that
 * did not change). `undefined`: the history could not be read.
 */
async function historyEntry(tab: Tab, delta: -1 | 1, ms: number): Promise<HistoryEntry | null | undefined> {
  const read = (async () => {
    const s = await tab.cdp();
    const h = (await s.send('Page.getNavigationHistory')) as { currentIndex: number; entries: { id: number; url: string }[] };
    const e = h.entries[h.currentIndex + delta];
    return e ? { id: e.id, url: e.url } : null;
  })().catch((e: unknown) => {
    log.debug('Page.getNavigationHistory failed', e);
    return undefined;
  });
  return within(read, ms, undefined);
}

/**
 * Round 6 (D1 items 1 and 3): back and forward go to the entry read above with Page.navigateToHistoryEntry and
 * wait for this watch's commit. Playwright's goBack/goForward resolve on ANY navigation event of the main
 * frame, so an old page that keeps calling replaceState made them resolve at once: "no earlier history
 * entry", and the back navigation landed later (3 of 3). Timeouts and failures are thrown in Playwright's
 * shapes, for the same handling as a goto.
 */
async function historyGo(tab: Tab, nav: MainNavWatch, entry: HistoryEntry, ms: number): Promise<Response | null> {
  const s = await tab.cdp();
  await s.send('Page.navigateToHistoryEntry', { entryId: entry.id });
  const o = await nav.next(ms);
  if (o === 'commit') return nav.response ?? null;
  if (o === 'failed') throw new Error(nav.failure ?? 'net::ERR_FAILED');
  const t = new Error(`Timeout ${ms}ms exceeded.`);
  t.name = 'TimeoutError';
  throw t;
}

/**
 * Round 5, D1: two phases. Phase 1 waits for the commit only, capped by the call deadline minus room to stop
 * it. Phase 2 waits for `wait_until` in what remains; when that runs out the navigation is still reported as
 * a success, with `(still loading: …)`, because the tab is on the new document and an error would invite a
 * retry that loads the page twice. Only a navigation that never committed is an error, and it is stopped
 * first. back, forward and reload follow the same two phases.
 */
export async function navigateTo(
  ctx: CallCtx,
  action: 'goto' | 'back' | 'forward' | 'reload',
  url: string | undefined,
  waitUntil: WaitUntil,
  timeoutMs: number,
  snapshot: boolean | undefined,
): Promise<ToolResult> {
  const tab = ctx.tab;
  const page = tab.page;
  let response: Response | null = null;
  let target = '';
  let stillLoading: string | undefined;
  /** Round 6 (item 5): set when the URL started a download instead of a navigation. */
  let downloaded: { file: string | undefined } | undefined;
  let download: Download | undefined;
  const onDownload = (d: Download) => {
    download ??= d;
  };
  const run = async () => {
    if (action === 'goto') {
      if (!url) throw new ToolError('navigate goto needs a url', 'pass url');
      target = normalizeUrl(url);
      assertNavigable(target, ctx);
    }
    // Round 6 (D1 items 2, 3): back/forward know their entry before they navigate, or that there is none.
    const history = action === 'back' || action === 'forward';
    const entry = history ? await historyEntry(tab, action === 'back' ? -1 : 1, capMs(ctx, HISTORY_READ_MS)) : undefined;
    if (entry === null) throw new ToolError(`no ${action === 'back' ? 'earlier' : 'later'} history entry`, 'use navigate url=… instead');
    if (entry) target = entry.url;
    const url0 = page.url();
    const t0 = Date.now();
    // C1: capped by what remains of the call deadline, like every other tool, minus room to stop it.
    const room = capMs(ctx, Number.POSITIVE_INFINITY) - NAV_STOP_MARGIN_MS;
    if (room < MIN_COMMIT_MS) {
      // Round 6 (d1q.mjs, the queue left 0-70 ms): a navigation started now could only be stopped again, and
      // a fast page commits before the stop lands ("the stop was not confirmed", and it landed: 1 of 26).
      // Nothing is requested, so the tab stays where it is and asking again is clean.
      const shows = escapeControls(safeUrl(page.url()));
      throw new ToolError(
        `navigation ${history ? `${action} ` : ''}to ${escapeControls(safeUrl(target || page.url()))} not started: the call waited behind earlier calls on this tab until no time was left; the tab shows ${shows}`,
        'nothing was requested; navigate again when the tab is idle, or with a larger timeout_ms',
      );
    }
    const commitMs = Math.max(1, Math.min(timeoutMs, room));
    const capped = commitMs < timeoutMs;
    const o = { waitUntil: 'commit' as const, timeout: commitMs };
    const errorPage = watchErrorPage(page);
    // Started before the navigation, so a commit or a failure that races the timeout is not missed. Round 7:
    // only a new document (another CDP loaderId) is a commit; a history step to a same-document entry counts
    // when it arrives without a navigation request.
    const nav = await watchMainNav(tab, { history });
    page.on('download', onDownload);
    // Round 6 (item 2): which navigation, named in every error: back and forward name their entry too.
    const verb = action === 'back' ? 'back ' : action === 'forward' ? 'forward ' : '';
    try {
      try {
        if (action === 'goto') {
          response = await page.goto(target, o);
        } else if (history && entry) {
          response = await historyGo(tab, nav, entry, commitMs);
        } else if (history) {
          // The history could not be read: Playwright's own history navigation, with its old check.
          const before = page.url();
          response = action === 'back' ? await page.goBack(o) : await page.goForward(o);
          if (!response && page.url() === before) {
            throw new ToolError(
              `${action} did not move the tab; it may still be in progress, the tab now shows ${escapeControls(safeUrl(page.url()))}`,
              'check the tab with snapshot before navigating again',
            );
          }
        } else {
          response = await page.reload(o);
        }
      } catch (e) {
        if (e instanceof ToolError) throw e;
        if (tab.crashed) throw crashedError(tab);
        // Round 6 (item 5): Playwright's answer when Page.navigate reports a download (browser side, not page
        // text). The tab stays where it was; the download is saved like any other (→ download …).
        if (/\bDownload is starting\b/.test(errorLog(e))) {
          if (!download) await within(new Promise<void>((r) => page.once('download', () => r())), capMs(ctx, DOWNLOAD_NAME_MS), undefined);
          downloaded = { file: download?.suggestedFilename() };
          return;
        }
        const net = /net::ERR_[A-Z_0-9]+/.exec(errorLog(e));
        // Round 6 (item 9): the caller's URL is echoed escaped, so a separator in it cannot start a line.
        const where = `${verb}to ${escapeControls(safeUrl(target || page.url()))}`;
        if (net) {
          // Round 5, R6: a renderer that crashed on the navigation answers ERR_ABORTED before its crash shows.
          if (net[0] === 'net::ERR_ABORTED' && (await crashedSoon(tab, capMs(ctx, CRASH_WAIT_MS)))) throw crashedError(tab);
          await errorPage.settle(net[0], Math.min(timeoutMs - (Date.now() - t0), capMs(ctx, timeoutMs)));
          const hop = net[0] === 'net::ERR_BLOCKED_BY_CLIENT' ? tab.blockedNavSince(t0) : undefined;
          if (hop) {
            // C8: a redirect hop into a listed host is refused before any request leaves Chrome.
            throw new ToolError(`navigation ${where} refused: it redirected to ${escapeControls(safeUrl(hop.url))} (${hop.reason})`, hop.hint);
          }
          // Round 6: the old page may have navigated itself meanwhile (an interrupted navigation): say where the tab is.
          const moved = page.url() !== url0 ? `; the tab shows ${escapeControls(safeUrl(page.url()))}` : '';
          throw new ToolError(`navigation ${where} failed: ${net[0]}${moved}`, 'check the URL, the network, or that the server is running');
        }
        if (!isTimeout(e)) throw e;
        // Phase 1 ran out before the commit. C1: never leave the navigation running after an error answer.
        const outcome = await stopBeforeCommit(
          nav,
          () => stopLoading(tab, capMs(ctx, STOP_ACK_MS)),
          () => capMs(ctx, Number.POSITIVE_INFINITY),
        );
        if (tab.crashed) throw crashedError(tab);
        if (outcome !== 'committed') {
          // Round 4, D1 AC4: the timeout that applied, and why it is shorter than timeout_ms.
          const why = capped ? `; timeout_ms ${timeoutMs} capped by the call deadline` : '';
          const shows = escapeControls(safeUrl(page.url()));
          const head = `navigation ${where} timed out after ${commitMs}ms before it committed (wait_until=${waitUntil}${why})`;
          if (outcome === 'stopped') throw new ToolError(`${head}; stopped, the tab shows ${shows}`, stoppedHint(shows, capped));
          throw new ToolError(`${head}; the stop was not confirmed, the tab shows ${shows}`, UNCONFIRMED_STOP_HINT);
        }
        // The commit raced the stop: a navigation, with what is known of its response.
        response = nav.response ?? null;
      }
      // Phase 2: the requested load state, in what remains of timeout_ms and of the call deadline. A document
      // restored from the back-forward cache is loaded already and fires no load events again (round 7).
      if (waitUntil !== 'commit' && !nav.restored) {
        const loadMs = Math.min(timeoutMs - (Date.now() - t0), capMs(ctx, Number.POSITIVE_INFINITY) - POST_SETTLE_RESERVE_MS);
        try {
          await page.waitForLoadState(waitUntil, { timeout: Math.max(1, loadMs) });
        } catch (e) {
          if (tab.crashed) throw crashedError(tab);
          if (!isTimeout(e)) throw e;
          stillLoading = stillLoadingNote(waitUntil, Date.now() - t0);
        }
      }
    } finally {
      errorPage.dispose();
      nav.dispose();
      page.off('download', onDownload);
    }
  };
  let title = '';
  return act(
    ctx,
    () => {
      if (downloaded) {
        const name = downloaded.file === undefined ? '' : `: ${q(downloaded.file, 200)}`;
        return `[${tab.id}] ${escapeControls(safeUrl(target || page.url()))} started a download${name}`;
      }
      const r = response as Response | null;
      const status = r ? ` (${r.status()})` : '';
      return `[${tab.id}] navigated ${safeUrl(page.url())} ${titleQ(title)}${status}`;
    },
    async () => {
      await run();
      title = await boundedTitle(ctx, page, '');
    },
    {
      ownNavigation: true,
      noNavLine: true,
      snapshot,
      autoSnapshot: true,
      budgetMs: timeoutMs,
      stillLoading: () => stillLoading,
      // Round 6 (item 5): the tab did not move; no snapshot of the old page unless one was asked for.
      skipAutoSnapshot: () => downloaded !== undefined,
    },
  ).then(async (res) => {
    // Title may have changed during settle; refresh the header line.
    const fresh = await boundedTitle(ctx, page, title);
    if (titleQ(fresh) !== titleQ(title)) {
      const c = res.content[0];
      if (c && c.type === 'text') {
        const nl = c.text.indexOf('\n');
        const head = nl < 0 ? c.text : c.text.slice(0, nl);
        const fixed = head.replace(titleQ(title), () => titleQ(fresh));
        res.content[0] = { type: 'text', text: nl < 0 ? fixed : fixed + c.text.slice(nl) };
      }
    }
    return res;
  });
}

export const navigate = defineTool({
  name: 'navigate',
  description:
    'Go to a URL (scheme-less gets https://), or back/forward/reload. Returns "[tN] navigated <url> "<title>" (<status>)" and a viewport snapshot (call snapshot for the whole page; snapshot:false to skip, snapshot:true attaches the whole page). HTTP error statuses are reported, network failures are errors with the net::ERR code. A page that loaded (committed) but did not reach wait_until within timeout_ms is not an error: the result adds "(still loading: …)"; only a navigation that never committed is an error, and it is stopped.',
  shape: {
    url: z.string().optional().describe('URL to open (action goto)'),
    action: z.enum(['goto', 'back', 'forward', 'reload']).optional().describe('Default goto (or reload when no url)'),
    tab: tabArg,
    wait_until: z.enum(['commit', 'domcontentloaded', 'load', 'networkidle']).optional().describe('Default domcontentloaded, then settle'),
    snapshot: snapshotArg,
    timeout_ms: timeoutArg,
  },
  annotations: { openWorldHint: true },
  scope: 'tab',
  handlesDialog: true,
  timeoutMs: (a, c) => a.timeout_ms ?? c.navigationTimeout,
  async handler(a, ctx) {
    const action = a.action ?? (a.url ? 'goto' : 'reload');
    if (action === 'goto' && !a.url) throw new ToolError('navigate needs a url for action goto', 'pass url, or action back|forward|reload');
    return navigateTo(ctx, action, a.url, a.wait_until ?? 'domcontentloaded', a.timeout_ms ?? ctx.config.navigationTimeout, a.snapshot);
  },
});
