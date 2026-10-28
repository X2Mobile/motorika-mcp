import { z } from 'zod';
import { capText, clip, clockTime, continueLines } from '../util/format.js';
import { safeUrl, scrubSecrets } from '../util/secrets.js';
import { matcher } from './common.js';
import { defineTool, tabArg } from './types.js';

/** Each stored message is clipped to this many chars (PLAN amendment item 3). */
export const CONSOLE_MESSAGE_CAP = 4096;

/**
 * One console message as printed: secrets scrubbed, clipped to 4,096 chars with …, and every
 * continuation line prefixed with "  | " so page text cannot forge a server line (amendment item 3).
 */
export function messageText(text: string): string {
  return continueLines(clip(scrubSecrets(text), CONSOLE_MESSAGE_CAP), '  | ');
}

export const console_ = defineTool({
  name: 'console',
  description:
    'Console messages and uncaught page errors of a tab, buffered from tab creation (at most 500): "[level] hh:mm:ss.mmm message (url:line)". level error|warning (warnings and errors)|all; pattern is a substring or /regex/; clear empties the buffer after reading.',
  shape: {
    tab: tabArg,
    level: z.enum(['error', 'warning', 'all']).optional(),
    pattern: z.string().optional(),
    limit: z.number().int().positive().max(500).optional().describe('Most recent N, default 50'),
    clear: z.boolean().optional(),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  scope: 'tab',
  async handler(a, ctx) {
    const tab = ctx.tab;
    const level = a.level ?? 'all';
    const m = matcher(a.pattern);
    const keep = tab.console.filter((c) => {
      if (level === 'error' && c.level !== 'error') return false;
      if (level === 'warning' && c.level !== 'error' && c.level !== 'warning') return false;
      return m(c.text);
    });
    const limit = a.limit ?? 50;
    const shown = keep.slice(-limit);
    if (a.clear) tab.console = [];
    const header = `[${tab.id}] console: ${shown.length}${keep.length > shown.length ? ` of ${keep.length}` : ''} message${shown.length === 1 ? '' : 's'} (untrusted page content)`;
    // Review S2: stop building once the output cap is reached (500 messages of 1 MB each must not be
    // joined first). capText still applies the exact ceiling to what was built.
    const cap = ctx.config.maxOutputChars;
    const parts: string[] = [header];
    let size = header.length;
    for (const c of shown) {
      const loc = c.url ? ` (${safeUrl(c.url)}:${c.line ?? 0})` : '';
      const line = `[${c.level}] ${clockTime(c.time)} ${messageText(c.text)}${loc}`;
      parts.push(line);
      size += line.length + 1;
      if (size > cap) break;
    }
    return capText(parts.join('\n'), cap);
  },
});
