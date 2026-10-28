import { z } from 'zod';
import { buildSnapshot, lineLimit, type SnapshotRequest } from '../page/snapshot.js';
import { resolveElement } from '../page/target.js';
import { OUTPUT_RESERVE, pageLines } from '../util/format.js';
import { defineTool, tabArg } from './types.js';
import { capMs } from './common.js';

export const snapshot = defineTool({
  name: 'snapshot',
  description:
    'Compact accessibility snapshot of a tab: one line per element "- role "name" eN attrs", indented by nesting; iframes are inlined. interactive mode (default) lists controls, headings, landmarks, dialogs, alerts; full adds text, lists, tables, images. Page with offset (line offset) when the footer says so.',
  shape: {
    tab: tabArg,
    scope: z.string().optional().describe('Target (ref or selector) to snapshot only that subtree'),
    mode: z.enum(['interactive', 'full']).optional(),
    viewport_only: z.boolean().optional(),
    offset: z.number().int().min(0).optional().describe('Line offset for paging'),
    max_chars: z.number().int().positive().optional(),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  scope: 'tab',
  targetKeys: ['scope'],
  async handler(a, ctx) {
    const req: SnapshotRequest = { mode: a.mode ?? 'interactive', viewportOnly: a.viewport_only ?? false };
    if (a.scope) {
      const t = await resolveElement(ctx.session, ctx.tab, a.scope, { timeoutMs: capMs(ctx, ctx.config.actionTimeout) });
      req.scope = { frame: t.frame, localId: t.node.id };
      void t.handle.dispose().catch(() => undefined);
    }
    const cap = ctx.config.maxOutputChars;
    const max = Math.min(a.max_chars ?? cap - OUTPUT_RESERVE, cap);
    const offset = a.offset ?? 0;
    // Build only what this page can show (review P2/S2); the rest is counted for the footer.
    req.limit = lineLimit(offset, max);
    const snap = await buildSnapshot(ctx.session, ctx.tab, req);
    // --max-output-chars is a hard ceiling on the whole result; the default leaves room for the footer.
    return pageLines(snap.header, snap.lines, offset, max, snap.omitted).text;
  },
});
