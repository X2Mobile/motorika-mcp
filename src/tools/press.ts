import { z } from 'zod';
import { resolveElement } from '../page/target.js';
import { act, actionError, disposeTargets, frontFor, capMs } from './common.js';
import { defineTool, snapshotArg, tabArg } from './types.js';

export const press = defineTool({
  name: 'press',
  description: 'Press keys or chords in order, e.g. ["Tab"], ["Control+a"], ["Meta+Shift+K"], ["ArrowDown","Enter"]. target is focused first.',
  shape: {
    keys: z.array(z.string().min(1)).min(1).max(100),
    target: z.string().optional(),
    tab: tabArg,
    snapshot: snapshotArg,
  },
  annotations: { openWorldHint: true },
  scope: 'tab',
  targetKeys: ['target'],
  handlesDialog: true,
  async handler(a, ctx) {
    const timeout = ctx.config.actionTimeout;
    await frontFor(ctx, ctx.tab);
    const t = a.target ? await resolveElement(ctx.session, ctx.tab, a.target, { timeoutMs: capMs(ctx, timeout) }) : undefined;
    const header = `[${ctx.tab.id}] pressed ${a.keys.join(', ')}${t ? ` in ${t.desc}` : ''}`;
    const kb = ctx.tab.page.keyboard;
    return act(
      ctx,
      header,
      async () => {
        try {
          if (t) await t.handle.focus();
          for (const k of a.keys) await kb.press(k);
        } catch (e) {
          throw actionError(e, t?.desc ?? 'key press', timeout);
        }
      },
      { snapshot: a.snapshot },
    ).finally(() => disposeTargets(t));
  },
});
