import { z } from 'zod';
import type { NetEntry } from '../browser/tabs.js';
import { ToolError } from '../util/errors.js';
import { capText, clip, escapeServerLines, formatBytes, redactBody, redactHeaders } from '../util/format.js';
import { safeUrl, scrubSecrets } from '../util/secrets.js';
import { matcher } from './common.js';
import { defineTool, tabArg } from './types.js';

const TEXT_CT = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|ld\+json|graphql)|[^;]*\+(json|xml))/i;
export const BODY_CAP = 10000;

export function netLine(e: NetEntry): string {
  const status = e.failure !== undefined ? `failed:${e.failure}` : e.status !== undefined ? String(e.status) : 'pending';
  const ms = e.end !== undefined ? `${e.end - e.start}ms` : 'pending';
  const size = e.size !== undefined ? formatBytes(e.size) : '-';
  return `${e.id} ${e.method} ${status} ${e.type} ${clip(safeUrl(e.url), 300)} ${ms} ${size}`;
}

function headerBlock(h: Record<string, string>): string {
  return Object.entries(redactHeaders(h))
    .map(([k, v]) => `  ${k}: ${clip(v, 500)}`)
    .join('\n');
}

export const network = defineTool({
  name: 'network',
  description:
    'Requests of a tab (at most 1000): "r<n> METHOD status|failed:<reason> type url <ms>ms <size>". Filter by pattern (substring or /regex/), type (document, fetch, xhr, script, …), failed_only (network failures and HTTP >= 400). request_id shows headers (credentials redacted) and the body (text truncated at 10k; binary shows its size).',
  shape: {
    tab: tabArg,
    pattern: z.string().optional(),
    type: z.array(z.string()).optional(),
    failed_only: z.boolean().optional(),
    limit: z.number().int().positive().max(1000).optional().describe('Most recent N, default 50'),
    request_id: z.string().regex(/^r\d+$/).optional(),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  scope: 'tab',
  async handler(a, ctx) {
    const tab = ctx.tab;
    if (a.request_id) {
      const e = tab.entryByRequestId(a.request_id);
      if (!e) throw new ToolError(`no request ${a.request_id} in ${tab.id}`, 'list requests with network first');
      const out: string[] = [`[${tab.id}] ${netLine(e)} (untrusted page content)`];
      out.push('request headers:', headerBlock(await e.request.allHeaders().catch(() => e.request.headers())));
      const post = e.request.postData();
      if (post) {
        const reqCt = (await e.request.headerValue('content-type').catch(() => null)) ?? '';
        out.push(`request body: ${escapeServerLines(clip(redactBody(post, reqCt), BODY_CAP))}`);
      }
      const resp = await e.request.response().catch(() => null);
      if (resp) {
        out.push(`response ${resp.status()} ${resp.statusText()}`, 'response headers:', headerBlock(await resp.allHeaders().catch(() => resp.headers())));
        const ct = (await resp.headerValue('content-type').catch(() => null)) ?? '';
        try {
          const body = await resp.body();
          if (TEXT_CT.test(ct) || ct === '') {
            const txt = escapeServerLines(redactBody(body.toString('utf8'), ct));
            out.push(`response body (${formatBytes(body.length)}):`, txt.length > BODY_CAP ? `${txt.slice(0, BODY_CAP)}\n… truncated ${txt.length - BODY_CAP} chars` : txt);
          } else {
            out.push(`response body: binary ${ct} ${formatBytes(body.length)}`);
          }
        } catch {
          out.push('response body: unavailable (redirect, failed, or evicted)');
        }
      } else if (e.failure) {
        out.push(`failed: ${e.failure}`);
      }
      // Bodies and headers can echo what the server typed into a password field (amendment item 5).
      return capText(scrubSecrets(out.join('\n')), ctx.config.maxOutputChars);
    }
    const m = matcher(a.pattern);
    const types = a.type ? new Set(a.type.map((t) => t.toLowerCase())) : undefined;
    const keep = tab.network.filter((e) => {
      if (types && !types.has(e.type)) return false;
      if (a.failed_only && e.failure === undefined && !(e.status !== undefined && e.status >= 400)) return false;
      return m(e.url);
    });
    const limit = a.limit ?? 50;
    const shown = keep.slice(-limit);
    const header = `[${tab.id}] network: ${shown.length}${keep.length > shown.length ? ` of ${keep.length}` : ''} request${shown.length === 1 ? '' : 's'}`;
    return capText([header, ...shown.map(netLine)].join('\n'), ctx.config.maxOutputChars);
  },
});
