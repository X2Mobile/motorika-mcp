// The single dispatcher. Every tool call (MCP stdio, batch steps, and later a socket server for joined
// sessions) goes through dispatch(tool, args, clientId). A client has its own active tab and owned tabs;
// refs and tab ids are process-global.
import type { Session } from './browser/session.js';
import { DEFAULT_CLIENT } from './browser/session.js';
import type { Client, Tab } from './browser/tabs.js';
import type { Config } from './config.js';
import { parseRef, tabOfRef } from './page/target.js';
import { ToolError, firstLine, firstLineRaw, isClosedError, isTimeout } from './util/errors.js';
import { ARROW, effect, jsonQuote } from './util/format.js';
import { log } from './util/log.js';
import { crashedSoon } from './tools/common.js';
import { errorResult, type CallCtx, type Tool, type ToolResult } from './tools/types.js';
import { redactUrlParams, safeUrl, scrubSecrets } from './util/secrets.js';

/**
 * An absolute URL as printed in a result line: up to whitespace, a quote, an angle bracket or a backslash
 * (round 4, F1: never into an escape sequence). Brackets
 * and parentheses stay inside it (round 3, C11: `?a[0]=1&token=…` and `?q=(x)&token=…` were cut at the
 * first `]` or `)`, so the parameters after it printed in clear); trailing ones are peeled off below.
 */
// Round 4, F1: a printed URL also stops at a backslash. In JSON-quoted page text a `\"` (or any escape)
// directly after a URL was taken into the URL and redacted away with its parameter value, which ended the
// quoted string early and let page text forge a ref (`… <redacted>" e1 …`).
const PRINTED_URL = /\b(?:https?|wss?|file):\/\/[^\s"'<>\\]+/g;
/** Trailing punctuation peeled off a printed URL: `)`, `]`, `.`, `,`, `;`, `:`, `!`, `?`. */
const TRAILING_PUNCT_CHARS = new Set([')', ']', '.', ',', ';', ':', '!', '?']);

/**
 * Where a printed URL's trailing punctuation starts. Round 4, D4: a backward scan, linear in the run of
 * punctuation; the regex `/[)\].,;:!?]+$/` it replaces retried from every position of a long run of dots
 * (quadratic: 50k dots took 2.1 s and blocked every client).
 */
export function trailingPunctStart(u: string): number {
  let i = u.length;
  while (i > 0 && TRAILING_PUNCT_CHARS.has(u[i - 1] as string)) i--;
  return i;
}

/** The dispatcher's safety net: every printed URL has its secret-named parameters redacted. */
export function redactPrintedUrls(text: string): string {
  return text.replace(PRINTED_URL, (u) => {
    const cut = trailingPunctStart(u);
    return `${redactUrlParams(u.slice(0, cut))}${u.slice(cut)}`;
  });
}

/** Extra time the dispatcher allows beyond a call's own timeout before it answers anyway (G1: < 2 s). */
export const DEADLINE_SLACK_MS = 1900;
const LOCK_FREE = new Set(['session', 'batch']);
/** How long the tab queue waits, past a call's deadline, for its abandoned job to settle (re-check item 1). */
export const QUEUE_GRACE_MS = 5000;

class DeadlineHit extends Error {}

/** What a timeout error reports (round 4, D1). */
interface ErrorAt {
  deadline: number;
  budget: number;
  /** The tab's URL when the call was routed to it. */
  url0?: string;
  /** Round 5, D1 AC3: the tool, and whether its job had started on the page (it may still be running). */
  tool?: string;
  started?: boolean;
}

/** Round 5, D1 AC3: tools whose job, once started, may still move the tab after a deadline answer. */
const NAVIGATING_TOOLS = new Set(['navigate']);

/** Round 5, D1 AC3: the deadline hint for a navigation that started and did not answer in time. */
export const NAV_DEADLINE_HINT = 'the navigation may still be in progress; check the tab with snapshot before navigating again';

/** The tab's URL for an error line; never throws (a crashed or closing page). */
function tabUrl(tab: Tab): string {
  try {
    return tab.page.url();
  } catch {
    return 'about:blank';
  }
}

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const d = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new DeadlineHit()), ms);
  });
  p.catch(() => undefined);
  return Promise.race([p, d]).finally(() => clearTimeout(timer));
}

/** Two-line error (contract Q2): line 1 the cause, line 2 `hint: <next step>`. */
export function errorText(cause: string, hint: string): string {
  return `${cause}\nhint: ${hint}`;
}

/**
 * Default call budgets (contract Q1). `timeout_ms`, when given, replaces the default. The dispatcher
 * answers by budget + DEADLINE_SLACK_MS.
 */
export function budgetOf(tool: string, args: Record<string, unknown>, cfg: Pick<Config, 'actionTimeout' | 'navigationTimeout'>): number {
  const t = typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined;
  const act = cfg.actionTimeout;
  const nav = cfg.navigationTimeout;
  switch (tool) {
    case 'navigate':
      return t ?? nav;
    case 'tabs':
      return args.action === 'new' && typeof args.url === 'string' ? (t ?? nav) : (t ?? act);
    case 'session':
      return args.action === 'launch' ? (t ?? nav) : (t ?? act);
    case 'wait':
      return typeof args.ms === 'number' ? Math.max(args.ms, t ?? 0) : (t ?? act);
    case 'video':
      if (args.action !== 'frames') return t ?? act;
      if (typeof args.every_ms === 'number') return (typeof args.duration_ms === 'number' ? args.duration_ms : 0) + act;
      return t ?? nav;
    case 'batch': {
      const steps = Array.isArray(args.steps) ? (args.steps as { tool?: unknown; args?: unknown }[]) : [];
      const sum = steps.reduce((acc, st) => {
        const a = typeof st.args === 'object' && st.args !== null ? (st.args as Record<string, unknown>) : {};
        return acc + (typeof st.tool === 'string' ? budgetOf(st.tool, a, cfg) : act);
      }, 0);
      return sum > 0 ? sum : act;
    }
    default:
      return t ?? act;
  }
}

/**
 * The landing guard sent the main frame to about:blank during this call: its `→ blocked <url>` line says
 * what happened, so the `→ navigated about:blank` line of that guard step is dropped (re-check nit).
 */
function dropGuardBlankNav(r: ToolResult): void {
  r.content = r.content.map((c) => {
    if (c.type !== 'text' || !c.text.includes(`${ARROW}blocked `)) return c;
    return { ...c, text: c.text.split('\n').filter((l) => !l.startsWith(`${ARROW}navigated about:blank`)).join('\n') };
  });
}

function crashedError(tab: Tab): ToolResult {
  return errorResult(errorText(`[${tab.id}] tab ${tab.id} crashed`, 'close it with tabs close, or open a new tab with tabs new'));
}

/** Round 5 (security): the longest wait for crash evidence after a call failed. */
export const CRASH_CHECK_MS = 2000;
/** Room kept after that wait for the answer to go out before the call deadline. */
const CRASH_CHECK_GUARD_MS = 50;

/**
 * Round 7 (item 5): no error text ever decides a crash. Any call that failed (before its deadline) asks the
 * browser: `crashedSoon` sends CDP `Runtime.evaluate` of `1` on the tab's own session (no page function runs),
 * and only the page's `crash` event marks the tab crashed. A live renderer answers in ms; a crashed one never
 * answers and fires 'crash' (the renderer can crash during the call, before that event arrived). Round 6
 * looked at "Target crashed"/"page crashed" wording first: an overlay titled "page crashed", the caller's own
 * wait text or an evaluate exception then replaced the real error. Bounded by the call deadline.
 */
async function crashCheck(e: unknown, tab: Tab, leftMs: number): Promise<void> {
  if (tab.crashed || tab.closed || e instanceof DeadlineHit) return;
  await crashedSoon(tab, Math.min(CRASH_CHECK_MS, leftMs - CRASH_CHECK_GUARD_MS)).catch(() => false);
}

export const CUT_NOTE = (max: number): string => `\u2026 output cut at ${max} chars`;

/**
 * Hard cap over all text parts of a result (prefixes, notices and batch totals included), as a consumer
 * sees it: the text parts plus one separator between two parts (review of cc50db4, item 1). Cuts at a
 * line boundary and never keeps part of a line; the closing note fits inside the cap. Images are not text
 * and are kept.
 */
export function capResult(res: ToolResult, max: number): ToolResult {
  const texts = res.content.filter((c) => c.type === 'text');
  const total = texts.reduce((n, c) => n + c.text.length, 0) + Math.max(0, texts.length - 1);
  if (total <= max) return res;
  const note = CUT_NOTE(max);
  // Chars used so far, separators included; a part after the first costs one separator more.
  let used = 0;
  let parts = 0;
  let cut = false;
  const out: ToolResult['content'] = [];
  for (const c of res.content) {
    if (c.type !== 'text') {
      out.push(c);
      continue;
    }
    if (cut) continue;
    const sep = parts > 0 ? 1 : 0;
    // Room for this part and, after it, the note as its own line.
    if (used + sep + c.text.length + 1 + note.length <= max) {
      out.push(c);
      used += sep + c.text.length;
      parts++;
      continue;
    }
    const keep = max - used - sep - 1 - note.length;
    const slice = keep > 0 ? c.text.slice(0, keep + 1) : '';
    // Whole lines only: up to the last newline that fits (a line is never kept in part).
    const nl = slice.lastIndexOf('\n');
    const head = nl >= 0 ? slice.slice(0, nl) : '';
    if (head !== '') out.push({ type: 'text', text: `${head}\n${note}` });
    // A kept part always leaves room for the separator and the note; only a cap below the note's own
    // length gets a clipped note.
    else out.push({ type: 'text', text: note.slice(0, Math.max(0, max - used - sep)) });
    cut = true;
  }
  return res.isError ? { content: out, isError: true } : { content: out };
}

/** Forwarding hook for joined sessions (the share router). */
export interface Router {
  route(tool: string, args: unknown): Promise<ToolResult | undefined>;
}

export interface DispatchOptions {
  /** Set by batch: nested batch is refused. */
  inBatch?: boolean;
}

export class Dispatcher {
  constructor(
    readonly session: Session,
    readonly config: Config,
    readonly tools: Map<string, Tool>,
  ) {}

  /** Set when this server may share its profile's browser (launch mode, persistent profile). */
  router: Router | undefined;

  async dispatch(name: string, rawArgs: unknown, clientId: string = DEFAULT_CLIENT, opts: DispatchOptions = {}): Promise<ToolResult> {
    const client = this.session.client(clientId);
    if (clientId === DEFAULT_CLIENT && !opts.inBatch && this.router) {
      const forwarded = await this.router.route(name, rawArgs);
      if (forwarded) return this.final(this.withNotices(client, forwarded));
    }
    const tool = this.tools.get(name);
    if (!tool) return this.final(this.withNotices(client, errorResult(errorText(`unknown tool "${name}"`, 'call tools/list for the available tools'))));
    if (opts.inBatch && name === 'batch') return errorResult(errorText('batch cannot nest', 'put all the steps in one batch'));
    let args: Record<string, unknown>;
    try {
      args = tool.parse(rawArgs);
    } catch (e) {
      return this.final(this.withNotices(client, this.toError(e, undefined)));
    }
    const arrival = Date.now();
    const run = () => this.run(tool, args, client, opts, arrival);
    const res = LOCK_FREE.has(name) ? await run() : await this.session.lock.shared(run);
    return this.final(this.withNotices(client, res));
  }

  /** Last pass over every result: the hard output cap (review item 4). */
  private final(res: ToolResult): ToolResult {
    // Review item 5: remembered password literals and secret-named query values never leave the
    // server, whichever tool or notice printed them. Runs before the cap, over every text part.
    res.content = res.content.map((c) =>
      c.type === 'text' ? { ...c, text: redactPrintedUrls(scrubSecrets(c.text)) } : c,
    );
    return capResult(res, this.config.maxOutputChars);
  }

  private withNotices(client: Client, res: ToolResult): ToolResult {
    if (client.notices.length === 0) return res;
    const notes = client.notices.splice(0).join('\n');
    const first = res.content.findIndex((c) => c.type === 'text');
    if (first >= 0) {
      const c = res.content[first];
      if (c && c.type === 'text') res.content[first] = { type: 'text', text: `${notes}\n${c.text}` };
    } else {
      res.content.unshift({ type: 'text', text: notes });
    }
    return res;
  }

  private ctx(client: Client, tab: Tab | undefined, opts: DispatchOptions, deadlineAt?: number): CallCtx {
    return {
      session: this.session,
      config: this.config,
      client,
      tab: tab as Tab,
      dispatch: (n, a) => this.dispatch(n, a, client.id, { ...opts, inBatch: true }),
      deadlineAt,
    };
  }

  private async run(tool: Tool, args: Record<string, unknown>, client: Client, opts: DispatchOptions, arrival: number): Promise<ToolResult> {
    const budget = budgetOf(tool.name, args, this.config);
    const deadline = budget + DEADLINE_SLACK_MS;
    // Everything counts toward the deadline from arrival: the lock, a lazy launch, the tab queue (C1).
    const deadlineAt = arrival + deadline;
    const left = () => Math.max(1, deadlineAt - Date.now());
    if (tool.scope === 'free') {
      try {
        if (tool.needsBrowser(args)) await withDeadline(this.session.ensure(), left());
        return await withDeadline(tool.run(args, this.ctx(client, undefined, opts, deadlineAt)), left());
      } catch (e) {
        return this.toError(e, undefined, { deadline, budget });
      }
    }
    let tab: Tab;
    try {
      await withDeadline(this.session.ensure(), left());
      tab = await this.resolveTab(tool, args, client);
    } catch (e) {
      return this.toError(e, undefined, { deadline, budget });
    }
    // Round 4, D1: a timeout error says where the tab is, and whether the call moved it.
    const url0 = tabUrl(tab);
    const at: ErrorAt = { deadline, budget, url0, tool: tool.name };
    const prefix = tab.drainEvents().map((e) => e.line);
    const blanks0 = tab.guardBlanks;
    const finish = (r: ToolResult): ToolResult => {
      if (tab.guardBlanks !== blanks0) dropGuardBlankNav(r);
      if (prefix.length === 0) return r;
      const i = r.content.findIndex((c) => c.type === 'text');
      const c = r.content[i];
      if (c && c.type === 'text') r.content[i] = { type: 'text', text: `${prefix.join('\n')}\n${c.text}` };
      return r;
    };
    if (tool.dialogExempt(args)) {
      try {
        return finish(await withDeadline(tool.run(args, this.ctx(client, tab, opts, deadlineAt)), left()));
      } catch (e) {
        await crashCheck(e, tab, left());
        return finish(this.toError(e, tab, at));
      }
    }
    if (tab.crashed) return finish(crashedError(tab));
    if (tab.dialog) return finish(this.dialogError(tab));
    const job = async (): Promise<ToolResult> => {
      if (tab.closed) return errorResult(errorText(`tab ${tab.id} was closed`, 'call tabs list for the open tabs'));
      if (tab.crashed) return crashedError(tab);
      if (tab.dialog) return this.dialogError(tab);
      at.started = true;
      const p = tool.run(args, this.ctx(client, tab, opts, deadlineAt));
      p.catch(() => undefined);
      if (tool.handlesDialog) return p;
      // Review P6: a per-call dialog waiter, dropped once the race is over, so no reaction stays
      // attached to a promise that may never settle.
      const ac = new AbortController();
      const d = tab.dialogOpened(ac.signal).then(() => this.dialogError(tab, true));
      d.catch(() => undefined);
      try {
        return await Promise.race([p, d]);
      } finally {
        ac.abort();
      }
    };
    // C1: the wait in the tab queue is raced against the deadline too. A call whose turn comes after
    // its deadline returns the timeout and never touches the page.
    // Re-check item 1 (R-C1): the caller gets its answer at the deadline, but the queue moves on only
    // once the job has actually settled, so a timed-out call never overlaps the next call on this tab.
    // The tools cap their Playwright timeouts by ctx.deadlineAt, so that wait is short; QUEUE_GRACE_MS
    // only guards against a page operation that never settles (e.g. evaluate of an endless loop).
    let expired = false;
    const queued = tab.enqueue(async () => {
      if (expired || Date.now() >= deadlineAt) {
        expired = true;
        throw new DeadlineHit();
      }
      const j = job();
      j.catch(() => undefined);
      const settled = await withDeadline(j.then(() => true, () => true), left() + QUEUE_GRACE_MS).catch(() => false);
      if (!settled) {
        // Returning `j` here would make the queue entry adopt the still-pending job and block the tab
        // until it settles (seen: a never-answering navigation held the next navigate for 31.9 s).
        // The caller already has its timeout answer, so release the queue explicitly.
        log.warn(`[${tab.id}] ${tool.name} did not settle ${QUEUE_GRACE_MS}ms after its deadline; the tab queue moves on`);
        throw new DeadlineHit();
      }
      return j;
    });
    queued.catch(() => undefined);
    try {
      return finish(await withDeadline(queued, left()));
    } catch (e) {
      if (e instanceof DeadlineHit) expired = true;
      await crashCheck(e, tab, left());
      return finish(this.toError(e, tab, at));
    }
  }

  private dialogError(tab: Tab, during = false): ToolResult {
    const d = tab.dialog;
    if (!d) return errorResult(errorText(`[${tab.id}] a dialog was open`, 'retry the call'));
    return errorResult(
      `${errorText(
        // Round 3 C10: jsonQuote escapes U+2028, U+2029 and U+0085 too, so the text cannot add a line.
        `[${tab.id}] ${during ? 'a dialog opened during this call: ' : ''}${d.type} dialog pending ${jsonQuote(d.message)}`,
        `use dialog accept|dismiss (tab=${tab.id}) first`,
      )}\n${effect.dialogPending(d.type, d.message)}`,
    );
  }

  private async resolveTab(tool: Tool, args: Record<string, unknown>, client: Client): Promise<Tab> {
    const s = this.session;
    const refTabs = new Set<string>();
    const goneOk = tool.name === 'wait' && (args.state === 'detached' || args.state === 'hidden');
    for (const k of tool.targetKeys) {
      const v = args[k];
      const vals = Array.isArray(v) ? v : [v];
      for (const x of vals) {
        const t = typeof x === 'string' ? x : typeof x === 'object' && x !== null && 'target' in x ? (x as { target: unknown }).target : undefined;
        if (typeof t !== 'string') continue;
        const ref = parseRef(t);
        if (ref === null) continue;
        if (!s.refs.get(ref)) {
          const why = s.refs.whyMissing(ref);
          if (why.reason === 'previous-session') {
            throw new ToolError(`e${ref} is from a previous browser session`, 'this server took over the shared browser after its owner exited; take a new snapshot');
          }
          // R-W11 (round 3, C2): wait detached|hidden on a ref whose document is gone runs on its tab.
          // Round 4, D2: a long-forgotten stale ref has no known tab; it runs on tab= or the active tab.
          if (goneOk && (why.reason === 'old-doc' || why.reason === 'stale')) {
            if (why.tabId !== undefined) refTabs.add(why.tabId);
            continue;
          }
        }
        refTabs.add(tabOfRef(s, ref));
      }
    }
    if (refTabs.size > 1) throw new ToolError(`the refs belong to different tabs (${[...refTabs].join(', ')})`, 'use refs from one tab per call');
    const fromRef = [...refTabs][0];
    const tabArg = typeof args.tab === 'string' ? args.tab : undefined;
    if (tabArg !== undefined && fromRef !== undefined && tabArg !== fromRef) {
      throw new ToolError(`the ref belongs to ${fromRef}, not ${tabArg}`, `omit tab (refs locate their own tab) or pass tab=${fromRef}`);
    }
    const id = tabArg ?? fromRef;
    if (id !== undefined) {
      const t = s.getTab(id);
      if (!t || t.closed) throw new ToolError(`no open tab ${id}`, 'call tabs list for the open tabs');
      if (!client.owned.has(t.id)) throw new ToolError(`tab ${id} belongs to another client`, 'use tabs list to see your tabs');
      return t;
    }
    return s.activeTab(client.id);
  }

  private toError(e: unknown, tab: Tab | undefined, at?: ErrorAt): ToolResult {
    const pre = tab ? `[${tab.id}] ` : '';
    // Round 4, D1 AC3: every timeout names the URL the tab shows now.
    const shows = tab && !tab.closed ? `; the tab shows ${safeUrl(tabUrl(tab))}` : '';
    // The renderer can crash while a call runs, before Playwright's 'crash' event marks the tab: whichever
    // tool or helper surfaced it, the caller gets the crashed-tab error. Round 5 (security): only once the
    // browser confirmed it (crashCheck, before this), never on an error's text.
    if (tab && tab.crashed) return crashedError(tab);
    if (e instanceof ToolError) {
      // Every timeout wording: `timed out`, `not visible after 812ms`, `kept moving … for 812ms`.
      const timedOut = /\btimed out\b|\b(?:after|for) \d+ms\b/.test(e.cause1) && !e.cause1.includes('the tab shows ');
      return errorResult(errorText(`${pre}${e.cause1}${timedOut ? shows : ''}`, e.hint));
    }
    if (e instanceof DeadlineHit) {
      // Round 4, D1 AC4: the deadline that applied (timeout + slack, counted from arrival, queue included).
      const d = at?.deadline ?? 0;
      const what = at ? ` (the call deadline: ${at.budget}ms timeout + ${d - at.budget}ms, time queued behind earlier calls included)` : '';
      const moved = tab !== undefined && at?.url0 !== undefined && !tab.closed && tabUrl(tab) !== at.url0;
      // AC3: once the tab's URL changed, a navigation is never blindly retried (it would navigate twice).
      // Round 5: nor while a started navigation may still commit (the tab has not moved yet).
      const navigating = at?.started === true && at.tool !== undefined && NAVIGATING_TOOLS.has(at.tool);
      const hint = moved
        ? 'the tab already moved during this call; check it with snapshot before navigating or acting again'
        : navigating
          ? NAV_DEADLINE_HINT
          : 'retry with a larger timeout_ms, or check the page with snapshot';
      return errorResult(errorText(`${pre}timed out after ${d}ms${what}${shows}`, hint));
    }
    if (isClosedError(e)) {
      if (tab?.closed) return errorResult(errorText(`${pre}tab ${tab.id} was closed`, 'call tabs list for the open tabs'));
      return errorResult(errorText(`${pre}the browser or page closed during the call`, 'retry; the next call relaunches or reconnects'));
    }
    // Round 7 (item 6): "Timeout 1ms exceeded" can be page text (a main-world error): the message only quoted.
    if (isTimeout(e)) return errorResult(errorText(`${pre}${jsonQuote(firstLineRaw(e))}${shows}`, 'retry with a larger timeout_ms or check the target with snapshot'));
    log.debug('tool error', e);
    // Round 6 (security): an error no tool mapped may carry page text (a main-world evaluation under a
    // replaced window.eval): its message is printed only inside a JSON string.
    return errorResult(errorText(`${pre}error: ${jsonQuote(firstLineRaw(e))}`, 'check the arguments or take a snapshot and retry'));
  }
}
