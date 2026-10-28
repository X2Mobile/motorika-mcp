// Helpers shared by tool handlers.
import type { Tab } from '../browser/tabs.js';
import { activate } from '../browser/tabs.js';
import { runAction, type ActionOptions } from '../page/effects.js';
import type { Target } from '../page/target.js';
import { ToolError, errorLog, firstLine, firstLineRaw, isTimeout, stripAnsiStyle } from '../util/errors.js';
import { jsonQuote } from '../util/format.js';
import { scrubSecrets } from '../util/secrets.js';
import type { CallCtx, ToolResult } from './types.js';

export function actionOpts(ctx: CallCtx, extra: Partial<ActionOptions> = {}): ActionOptions {
  return {
    maxChars: ctx.config.maxOutputChars,
    navigationTimeout: ctx.config.navigationTimeout,
    actionTimeout: ctx.config.actionTimeout,
    // Round 4, D1: settle and the trailing reads end before the call deadline.
    deadlineAt: ctx.deadlineAt,
    ...extra,
  };
}

/**
 * Launch modes (headless and headed) act on background tabs directly: Playwright starts Chrome with
 * background throttling disabled (verified headed 2026-10-21: background click 91 ms, rAF 4 ms). An
 * attached Chrome has no such flags, so its background tabs may throttle rAF and stall the stability
 * check: bring the tab to the front first; the client's active tab then follows (the marker tells the
 * truth). Multi-tab work therefore serializes in attach modes.
 */
export async function frontFor(ctx: CallCtx, tab: Tab): Promise<void> {
  const s = ctx.session;
  if (!s.isAttach) return;
  if (s.frontTab === tab.id) return;
  await tab.page.bringToFront();
  s.frontTab = tab.id;
  if (ctx.client.owned.has(tab.id)) activate(ctx.client, tab.id);
}

/**
 * Re-check item 1: every Playwright timeout inside a call is capped by what remains of the call's
 * deadline, so an abandoned action can never land after the timeout result. Evaluate at each call
 * site (target resolution eats into the budget). Never 0: Playwright reads timeout 0 as "no timeout".
 */
export function capMs(ctx: Pick<CallCtx, 'deadlineAt'>, ms: number): number {
  const left = (ctx.deadlineAt ?? Number.POSITIVE_INFINITY) - Date.now() - DEADLINE_MARGIN_MS;
  return Math.max(1, Math.min(ms, left));
}
/** The action timeout fires this much before the dispatcher's deadline answer. */
const DEADLINE_MARGIN_MS = 50;

export async function act(ctx: CallCtx, header: string | (() => string), action: () => Promise<unknown>, extra: Partial<ActionOptions> = {}): Promise<ToolResult> {
  await frontFor(ctx, ctx.tab);
  // The settle budget is capped by the call deadline too (re-check item 1), so an abandoned job ends soon.
  const budgetMs = capMs(ctx, extra.budgetMs ?? ctx.config.actionTimeout);
  const r = await runAction(ctx.session, ctx.tab, header, action, actionOpts(ctx, { ...extra, budgetMs }));
  // Page text that echoes a typed password (live regions, titles) is scrubbed (amendment item 5).
  return { content: [{ type: 'text', text: scrubSecrets(r.text) }] };
}

/** Map Playwright actionability failures to a cause + next step. */
export function actionError(e: unknown, what: string, nominalMs: number): ToolError {
  if (e instanceof ToolError) return e;
  const log = errorLog(e);
  // Round 4, D1 AC4: report the timeout that applied. Playwright names it (`Timeout 812ms exceeded`); a call
  // that waited in the tab queue gets less than timeout_ms, capped by the call deadline (capMs).
  const applied = Number(/Timeout (\d+)ms exceeded/.exec(log)?.[1] ?? nominalMs);
  const timeoutMs = applied < nominalMs ? `${applied}ms (timeout_ms ${nominalMs} capped by the call deadline)` : `${applied}ms`;
  const cover = /(<[^\n]*?>)(?:[^\n]*?) (?:from <[^\n]*?> subtree )?intercepts pointer events/.exec(log);
  if (cover) {
    // Round 5 (security): Playwright's preview of the covering element carries its attribute values and text
    // (page text) and maps only \n and \t. Round 6 (item 8): it is JSON-quoted like a name, so neither a line
    // separator nor a quote in it (`title='x" e99999'`) can leave the string.
    return new ToolError(
      `${what} is covered by ${jsonQuote(stripAnsiStyle(cover[1] ?? ''))} (it intercepts pointer events)`,
      'close or wait for the covering element (wait target=… state=hidden), or click it instead; force=true skips the check',
    );
  }
  if (/element is not enabled|element is disabled/.test(log)) {
    return new ToolError(`${what} is disabled`, 'enable it first (fill required fields), or check the state with snapshot');
  }
  if (/element is not editable|readonly/i.test(log) && /not editable/.test(log)) {
    return new ToolError(`${what} is not editable (readonly or disabled)`, 'pick an editable field from snapshot');
  }
  if (/element is not visible/.test(log) && isTimeout(e)) {
    return new ToolError(`${what} is not visible after ${timeoutMs}`, 'scroll it into view, open its container, or wait for it (wait target=… state=visible)');
  }
  if (/element is outside of the viewport/.test(log)) {
    return new ToolError(`${what} is outside of the viewport and cannot be scrolled into view`, 'scroll its container (scroll target=<container> direction=…) first');
  }
  if (/not stable/.test(log) && isTimeout(e)) {
    return new ToolError(`${what} kept moving (animation) for ${timeoutMs}`, 'wait for the animation to finish, or pass force=true');
  }
  if (/Element is not attached|not attached to the DOM|Element is detached/i.test(log)) {
    return new ToolError(`${what} was removed from the page during the action`, 'take a new snapshot and retry with a fresh ref');
  }
  if (isTimeout(e)) return new ToolError(`${what}: action timed out after ${timeoutMs}`, 'take a snapshot to check the page state, or retry with a larger timeout_ms');
  // Round 6 (item 11, the hostile matrix): an unknown error may be a main-world evaluation's, i.e. page text
  // (a replaced window.eval); it is printed only inside a JSON string.
  return new ToolError(`${what}: ${jsonQuote(firstLineRaw(e))}`, 'take a snapshot to check the page state and retry');
}

/** Dispose the element handles of resolved targets (review P6: handles otherwise outlive the call). */
export function disposeTargets(...ts: (Target | undefined)[]): void {
  for (const t of ts) if (t && t.kind === 'element') void t.handle.dispose().catch(() => undefined);
}

/** PLAN amendment item 6: the error for any page tool on a crashed tab. */
export function crashedError(tab: Tab): ToolError {
  return new ToolError(`tab ${tab.id} crashed`, 'close it with tabs close, or open a new tab with tabs new');
}

export function assertNotCrashed(tab: Tab): void {
  if (tab.crashed) throw crashedError(tab);
}

/** Race p against a timeout (the timer is cleared either way); p's own rejection is the caller's. */
export async function within<T, F>(p: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  let h: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<F>((resolve) => {
    // setTimeout reads anything above 2^31-1 ms (Infinity included) as 1 ms.
    h = setTimeout(() => resolve(fallback), Math.min(Math.max(0, ms), 2_147_483_647));
  });
  try {
    return await Promise.race([p, t]);
  } finally {
    clearTimeout(h);
  }
}

/**
 * Round 5, R6: a navigation the renderer crashes on (`chrome://crash`) fails as `net::ERR_ABORTED` before
 * Playwright reports the crash, and the renderer answers nothing meanwhile (measured on macOS: 1.9-2.5 s in
 * a bare Playwright context, about 270 ms through this server). So ask the renderer: one that answers is
 * alive (a 204 or a download also fails as ERR_ABORTED); a crashed one never answers, and the page fires
 * 'crash'. Round 6 (security, item 7): the question goes through CDP (`Runtime.evaluate` of `1` on this tab's
 * own session), never through Playwright's main-world evaluate, which runs `window.eval`: a page that replaced
 * eval (or `Array.prototype[Symbol.iterator]`) made that probe throw "Target crashed" and locked its own tab.
 * Only the page's crash event marks the tab crashed. Waits at most `ms`.
 */
export async function crashedSoon(tab: Tab, ms: number): Promise<boolean> {
  if (tab.crashed) return true;
  if (ms <= 0) return false;
  const page = tab.page;
  let onCrash: (() => void) | undefined;
  const crash = new Promise<boolean>((resolve) => {
    onCrash = () => resolve(true);
    page.once('crash', onCrash);
  });
  // A literal through the inspector: no page function runs, so the page cannot make it fail or answer.
  const alive = (async () => {
    const s = await tab.cdp();
    await s.send('Runtime.evaluate', { expression: '1', returnByValue: true });
    return false;
  })();
  // A CDP failure is no answer: only the crash event (or the cap) decides then.
  const answered = alive.catch(() => new Promise<boolean>(() => undefined));
  try {
    await within(Promise.race([crash, answered]), ms, false);
    return tab.crashed;
  } finally {
    if (onCrash) page.off('crash', onCrash);
  }
}

/**
 * Run page work that would hang on a crashed renderer (CDP screenshots, evaluations): reject with the
 * crash error if the page crashes before it settles. The listener is removed either way.
 */
export async function unlessCrash<T>(tab: Tab, work: Promise<T>): Promise<T> {
  assertNotCrashed(tab);
  work.catch(() => undefined);
  let onCrash: (() => void) | undefined;
  const crashed = new Promise<never>((_, reject) => {
    onCrash = () => reject(crashedError(tab));
    tab.page.once('crash', onCrash);
  });
  crashed.catch(() => undefined);
  try {
    return await Promise.race([work, crashed]);
  } finally {
    if (onCrash) tab.page.off('crash', onCrash);
  }
}

export function timeoutOf(args: { timeout_ms?: number | undefined }, def: number): number {
  return args.timeout_ms ?? def;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** "/re/flags" or plain substring matcher. */
export function matcher(pattern: string | undefined): (s: string) => boolean {
  if (!pattern) return () => true;
  const m = /^\/(.+)\/([a-z]*)$/.exec(pattern);
  if (m) {
    let re: RegExp;
    try {
      re = new RegExp(m[1] ?? '', m[2]);
    } catch (e) {
      throw new ToolError(`invalid regex ${pattern}: ${firstLine(e)}`, 'fix the pattern or use a plain substring');
    }
    return (s) => re.test(s);
  }
  return (s) => s.includes(pattern);
}
