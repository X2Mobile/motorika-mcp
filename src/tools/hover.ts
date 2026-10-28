import { resolveTarget } from '../page/target.js';
import { act, actionError, disposeTargets, frontFor, capMs } from './common.js';
import { defineTool, tabArg, targetArg } from './types.js';

export const hover = defineTool({
  name: 'hover',
  description: 'Move the mouse over a target (reveals :hover menus and tooltips).',
  shape: { target: targetArg, tab: tabArg },
  annotations: { openWorldHint: true },
  scope: 'tab',
  targetKeys: ['target'],
  handlesDialog: true,
  async handler(a, ctx) {
    const timeout = ctx.config.actionTimeout;
    await frontFor(ctx, ctx.tab);
    const t = await resolveTarget(ctx.session, ctx.tab, a.target, { timeoutMs: capMs(ctx, timeout) });
    const header = `[${ctx.tab.id}] hovered ${t.desc}${t.note ? ` ${t.note}` : ''}`;
    return act(ctx, header, async () => {
      try {
        if (t.kind === 'point') await ctx.tab.page.mouse.move(t.x, t.y);
        else await t.handle.hover({ timeout: capMs(ctx, timeout) });
      } catch (e) {
        throw actionError(e, t.desc, timeout);
      }
    }).finally(() => disposeTargets(t));
  },
});
