import { resolveTarget, type Target } from '../page/target.js';
import { ToolError } from '../util/errors.js';
import { act, actionError, disposeTargets, frontFor, capMs } from './common.js';
import { defineTool, tabArg, targetArg } from './types.js';

async function center(t: Target, timeout: number): Promise<{ x: number; y: number }> {
  if (t.kind === 'point') return { x: t.x, y: t.y };
  await t.handle.scrollIntoViewIfNeeded({ timeout });
  const b = await t.handle.boundingBox();
  if (!b) throw new ToolError(`${t.desc} has no visible box`, 'take a snapshot and pick a visible element');
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

export const drag = defineTool({
  name: 'drag',
  description: 'Drag from one target to another with real mouse events; works for HTML5 drag-and-drop and pointer-event drags.',
  shape: { from: targetArg, to: targetArg, tab: tabArg },
  annotations: { openWorldHint: true },
  scope: 'tab',
  targetKeys: ['from', 'to'],
  handlesDialog: true,
  async handler(a, ctx) {
    const timeout = ctx.config.actionTimeout;
    await frontFor(ctx, ctx.tab);
    const from = await resolveTarget(ctx.session, ctx.tab, a.from, { timeoutMs: capMs(ctx, timeout) });
    const to = await resolveTarget(ctx.session, ctx.tab, a.to, { timeoutMs: capMs(ctx, timeout) });
    const mouse = ctx.tab.page.mouse;
    return act(ctx, `[${ctx.tab.id}] dragged ${from.desc} -> ${to.desc}`, async () => {
      try {
        if (from.kind === 'element') await from.handle.hover({ timeout: capMs(ctx, timeout) });
        const p1 = await center(from, capMs(ctx, timeout));
        await mouse.move(p1.x, p1.y);
        await mouse.down();
        // A first small move starts the drag (pointer slop), then travel in steps.
        await mouse.move(p1.x + 4, p1.y + 4, { steps: 2 });
        const p2 = await center(to, capMs(ctx, timeout));
        await mouse.move(p2.x, p2.y, { steps: 12 });
        await mouse.move(p2.x + 1, p2.y + 1, { steps: 1 });
        await mouse.up();
      } catch (e) {
        await mouse.up().catch(() => undefined);
        throw actionError(e, from.desc, timeout);
      }
    }).finally(() => disposeTargets(from, to));
  },
});
