import { z } from 'zod';
import { resolveTarget } from '../page/target.js';
import { ToolError } from '../util/errors.js';
import { safeUrl } from '../util/secrets.js';
import { act, actionError, disposeTargets, frontFor, capMs } from './common.js';
import { defineTool, snapshotArg, tabArg, targetArg, timeoutArg } from './types.js';

const MOD = z.enum(['Alt', 'Control', 'Meta', 'Shift']);

/** Round 7: time kept between a deadline-capped click's own timeout and the call deadline. */
export const CLICK_RESERVE_MS = 150;
/** Round 7: a click left with less time than this (the queue ate the deadline) is not attempted. */
export const MIN_CLICK_MS = 50;

export const click = defineTool({
  name: 'click',
  description:
    'Click a target (ref, "x,y", or selector). Auto-waits for the element to be visible, stable, enabled and not covered. Returns an effect summary (navigation, new tabs, dialogs, downloads, live-region announcements as → alert (not JS dialogs), console errors).',
  shape: {
    target: targetArg,
    tab: tabArg,
    button: z.enum(['left', 'right', 'middle']).optional(),
    count: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
    modifiers: z.array(MOD).optional(),
    force: z.boolean().optional().describe('Skip actionability checks'),
    snapshot: snapshotArg,
    timeout_ms: timeoutArg,
  },
  annotations: { openWorldHint: true },
  scope: 'tab',
  targetKeys: ['target'],
  handlesDialog: true,
  async handler(a, ctx) {
    const timeout = a.timeout_ms ?? ctx.config.actionTimeout;
    await frontFor(ctx, ctx.tab);
    const t = await resolveTarget(ctx.session, ctx.tab, a.target, { timeoutMs: capMs(ctx, timeout) });
    const button = a.button ?? 'left';
    const clickCount = a.count ?? 1;
    const modifiers = a.modifiers ?? [];
    const verb = clickCount === 2 ? 'double-clicked' : clickCount === 3 ? 'triple-clicked' : button === 'right' ? 'right-clicked' : button === 'middle' ? 'middle-clicked' : 'clicked';
    const header = `[${ctx.tab.id}] ${verb} ${t.desc}${t.note ? ` ${t.note}` : ''}`;
    const page = ctx.tab.page;
    return act(
      ctx,
      header,
      async () => {
        try {
          if (t.kind === 'point') {
            for (const m of modifiers) await page.keyboard.down(m);
            try {
              await page.mouse.click(t.x, t.y, { button, clickCount });
            } finally {
              for (const m of modifiers) await page.keyboard.up(m);
            }
          } else {
            // Round 7 (window sweep, busy 3800 ms): a click whose timeout the call deadline cut can dispatch the
            // click and still time out, with no time left to see the navigation it started. So the deadline
            // keeps CLICK_RESERVE_MS after the click's own timeout (room to see that navigation), and a click
            // left with less than MIN_CLICK_MS is not attempted: nothing is clicked, and the error says so.
            const room = Math.min(timeout, capMs(ctx, Number.POSITIVE_INFINITY) - CLICK_RESERVE_MS);
            if (room < MIN_CLICK_MS) {
              throw new ToolError(
                `${t.desc}: not clicked: the call waited behind earlier calls on this tab until no time was left; the tab shows ${safeUrl(page.url())}`,
                'nothing was clicked; click again when the tab is idle, or with a larger timeout_ms',
              );
            }
            await t.handle.click({ button, clickCount, modifiers, force: a.force ?? false, timeout: room, noWaitAfter: true });
          }
        } catch (e) {
          throw actionError(e, t.desc, timeout);
        }
      },
      { snapshot: a.snapshot, budgetMs: capMs(ctx, timeout), timeoutAfterNavRan: true },
    ).finally(() => disposeTargets(t));
  },
});
