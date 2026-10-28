import { z } from 'zod';
import { call } from '../page/engine.js';
import { resolveElement } from '../page/target.js';
import { rememberSecret } from '../util/secrets.js';
import { act, actionError, frontFor, capMs } from './common.js';
import { defineTool, snapshotArg, tabArg, targetArg, timeoutArg } from './types.js';

export const type = defineTool({
  name: 'type',
  description:
    'Type text into a field (input, textarea, contenteditable). Replaces the value by default; append adds to it; slowly sends key-by-key events (autocomplete widgets); submit presses Enter afterwards. The typed text is never echoed.',
  shape: {
    target: targetArg,
    text: z.string(),
    tab: tabArg,
    append: z.boolean().optional(),
    slowly: z.boolean().optional(),
    submit: z.boolean().optional(),
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
    const t = await resolveElement(ctx.session, ctx.tab, a.target, { timeoutMs: capMs(ctx, timeout) });
    const page = ctx.tab.page;
    // PLAN amendment item 5: remember what we type into a password field before typing it.
    const isPassword = await t.handle.evaluate((el) => el instanceof HTMLInputElement && el.type === 'password').catch(() => false);
    if (isPassword) rememberSecret(a.text);
    // PLAN amendment item 10: no Enter after a dialog opened while typing.
    const dialogAbort = new AbortController();
    let dialog = false;
    void ctx.tab.dialogOpened(dialogAbort.signal).then(() => {
      dialog = true;
    });
    let pressedEnter = false;
    const header = () =>
      `[${ctx.tab.id}] typed into ${t.desc}${t.note ? ` ${t.note}` : ''}${pressedEnter ? ' and pressed Enter' : a.submit && dialog ? '; Enter not pressed (dialog pending)' : ''}`;
    return act(
      ctx,
      header,
      async () => {
        try {
          if (a.append) {
            await t.handle.scrollIntoViewIfNeeded({ timeout: capMs(ctx, timeout) });
            await call(t.frame, 'caretToEnd', t.handle);
            if (a.slowly) await page.keyboard.type(a.text, { delay: 20 });
            else await page.keyboard.insertText(a.text);
          } else if (a.slowly) {
            await t.handle.fill('', { timeout: capMs(ctx, timeout) });
            await t.handle.focus();
            await page.keyboard.type(a.text, { delay: 20 });
          } else {
            await t.handle.fill(a.text, { timeout: capMs(ctx, timeout) });
          }
          if (a.submit && !dialog && !ctx.tab.dialog) {
            await t.handle.press('Enter', { timeout: capMs(ctx, timeout) });
            pressedEnter = true;
          }
        } catch (e) {
          throw actionError(e, t.desc, timeout);
        }
      },
      { snapshot: a.snapshot, budgetMs: capMs(ctx, timeout) },
    ).finally(() => {
      dialogAbort.abort();
      void t.handle.dispose().catch(() => undefined);
    });
  },
});
