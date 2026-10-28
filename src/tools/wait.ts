import { z } from 'zod';
import type { Frame } from 'playwright-core';
import { FRAME_BUDGET_MS, call, unavailableFrames } from '../page/engine.js';
import { parseRef, refState } from '../page/target.js';
import { ToolError, isTimeout } from '../util/errors.js';
import { matcher, sleep, capMs, unlessCrash } from './common.js';
import { defineTool, tabArg, timeoutArg, type CallCtx } from './types.js';

type Settled = { ok: true; value: boolean } | { ok: false };

/**
 * Round 7b (C2): the frame fan-out of `wait text` and `text_gone`, with "did not answer" as its own state.
 * Round 7 gave each frame 500 ms and read a frame that did not answer as "the text is not there", so
 * `text_gone` succeeded at 502 ms while the text was on a busy page (10 of 10). One ask per frame is kept
 * in flight across poll ticks: a busy frame is asked again only after it answered (an evaluate is never
 * cancelled, so one per tick would queue dozens in it).
 */
class FrameAsks {
  private readonly inflight = new Map<Frame, { p: Promise<Settled>; done: Settled | null }>();

  constructor(private readonly ask: (f: Frame) => Promise<boolean>) {}

  /**
   * Asks every frame; ends when all answered, after `budgetMs`, or as soon as one answers true when
   * `stopOnTrue`. `has`: an answering frame holds the text. `unanswered`: frames with no answer this tick (a
   * failed call too, unless the frame is detached by then).
   */
  async tick(frames: Frame[], budgetMs: number, stopOnTrue: boolean): Promise<{ has: boolean; unanswered: Frame[] }> {
    for (const f of [...this.inflight.keys()]) if (!frames.includes(f)) this.inflight.delete(f);
    const entries = frames.map((f) => {
      let e = this.inflight.get(f);
      if (!e) {
        const entry: { p: Promise<Settled>; done: Settled | null } = { p: Promise.resolve({ ok: false }), done: null };
        entry.p = this.ask(f).then(
          (value): Settled => (entry.done = { ok: true, value }),
          (): Settled => (entry.done = { ok: false }),
        );
        this.inflight.set(f, entry);
        e = entry;
      }
      return { f, e };
    });
    let h: ReturnType<typeof setTimeout> | undefined;
    let early: (() => void) | undefined;
    const stop = new Promise<void>((resolve) => {
      early = resolve;
      h = setTimeout(resolve, Math.max(0, budgetMs));
    });
    if (stopOnTrue) for (const { e } of entries) void e.p.then((r) => (r.ok && r.value ? early?.() : undefined));
    try {
      await Promise.race([Promise.all(entries.map(({ e }) => e.p)), stop]);
    } finally {
      clearTimeout(h);
    }
    let has = false;
    const unanswered: Frame[] = [];
    for (const { f, e } of entries) {
      if (e.done === null) {
        unanswered.push(f); // still busy: the same ask is awaited again next tick
        continue;
      }
      this.inflight.delete(f); // answered or failed: asked afresh next tick
      if (e.done.ok) has ||= e.done.value;
      else if (!f.isDetached()) unanswered.push(f);
    }
    return { has, unanswered };
  }
}

type PollResult = { ok: true } | { ok: false; unanswered: Frame[]; total: number };

/**
 * `wait text` succeeds as soon as an answering frame holds the text. `text_gone` succeeds only on a tick where
 * every frame answered and none holds it; a frame that did not answer is asked again within the timeout.
 * A tick may end past `timeoutMs` by at most its budget, never past the call deadline (capMs).
 */
async function pollText(ctx: CallCtx, text: string, gone: boolean, timeoutMs: number): Promise<PollResult> {
  const asks = new FrameAsks((f) => call(f, 'hasText', text).then((x) => x.value === true));
  const end = Date.now() + timeoutMs;
  for (;;) {
    // A crashed tab answers nothing; the caller's unlessCrash reports it (round 7 read that as "gone").
    if (ctx.tab.crashed) return { ok: false, unanswered: [], total: 0 };
    const frames = ctx.tab.page.frames().filter((f) => !f.isDetached());
    const r = await asks.tick(frames, capMs(ctx, FRAME_BUDGET_MS), !gone);
    if (gone ? !r.has && r.unanswered.length === 0 : r.has) return { ok: true };
    if (Date.now() >= end) return { ok: false, unanswered: r.unanswered, total: frames.length };
    await sleep(Math.min(100, Math.max(5, end - Date.now())));
  }
}

async function poll(fn: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() >= end) return false;
    await sleep(Math.min(100, Math.max(5, end - Date.now())));
  }
}

export const wait = defineTool({
  name: 'wait',
  description:
    'Wait for exactly one condition: text (appears), text_gone, target with state (visible default, hidden, attached, detached), url (substring or /regex/), load_state, or ms (unconditional, at most 30000). On timeout the error names the condition.',
  shape: {
    tab: tabArg,
    text: z.string().optional(),
    text_gone: z.string().optional(),
    target: z.string().optional(),
    state: z.enum(['visible', 'hidden', 'attached', 'detached']).optional(),
    url: z.string().optional(),
    load_state: z.enum(['domcontentloaded', 'load', 'networkidle']).optional(),
    ms: z.number().int().min(0).max(30000).optional(),
    timeout_ms: timeoutArg,
  },
  annotations: { openWorldHint: true },
  scope: 'tab',
  targetKeys: ['target'],
  timeoutMs: (a, c) => (a.ms !== undefined ? a.ms : (a.timeout_ms ?? c.actionTimeout)),
  async handler(a, ctx) {
    const conds = (['text', 'text_gone', 'target', 'url', 'load_state', 'ms'] as const).filter((k) => a[k] !== undefined);
    if (conds.length !== 1) {
      throw new ToolError(
        conds.length === 0 ? 'wait needs one condition' : `wait takes exactly one condition, got ${conds.join(', ')}`,
        'pass one of text, text_gone, target(+state), url, load_state, ms',
      );
    }
    const timeout = a.timeout_ms ?? ctx.config.actionTimeout;
    const page = ctx.tab.page;
    const id = ctx.tab.id;
    const started = Date.now();
    const done = (what: string) => `[${id}] waited for ${what} (${Date.now() - started}ms)`;
    // Round 4, D1 AC4: the timeout that applied (a call queued behind others gets what its deadline leaves).
    const applied = capMs(ctx, timeout);
    const fail = (what: string, unanswered: Frame[] = [], total = 0): never => {
      const why = applied < timeout ? ` (timeout_ms ${timeout} capped by the call deadline)` : '';
      // Round 7b (C2): frames that never answered are named; for text_gone they are why it did not succeed.
      const frames = unanswered.length > 0 ? `; ${unavailableFrames(unanswered.map((f) => ctx.tab.frameLabel(f)), total)}` : '';
      const hint =
        unanswered.length > 0
          ? 'a frame that does not answer may still hold the text: check it with snapshot, or retry with a larger timeout_ms'
          : 'check the page with snapshot, or retry with a larger timeout_ms';
      throw new ToolError(`wait for ${what} timed out after ${applied}ms${why}${frames}`, hint);
    };
    if (a.ms !== undefined) {
      await sleep(Math.min(a.ms, capMs(ctx, a.ms)));
      return done(`${a.ms}ms`);
    }
    if (a.text !== undefined || a.text_gone !== undefined) {
      const gone = a.text === undefined;
      const t = (gone ? a.text_gone : a.text) as string;
      const what = gone ? `text ${JSON.stringify(t)} to disappear` : `text ${JSON.stringify(t)}`;
      const r = await unlessCrash(ctx.tab, pollText(ctx, t, gone, capMs(ctx, timeout)));
      return r.ok ? done(what) : fail(what, r.unanswered, r.total);
    }
    if (a.url !== undefined) {
      const m = matcher(a.url);
      const what = `url ${a.url}`;
      if (m(page.url())) return done(what);
      try {
        await page.waitForURL((u) => m(u.href), { timeout: capMs(ctx, timeout), waitUntil: 'commit' });
        return done(what);
      } catch (e) {
        if (isTimeout(e)) fail(what);
        throw e;
      }
    }
    if (a.load_state !== undefined) {
      const what = `load_state ${a.load_state}`;
      try {
        await page.waitForLoadState(a.load_state, { timeout: capMs(ctx, timeout) });
        return done(what);
      } catch (e) {
        if (isTimeout(e)) fail(what);
        throw e;
      }
    }
    const target = a.target ?? '';
    const state = a.state ?? 'visible';
    const what = `${target} ${state}`;
    const ref = parseRef(target);
    if (ref !== null) {
      // C5: the same document check as an action; a ref from an earlier document is an error at once.
      const probe = async (): Promise<boolean> => {
        // Transient evaluation errors (a frame mid-navigation) read as "not there", as before.
        // R-W11: detached and hidden succeed for a ref whose document is gone.
        const h = await refState(ctx.session, ctx.tab, ref, { goneOk: state === 'detached' || state === 'hidden' }).catch((e: unknown) => {
          if (e instanceof ToolError) throw e;
          return null;
        });
        if (state === 'detached') {
          await h?.dispose().catch(() => undefined);
          return h === null;
        }
        if (state === 'attached') {
          await h?.dispose().catch(() => undefined);
          return h !== null;
        }
        if (!h) return state === 'hidden';
        try {
          const vis = await h.isVisible().catch(() => false);
          return state === 'visible' ? vis : !vis;
        } finally {
          await h.dispose().catch(() => undefined);
        }
      };
      const ok = await poll(probe, capMs(ctx, timeout));
      return ok ? done(what) : fail(what);
    }
    try {
      await page.locator(target).first().waitFor({ state, timeout: capMs(ctx, timeout) });
      return done(what);
    } catch (e) {
      if (isTimeout(e)) fail(what);
      throw e;
    }
  },
});
