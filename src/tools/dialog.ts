import { z } from 'zod';
import { runAction } from '../page/effects.js';
import { ToolError } from '../util/errors.js';
import { jsonQuote } from '../util/format.js';
import { scrubSecrets } from '../util/secrets.js';
import { actionOpts } from './common.js';
import { defineTool, tabArg } from './types.js';

export const dialog = defineTool({
  name: 'dialog',
  description: 'Accept or dismiss the pending JS dialog (confirm, prompt, beforeunload) on a tab; text answers a prompt. Alerts are auto-accepted.',
  shape: {
    action: z.enum(['accept', 'dismiss']),
    text: z.string().optional(),
    tab: tabArg,
  },
  annotations: { openWorldHint: true },
  scope: 'tab',
  handlesDialog: true,
  dialogExempt: () => true,
  async handler(a, ctx) {
    const tab = ctx.tab;
    const d = tab.dialog;
    if (!d) throw new ToolError(`no dialog pending on ${tab.id}`, 'nothing to do; continue with the next step');
    const verb = a.action === 'accept' ? 'accepted' : 'dismissed';
    const header = `[${tab.id}] ${verb} ${d.type} ${jsonQuote(d.message)}`;
    const r = await runAction(
      ctx.session,
      tab,
      header,
      async () => {
        tab.dialog = undefined;
        if (a.action === 'accept') await d.dialog.accept(a.text);
        else await d.dialog.dismiss();
      },
      actionOpts(ctx, { noBaseline: true }),
    );
    return scrubSecrets(r.text);
  },
});
