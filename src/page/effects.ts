// Action wrapper: dialog race, settle (navigation, network, DOM quiet), effect summary, optional snapshot.
import type { Request, Response } from 'playwright-core';
import { watchMainNav, type MainNavWatch } from '../browser/navwatch.js';
import type { Session } from '../browser/session.js';
import { RANK, type Tab, type TabEvent } from '../browser/tabs.js';
import { ToolError, isNavigationContextError } from '../util/errors.js';
import { ATTACHED_SNAPSHOT_MAX_CHARS, OUTPUT_RESERVE, effect, pageLines, viewportFooter } from '../util/format.js';
import { log } from '../util/log.js';
import { call } from './engine.js';
import { buildSnapshot, lineLimit } from './snapshot.js';

export const SETTLE = {
  navWindowMs: 250,
  networkCapMs: 1500,
  quietMs: 100,
  quietCapMs: 600,
} as const;

export interface ActionResult {
  text: string;
  dialogPending: boolean;
}

export interface ActionOptions {
  /** true: attach the full-page snapshot; false: none; unset: the automatic one on a new document. */
  snapshot?: boolean;
  /** Attach the automatic snapshot even without a new document (navigate, tabs new: same-document hops). */
  autoSnapshot?: boolean;
  /** Our own navigation (beforeunload auto-accept). */
  ownNavigation?: boolean;
  /** Force reporting the main-frame navigation line (navigate back/forward/reload). */
  alwaysReportNav?: boolean;
  /** The header already reports the navigation (navigate tool). */
  noNavLine?: boolean;
  /** Skip the pre-action page evaluation (dialog tool: JS is blocked while the dialog is open). */
  noBaseline?: boolean;
  maxChars: number;
  navigationTimeout: number;
  actionTimeout: number;
  /** The call's own timeout; settle stops by start + budget + SETTLE_SLACK_MS so the call answers in time. */
  budgetMs?: number;
  /**
   * The dispatcher's answer time for this call (round 4, D1). Settle, the trailing page reads and the
   * attached snapshot all end before it, so the call answers with its effects instead of a bare timeout.
   */
  deadlineAt?: number;
  /**
   * Round 5, D1: read once the action is done. A note means the action already waited for its page to load
   * and it did not finish (navigate's `(still loading: …)`): settle is skipped (it would only wait for the
   * same load again) and the note ends the summary.
   */
  stillLoading?: () => string | undefined;
  /** Round 6: read once the action is done; true drops the automatic snapshot (navigate that downloaded). */
  skipAutoSnapshot?: () => boolean;
  /**
   * Round 6 (d1v.mjs click:#go busy=3700): Playwright's click can report its timeout after it dispatched the
   * click (a tiny capped timeout). When such a timeout comes with a main-frame navigation this action started,
   * the action ran: it is reported with its effects, never as an error that invites a second click.
   */
  timeoutAfterNavRan?: boolean;
}

/** Settle may run this long past the call's timeout (the dispatcher answers by timeout + 1.9 s). */
export const SETTLE_SLACK_MS = 700;
/**
 * Round 4, D1: settle ends this long before the call deadline, which leaves the trailing reads (title,
 * live regions, the attached snapshot) room to finish before the dispatcher answers.
 */
export const POST_SETTLE_RESERVE_MS = 600;
/** Round 4, D1: every read after settle ends this long before the call deadline. */
export const DEADLINE_GUARD_MS = 100;
/** Round 4, D1: printed when the call deadline cut settle short after the action itself succeeded. */
export const SETTLE_INCOMPLETE_NOTE =
  '(settle incomplete: the call deadline came first, the page may still be loading; check it with snapshot or wait)';

/** Round 4, D5: a live-region text that only repeats the page title (an SPA route announcer). */
export function isTitleAnnouncement(text: string, title: string): boolean {
  const n = (s: string) => s.replace(/\s+/g, ' ').trim();
  const t = n(title);
  return t !== '' && n(text) === t;
}

/**
 * Round 5, D5 nit: which fresh live-region texts to report. A text equal to the document title is a route
 * announcer's (new Reddit's assertive `faceplate-screen-reader-content`) and is skipped, unless a visible
 * `role=alert` element holds that text: a real alert is reported even when it repeats the title.
 * `alertTexts` is read only when some text equals the title.
 */
export async function liveAlerts(fresh: string[], title: string, alertTexts: () => Promise<string[]>): Promise<string[]> {
  if (!fresh.some((t) => isTitleAnnouncement(t, title))) return fresh;
  const alerts = await alertTexts();
  return fresh.filter((t) => !isTitleAnnouncement(t, title) || alerts.some((a) => isTitleAnnouncement(a, t)));
}

/**
 * Round 5 (click nit): when the deadline cut settle short, a navigation the action started usually commits
 * within ms. Its commit is awaited until this long before the call deadline, inside the time the trailing
 * reads keep in reserve (each of them ends DEADLINE_GUARD_MS before the deadline anyway), so the summary can
 * report `→ navigated`. Measured (d1v.mjs click:#go, a page served after 100 ms): 250 ms missed the commit
 * when the click started 330 ms before the deadline; 150 ms catches it.
 */
export const LATE_NAV_RESERVE_MS = 150;
/**
 * Round 6 (item 4): settle that ends with less than this left before the call deadline is followed by the same
 * wait for a late commit, even when the deadline did not cut it. Far from the deadline (an unqueued call)
 * settle's own waits cover a navigation, and nothing is added.
 */
export const NEAR_DEADLINE_MS = 1000;
/** Round 6: how long a timed-out click waits for the navigation request it may have started. */
export const TIMEOUT_NAV_GRACE_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** A timer for Promise.race whose handle is cleared once the race is over (no timers left behind). */
function timer(ms: number): { done: Promise<void>; cancel: () => void } {
  let h: ReturnType<typeof setTimeout> | undefined;
  const done = new Promise<void>((r) => {
    h = setTimeout(r, Math.max(0, ms));
  });
  return { done, cancel: () => clearTimeout(h) };
}

/** Race p against a timeout and clear the timer either way. */
async function within<T, F>(p: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  p.catch(() => undefined);
  const t = timer(ms);
  try {
    return await Promise.race([p, t.done.then(() => fallback)]);
  } finally {
    t.cancel();
  }
}

/** A page read that must not hold up the result (pages mid-navigation can stall evaluation). */
async function quick<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return within(p.catch(() => fallback), ms, fallback);
}

/**
 * Round 5 (click nit): settle was cut by the call deadline. A navigation the action started shows its request
 * within the nav window and commits within ms; wait for that commit until `until` (see LATE_NAV_RESERVE_MS).
 */
async function lateCommit(nav: MainNavWatch, tab: Tab, actionEnd: number, until: number): Promise<void> {
  while (!nav.requested && Date.now() < Math.min(until, actionEnd + SETTLE.navWindowMs) && !tab.closed && !tab.dialog) await sleep(15);
  if (nav.requested && !nav.committed && !nav.failed) await nav.next(until - Date.now());
}

async function waitNetwork(tab: Tab, since: number, capMs: number): Promise<void> {
  if (capMs <= 0) return;
  const end = Date.now() + capMs;
  while (tab.inflightSince(since) > 0 && Date.now() < end && !tab.closed && !tab.dialog) await sleep(15);
}

interface Quiet {
  kind: 'ok' | 'nav';
  /** Live-region texts read when quiet finished (undefined when the page could not answer). */
  live?: string[];
}

/** P9: live-region texts from the engine: strings only. */
function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

async function waitQuiet(tab: Tab, capMs: number, actionStart: number): Promise<Quiet> {
  if (capMs < SETTLE.quietMs) return { kind: 'ok' };
  // A main frame with a pending navigation can stall evaluation: bound the call itself as well.
  const q = call(tab.page.mainFrame(), 'quiet', SETTLE.quietMs, capMs, Date.now() - actionStart).then(
    (r): Quiet => ({ kind: 'ok', live: strings(r.value?.live) }),
    (e: unknown): Quiet => ({ kind: isNavigationContextError(e) ? 'nav' : 'ok' }),
  );
  return within(q, capMs + 150, { kind: 'ok' } as Quiet);
}

/**
 * Run an action on a tab and return the effect summary. The header line is computed after the action
 * (it may carry a re-resolution note).
 */
export async function runAction(
  session: Session,
  tab: Tab,
  header: string | (() => string),
  action: () => Promise<unknown>,
  opts: ActionOptions,
): Promise<ActionResult> {
  const page = tab.page;
  const main = page.mainFrame();
  const url0 = page.url();
  const errMark = tab.errorCount;
  const deadlineAt = opts.deadlineAt ?? Number.POSITIVE_INFINITY;
  /** What remains for a page read before the call deadline (round 4, D1). */
  const readLeft = (cap: number) => Math.max(0, Math.min(cap, deadlineAt - DEADLINE_GUARD_MS - Date.now()));
  let live0: string[] = [];
  if (!opts.noBaseline) live0 = await quick(call(main, 'liveTexts').then((r) => strings(r.value)), readLeft(500), [] as string[]);
  let navStartedAt: number | undefined;
  let newDoc = false;
  let navStatus: number | undefined;
  const onReq = (r: Request) => {
    if (r.isNavigationRequest() && r.frame() === main) navStartedAt = Date.now();
  };
  const onResp = (r: Response) => {
    if (r.request().isNavigationRequest() && r.frame() === main) navStatus = r.status();
  };
  const onDcl = () => {
    newDoc = true;
  };
  page.on('request', onReq);
  page.on('response', onResp);
  page.on('domcontentloaded', onDcl);
  // Round 5 (click nit): did a navigation this action started commit a new document?
  const nav = await watchMainNav(tab);
  let loadingNote: string | undefined;
  session.actionTabs.push(tab.id);
  if (opts.ownNavigation) tab.ownNavigation++;
  const start = Date.now();
  const nominalEnd = start + (opts.budgetMs ?? opts.actionTimeout) + SETTLE_SLACK_MS;
  // Round 4, D1: never past the call deadline (a queued call may have little of it left).
  const settleEnd = Math.min(nominalEnd, deadlineAt - POST_SETTLE_RESERVE_MS);
  const left = () => Math.max(0, settleEnd - Date.now());
  let settleCut = false;
  let dialogPending = false;
  let lastQuiet: Quiet | undefined;
  // A per-action dialog waiter, dropped when the action is over (no reactions pile up on the tab).
  const dialogAbort = new AbortController();
  try {
    const act = action();
    act.catch(() => undefined);
    const dialogP = tab.dialogOpened(dialogAbort.signal);
    const ran = opts.timeoutAfterNavRan
      ? act.catch(async (e: unknown) => {
          if (!(e instanceof ToolError) || !/\btimed out\b/.test(e.cause1)) throw e;
          // The navigation request of a click dispatched at the very end can trail the timeout by a few ms.
          const until = Date.now() + Math.min(TIMEOUT_NAV_GRACE_MS, readLeft(TIMEOUT_NAV_GRACE_MS));
          while (!nav.requested && Date.now() < until) await sleep(10);
          if (!nav.requested) throw e;
          log.debug('action timed out after it started a navigation: reported as done');
        })
      : act;
    const first = await Promise.race([ran.then(() => 'done' as const), dialogP.then(() => 'dialog' as const)]);
    log.debug(`action ${first} after ${Date.now() - start}ms`);
    if (first === 'dialog') {
      dialogPending = true;
      // Multi-step actions stop at the dialog themselves; give them a moment to record where.
      await within(act.catch(() => undefined), 100, undefined);
    } else {
      const actionEnd = Date.now();
      loadingNote = opts.stillLoading?.();
      const settle = async () => {
        let handledNav = false;
        for (let round = 0; round < 3; round++) {
          if (navStartedAt !== undefined && !handledNav) {
            handledNav = true;
            const t = Math.min(opts.navigationTimeout, left());
            if (t > 0) await page.waitForLoadState('domcontentloaded', { timeout: t }).catch(() => undefined);
          }
          await waitNetwork(tab, start, Math.min(SETTLE.networkCapMs, left()));
          if (tab.closed || tab.dialog) return;
          const q = await waitQuiet(tab, Math.min(SETTLE.quietCapMs, left()), start);
          lastQuiet = q;
          if (tab.closed || tab.dialog) return;
          const navLate = navStartedAt !== undefined && !handledNav && navStartedAt <= actionEnd + SETTLE.navWindowMs;
          if ((q.kind === 'nav' || navLate) && left() > 0) {
            if (navStartedAt === undefined) navStartedAt = Date.now();
            handledNav = false;
            continue;
          }
          // Requests the action started can surface only after the first network check (their
          // 'request' event lags the click): wait for them once more, inside the 1.5 s network cap.
          const netLeft = Math.min(start + SETTLE.networkCapMs - Date.now(), left());
          if (tab.inflightSince(start) > 0 && netLeft > 0) {
            await waitNetwork(tab, start, netLeft);
            if (tab.closed || tab.dialog) return;
            lastQuiet = await waitQuiet(tab, Math.min(SETTLE.quietCapMs, left()), start);
          }
          return;
        }
      };
      if (loadingNote === undefined) {
        // Round 4, D1: settle itself is raced against its end too (a stalled evaluation cannot hold it).
        const settleTimer = timer(left());
        const s = await Promise.race([
          settle().then(() => 'settled' as const),
          dialogP.then(() => 'dialog' as const),
          settleTimer.done.then(() => 'cut' as const),
        ]).finally(() => settleTimer.cancel());
        if (s === 'dialog') dialogPending = true;
        // The deadline, not settle's own caps, ended it: say so (an incomplete settle is not an error).
        else if (settleEnd < nominalEnd && left() <= 0) settleCut = true;
        log.debug(`settle ${s} after ${Date.now() - start}ms (nav=${navStartedAt !== undefined} newDoc=${newDoc})`);
        // Round 6 (item 4): also when settle finished on its own close to the deadline: a navigation whose
        // request came after settle's quiet check (busy 3200-3275 ms of a 3.9 s deadline) commits ~100 ms later.
        if (settleCut || deadlineAt - Date.now() < NEAR_DEADLINE_MS) await lateCommit(nav, tab, actionEnd, deadlineAt - LATE_NAV_RESERVE_MS);
      }
      // Downloads and popups started by this action.
      if (tab.downloads.size > 0) {
        await within(Promise.allSettled([...tab.downloads]), Math.min(opts.actionTimeout, left()), undefined);
      }
      await session.waitPopups(Math.min(1500, readLeft(1500)));
    }
  } finally {
    dialogAbort.abort();
    page.off('request', onReq);
    page.off('response', onResp);
    page.off('domcontentloaded', onDcl);
    nav.dispose();
    const i = session.actionTabs.lastIndexOf(tab.id);
    if (i >= 0) session.actionTabs.splice(i, 1);
    if (opts.ownNavigation) tab.ownNavigation--;
  }

  const lines: TabEvent[] = [];
  if (tab.closed) {
    lines.push({ rank: RANK.tabClosed, line: effect.tabClosed(tab.id) });
  } else if (!dialogPending && !opts.noNavLine) {
    // Read now, after any wait for a late commit (round 5, click nit).
    const url1 = page.url();
    // Round 5 (click nit): a committed new document is a navigation even before its DOMContentLoaded.
    if (newDoc || nav.committed || (opts.alwaysReportNav && navStartedAt !== undefined)) {
      const title = await quick(page.title(), readLeft(300), '');
      lines.push({ rank: RANK.navigated, line: effect.navigated(url1, title, navStatus) });
    } else if (url1 !== url0) {
      lines.push({ rank: RANK.url, line: effect.url(url1) });
    }
  }
  lines.push(...tab.drainEvents());
  if (dialogPending && tab.dialog) lines.push({ rank: RANK.dialog, line: effect.dialogPending(tab.dialog.type, tab.dialog.message) });
  if (!dialogPending && !tab.closed) {
    // The last quiet read the live regions when it finished; only an extra read if it could not.
    const live1: string[] = lastQuiet?.live ?? (await quick(call(main, 'liveTexts').then((r) => strings(r.value)), readLeft(300), [] as string[]));
    const fresh = live1.filter((t) => !live0.includes(t));
    if (fresh.length > 0) {
      // Round 4, D5: an SPA route announcer (new Reddit's assertive faceplate-screen-reader-content) sets
      // a live region to the new document title; that is not news, so it is not reported. Round 5: a real
      // role=alert is, even with the title's text (read in Playwright's utility world, not the page's).
      const docTitle = await quick(page.title(), readLeft(300), '');
      const alertTexts = () => quick(main.locator('[role=alert]').visible().allInnerTexts(), readLeft(300), [] as string[]);
      for (const t of await liveAlerts(fresh, docTitle, alertTexts)) lines.push({ rank: RANK.alert, line: effect.alert(t) });
    }
  }
  const errs = tab.errorsSince(errMark);
  if (errs.length > 0) lines.push({ rank: RANK.console, line: effect.console(errs.length, errs[0]?.text ?? '') });
  lines.sort((a, b) => a.rank - b.rank);

  log.debug(`effects computed after ${Date.now() - start}ms`);
  let text = [typeof header === 'function' ? header() : header, ...lines.map((l) => l.line)].join('\n');
  if (settleCut) text += `\n${SETTLE_INCOMPLETE_NOTE}`;
  if (loadingNote !== undefined) text += `\n${loadingNote}`;
  const fullPage = opts.snapshot === true;
  const wantSnapshot = fullPage || ((newDoc || opts.autoSnapshot === true) && opts.snapshot !== false && opts.skipAutoSnapshot?.() !== true);
  if (wantSnapshot && !dialogPending && !tab.closed) {
    // PLAN "Decisions from the bench": the automatic snapshot is viewport-only and capped at
    // ATTACHED_SNAPSHOT_MAX_CHARS; an explicit snapshot:true keeps the full page.
    const capMax = Math.max(OUTPUT_RESERVE, opts.maxChars - OUTPUT_RESERVE - text.length - 2);
    const snapMax = fullPage ? capMax : Math.min(ATTACHED_SNAPSHOT_MAX_CHARS, capMax);
    const snapP = buildSnapshot(session, tab, { mode: 'interactive', viewportOnly: !fullPage, limit: lineLimit(0, snapMax), countsFromWalk: !fullPage });
    snapP.catch(() => undefined);
    const snap = await within(snapP, readLeft(Math.max(300, left() + 300)), null).catch(() => null);
    // The summary and the attached snapshot together stay within the output cap (a hard ceiling).
    if (snap && fullPage) text += `\n\n${pageLines(snap.header, snap.lines, 0, snapMax, snap.omitted).text}`;
    else if (snap) {
      const footer = (remaining: number, next: number) => viewportFooter(snap.offscreen, remaining, next);
      text += `\n\n${pageLines(snap.header, snap.lines, 0, snapMax, snap.omitted, footer).text}`;
    }
    else text += '\n\n(snapshot unavailable: the page is still loading; call snapshot)';
  }
  return { text, dialogPending };
}
