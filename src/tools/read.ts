import { z } from 'zod';
import { callJson } from '../page/engine.js';
import { scrubSecrets } from '../util/secrets.js';
import { resolveElement } from '../page/target.js';
import { OUTPUT_RESERVE, escapeServerLines, pageChars, readFooter, snapshotHeader } from '../util/format.js';
import { defineTool, tabArg } from './types.js';
import { capMs } from './common.js';

export const read = defineTool({
  name: 'read',
  description:
    'Main content of the page (or of target) as markdown: title, headings, paragraphs, lists, links as [text](url), simple tables. Navigation, footers, cookie banners, sidebars and ads are excluded. Long content is cut at max_chars content chars and ends with "… <n> more chars (offset=<m> to continue)"; pass that offset for the next page.',
  shape: {
    tab: tabArg,
    target: z.string().optional(),
    format: z.enum(['markdown', 'text']).optional(),
    offset: z.number().int().min(0).optional().describe('Character offset into the content for paging'),
    max_chars: z.number().int().positive().optional().describe('Content chars per page (default and ceiling: --max-output-chars minus room for the header and footer)'),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  scope: 'tab',
  targetKeys: ['target'],
  async handler(a, ctx) {
    let frame = ctx.tab.page.mainFrame();
    let id: number | null = null;
    if (a.target) {
      const t = await resolveElement(ctx.session, ctx.tab, a.target, { timeoutMs: capMs(ctx, ctx.config.actionTimeout) });
      frame = t.frame;
      id = t.node.id;
      void t.handle.dispose().catch(() => undefined);
    }
    const v = (await callJson(frame, 'read', id, a.format ?? 'markdown')).value as unknown as Record<string, unknown> | null;
    // P9: the engine's answer is untrusted: strings only, and the header URL is Playwright's.
    const r = { title: typeof v?.title === 'string' ? v.title : '', body: typeof v?.body === 'string' ? v.body : '' };
    // Secrets the server typed are scrubbed and server-like lines escaped before paging, so offsets
    // index exactly the text that is shown (PLAN amendment items 3 and 5).
    r.body = escapeServerLines(scrubSecrets(r.body));
    const header = snapshotHeader(ctx.tab.id, r.title, frame.url());
    const offset = a.offset ?? 0;
    if (offset > 0 && offset >= r.body.length) return `${header}\n(no content at offset ${offset}; the content has ${r.body.length} chars)`;
    // max_chars counts content chars, so the next page starts exactly at offset + max_chars (contract
    // answer 9). The header and footer come on top, but the whole result stays within
    // --max-output-chars (a hard ceiling): the default leaves OUTPUT_RESERVE for them.
    const cap = ctx.config.maxOutputChars;
    const ceiling = Math.max(1, cap - header.length - readFooter(r.body.length, r.body.length).length - 3); // 2 line breaks + a page-start escape
    const budget = Math.min(a.max_chars ?? cap - OUTPUT_RESERVE, ceiling);
    const p = pageChars(r.body, offset, budget);
    // Round 4 security re-check: a page starts a line of its own, so a marker the body held mid-line
    // (or just after its escaping backslash) would start a line here. Escaping the page again only
    // changes its start: every other line start was already escaped. Offsets still index r.body.
    let text = `${header}\n${escapeServerLines(p.text)}`;
    if (p.next !== undefined) text += `\n${readFooter(r.body.length - p.next, p.next)}`;
    return text;
  },
});
