import { basename } from 'node:path';
import { z } from 'zod';
import { call } from '../page/engine.js';
import { resolveElement } from '../page/target.js';
import { ToolError } from '../util/errors.js';
import { PathDenied, confineUploadPath } from '../util/paths.js';
import { act, actionError, disposeTargets, frontFor, capMs } from './common.js';
import { defineTool, tabArg, targetArg } from './types.js';

export const upload = defineTool({
  name: 'upload',
  description:
    'Upload files: target is an input[type=file] (files set directly) or an element that opens a file chooser (intercepted; no native dialog appears). Paths must resolve inside the allowed roots (cwd, output dir, ~/Downloads, ~/Desktop, ~/Documents, --allow-file-root); dot-files are refused unless --allow-hidden-files.',
  shape: { target: targetArg, paths: z.array(z.string().min(1)).min(1).max(50), tab: tabArg },
  annotations: { openWorldHint: true },
  scope: 'tab',
  targetKeys: ['target'],
  handlesDialog: true,
  async handler(a, ctx) {
    const timeout = ctx.config.actionTimeout;
    let files: string[];
    try {
      files = a.paths.map((p) => confineUploadPath(p, ctx.config.fileRoots, ctx.config.allowHiddenFiles));
    } catch (e) {
      if (e instanceof PathDenied) throw new ToolError(`upload refused: ${e.reason}`, e.hint);
      throw e;
    }
    await frontFor(ctx, ctx.tab);
    const t = await resolveElement(ctx.session, ctx.tab, a.target, { timeoutMs: capMs(ctx, timeout) });
    const k = (await call(t.frame, 'kind', t.handle)).value;
    const page = ctx.tab.page;
    const names = files.map((f) => basename(f)).join(', ');
    return act(ctx, `[${ctx.tab.id}] uploaded ${names} to ${t.desc}${t.note ? ` ${t.note}` : ''}`, async () => {
      try {
        if (k.tag === 'input' && k.type === 'file') {
          await t.handle.setInputFiles(files, { timeout: capMs(ctx, timeout) });
          return;
        }
        const chooser = page.waitForEvent('filechooser', { timeout: capMs(ctx, timeout) });
        chooser.catch(() => undefined);
        await t.handle.click({ timeout: capMs(ctx, timeout), noWaitAfter: true });
        const fc = await chooser;
        await fc.setFiles(files, { timeout: capMs(ctx, timeout) });
      } catch (e) {
        if (e instanceof Error && /filechooser/.test(e.message)) {
          throw new ToolError(`clicking ${t.desc} opened no file chooser within ${timeout}ms`, 'target the input[type=file] itself (find "file" or snapshot) or the button that opens the chooser');
        }
        throw actionError(e, t.desc, timeout);
      }
    }).finally(() => disposeTargets(t));
  },
});
