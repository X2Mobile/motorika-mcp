import { z } from 'zod';
import { call } from '../page/engine.js';
import type { ScrollState } from '../page/protocol.js';
import { resolveElement } from '../page/target.js';
import { ToolError } from '../util/errors.js';
import { act, actionError, disposeTargets, frontFor, capMs } from './common.js';
import { defineTool, tabArg } from './types.js';

/** P9: the engine's scroll state is untrusted: every field printed is a finite number (else 0). */
function safeState(v: unknown): ScrollState {
  const o = (v !== null && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const n = (k: string): number => {
    const x = o[k];
    return typeof x === 'number' && Number.isFinite(x) ? Math.round(x) : 0;
  };
  return { y: n('y'), x: n('x'), scrollHeight: n('scrollHeight'), scrollWidth: n('scrollWidth'), viewport: n('viewport'), viewportWidth: n('viewportWidth') };
}

export const scroll = defineTool({
  name: 'scroll',
  description:
    'Scroll the page or a container. Without direction/to, target is scrolled into view. With direction (amount px, default 80% of the viewport/container) or to top|bottom, target is the scroll container (default the page). Reports "scrolled y=<y>/<scrollHeight> viewport=<h>" and a height change (infinite scroll).',
  shape: {
    tab: tabArg,
    target: z.string().optional(),
    direction: z.enum(['up', 'down', 'left', 'right']).optional(),
    amount: z.number().positive().optional(),
    to: z.enum(['top', 'bottom']).optional(),
  },
  annotations: { openWorldHint: true },
  scope: 'tab',
  targetKeys: ['target'],
  handlesDialog: true,
  async handler(a, ctx) {
    const timeout = ctx.config.actionTimeout;
    await frontFor(ctx, ctx.tab);
    const t = a.target ? await resolveElement(ctx.session, ctx.tab, a.target, { timeoutMs: capMs(ctx, timeout) }) : undefined;
    const intoView = !a.direction && !a.to;
    if (intoView && !t) {
      throw new ToolError('scroll needs target, direction or to', 'pass direction=down (or to=bottom), or a target to scroll into view');
    }
    const frame = t?.frame ?? ctx.tab.page.mainFrame();
    const containerId = intoView ? null : (t?.node.id ?? null);
    const before = safeState((await call(frame, 'scrollState', containerId)).value);
    let after: ScrollState = before;
    return act(
      ctx,
      () => {
        const height = after.scrollHeight !== before.scrollHeight ? ` height ${before.scrollHeight} -> ${after.scrollHeight}` : '';
        return `[${ctx.tab.id}] scrolled y=${after.y}/${after.scrollHeight} viewport=${after.viewport}${height}`;
      },
      async () => {
        try {
          if (intoView && t) await t.handle.scrollIntoViewIfNeeded({ timeout: capMs(ctx, timeout) });
          else await call(frame, 'scroll', containerId, a.direction ?? null, a.amount ?? null, a.to ?? null);
        } catch (e) {
          throw actionError(e, t?.desc ?? 'scroll', timeout);
        }
      },
    ).then(async (res) => {
      after = safeState((await call(frame, 'scrollState', containerId).catch(() => ({ value: after }))).value);
      const c = res.content[0];
      if (c && c.type === 'text') {
        const nl = c.text.indexOf('\n');
        const height = after.scrollHeight !== before.scrollHeight ? ` height ${before.scrollHeight} -> ${after.scrollHeight}` : '';
        const head = `[${ctx.tab.id}] scrolled y=${after.y}/${after.scrollHeight} viewport=${after.viewport}${height}`;
        res.content[0] = { type: 'text', text: nl < 0 ? head : head + c.text.slice(nl) };
      }
      return res;
    }).finally(() => disposeTargets(t));
  },
});
