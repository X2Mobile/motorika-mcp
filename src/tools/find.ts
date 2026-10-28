import { z } from 'zod';
import type { Frame } from 'playwright-core';
import { FRAME_BUDGET_MS, askFrame, call, callJson, inTime, unavailableFrames } from '../page/engine.js';
import { assertNotCrashed, unlessCrash } from './common.js';
import type { FindHit } from '../page/protocol.js';
import { issueRef, nodeLine, safeNode } from '../page/snapshot.js';
import { ToolError } from '../util/errors.js';
import { capText, elementLine } from '../util/format.js';
import { defineTool, tabArg, type CallCtx } from './types.js';

export const find = defineTool({
  name: 'find',
  description:
    'Find elements by case-insensitive substring over accessible name, visible text (also text split across elements: the smallest element holding it), placeholder, label and value, in all frames. Exact matches first. An empty query with a role lists every element of that role. Each hit is a snapshot line with its ref, followed by a line "  in <nearest heading or landmark line>".',
  shape: {
    tab: tabArg,
    query: z.string().describe('Text to look for; empty together with role lists every element of that role'),
    role: z.string().optional().describe('Only this role (snapshot role vocabulary)'),
    limit: z.number().int().positive().max(200).optional().describe('Default 10'),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  scope: 'tab',
  async handler(a, ctx) {
    const limit = a.limit ?? 10;
    // P5: an empty query lists a role; with no role there is nothing to look for.
    if (a.query.trim() === '' && !a.role) throw new ToolError('find needs a query, or a role to list every element of that role', 'pass query, or role (e.g. role=textbox) with an empty query');
    // A crashed tab must not read as "0 hits" (crashed-tab review).
    assertNotCrashed(ctx.tab);
    const main = ctx.tab.page.mainFrame();
    const frames = ctx.tab.page.frames().filter((f) => !f.isDetached());
    type Hits = { hit: FindHit; frame: Frame; docId: string; order: number }[];
    const results = await unlessCrash(
      ctx.tab,
      Promise.all(
        frames.map(async (f, order): Promise<{ hits: Hits; unanswered?: Frame }> => {
          const one = async (): Promise<Hits> => {
            const r = await callJson(f, 'find', a.query, a.role ?? null, limit);
            return safeHits(r.value).map((hit) => ({ hit, frame: f, docId: r.docId, order }));
          };
          // A main-frame failure is the answer, not "0 hits".
          if (f === main) return { hits: await one() };
          // Round 7 (item 4): a child frame never holds the others beyond its budget. Round 7b (C2): one that
          // did not answer (or failed, and is still attached) is not "0 hits": it is named below.
          const r = await askFrame(f, one(), FRAME_BUDGET_MS);
          if (r.state === 'answered') return { hits: r.value };
          return r.state === 'unanswered' ? { hits: [], unanswered: f } : { hits: [] };
        }),
      ),
    );
    const all = results.flatMap((r) => r.hits);
    all.sort((x, y) => (x.hit.exact === y.hit.exact ? x.order - y.order : x.hit.exact ? -1 : 1));
    const top = all.slice(0, limit);
    const unanswered = results.flatMap((r) => (r.unanswered ? [ctx.tab.frameLabel(r.unanswered)] : []));
    const notAll = unanswered.length > 0 ? `; ${unanswered.length} frame${unanswered.length === 1 ? '' : 's'} unavailable` : '';
    const header = `[${ctx.tab.id}] find ${JSON.stringify(a.query)}: ${top.length}${all.length > top.length ? ` of ${all.length}+` : ''} hit${top.length === 1 ? '' : 's'}${notAll} (untrusted page content)`;
    // A count with unanswered frames is not a clean one: they are named right under the header.
    const lines: string[] = [header];
    if (unanswered.length > 0) lines.push(`not searched: ${unavailableFrames(unanswered)}; find again, or snapshot`);
    if (top.length === 0) {
      if (unanswered.length === 0) lines.push('(no matches; try a shorter query, another role, or snapshot mode=full)');
      return lines.join('\n');
    }
    const frameLines = new Map<Frame, Promise<string | undefined>>();
    for (const { hit, frame, docId } of top) {
      lines.push(nodeLine(ctx.session, ctx.tab, frame, docId, hit.node));
      // Contract answer 7: a hit inside a frame takes its iframe line as context.
      let context: string | undefined;
      if (frame !== ctx.tab.page.mainFrame()) {
        let p = frameLines.get(frame);
        if (!p) {
          p = iframeLine(ctx, frame);
          frameLines.set(frame, p);
        }
        context = await p;
      }
      if (context === undefined && hit.context) context = nodeLine(ctx.session, ctx.tab, frame, docId, hit.context);
      if (context !== undefined) lines.push(`  in ${context}`);
    }
    return capText(lines.join('\n'), ctx.config.maxOutputChars);
  },
});

/** P9: find hits are engine output: only well-formed hits, their nodes made safe. */
function safeHits(v: unknown): FindHit[] {
  if (!Array.isArray(v)) return [];
  const out: FindHit[] = [];
  for (const h of v as unknown[]) {
    if (h === null || typeof h !== 'object') continue;
    const x = h as Record<string, unknown>;
    const node = safeNode(x.node);
    if (!node || node.role === 'text') continue;
    const hit: FindHit = { node, exact: x.exact === true };
    const context = safeNode(x.context);
    if (context && context.role !== 'text') hit.context = context;
    out.push(hit);
  }
  return out;
}

/** The snapshot line of the iframe element that hosts `frame`, with its ref and frame=fN. */
async function iframeLine(ctx: CallCtx, frame: Frame): Promise<string | undefined> {
  // Round 7b: the parent may be the busy frame; the context line is optional, so it gets one frame budget.
  return inTime(iframeLineOf(ctx, frame), FRAME_BUDGET_MS, undefined);
}

async function iframeLineOf(ctx: CallCtx, frame: Frame): Promise<string | undefined> {
  const parent = frame.parentFrame();
  if (!parent) return undefined;
  try {
    const el = await frame.frameElement();
    // No uniqueness for a context line: it would cost a full document walk (review P4).
    const d = await call(parent, 'describe', el, false);
    await el.dispose().catch(() => undefined);
    const node = safeNode(d.value);
    if (!node) return undefined;
    const ref = issueRef(ctx.session, ctx.tab, parent, d.docId, node);
    return elementLine(0, node.role, node.name, ref, node.attrs, parent.url(), ctx.tab.frameLabel(frame));
  } catch {
    return undefined; // frame detached or navigating
  }
}
