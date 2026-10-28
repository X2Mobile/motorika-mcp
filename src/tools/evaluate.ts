import { z } from 'zod';
import type { JSHandle } from 'playwright-core';
import { call } from '../page/engine.js';
import { nodeLine } from '../page/snapshot.js';
import { resolveElement } from '../page/target.js';
import { ToolError, isClosedError } from '../util/errors.js';
import { LINE_BREAK, capText, escapeJsonBreaks, jsonQuote } from '../util/format.js';
import { scrubSecrets } from '../util/secrets.js';
import type { SnapNode } from '../page/protocol.js';
import { defineTool, tabArg } from './types.js';
import { capMs } from './common.js';

const MARKER = /"\\u0000el:(\d+)"/g;

/**
 * Round 4, F2 (the rest of P9): the engine's JSON is untrusted (page code can replace the engine). It is
 * parsed and serialised again, so no raw line break or unquoted text survives; what does not parse is
 * printed as one JSON string. The real engine's output is compact JSON.stringify output, which this leaves
 * unchanged.
 */
export function safeEngineJson(json: unknown): string {
  if (typeof json !== 'string') return 'null';
  try {
    return escapeJsonBreaks(JSON.stringify(JSON.parse(json)) ?? 'null');
  } catch {
    return jsonQuote(json);
  }
}

function pageException(e: unknown): ToolError | undefined {
  if (!(e instanceof Error) || isClosedError(e)) return undefined;
  const msg = e.message.replace(/^(page|frame|jsHandle|elementHandle)\.[A-Za-z]+: /, '');
  const first = msg.split(LINE_BREAK)[0] ?? msg;
  // Round 6 (items 6, 10): page text, JSON-quoted like a name: no raw control (ESC, NUL, DEL) and no quote
  // or ref of the page's outside the string. With a replaced window.eval the whole message is the page's.
  return new ToolError(`page exception: ${jsonQuote(first)}`, 'fix the script and retry');
}

export const evaluate = defineTool({
  name: 'evaluate',
  description:
    'Run JavaScript in the page. script is an expression or a function source; a function is called with the target element (or no argument). Promises are awaited. The result is JSON (truncated); DOM elements are rendered as snapshot lines with refs. Page exceptions are returned as errors.',
  shape: {
    script: z.string().min(1),
    target: z.string().optional(),
    tab: tabArg,
  },
  annotations: { destructiveHint: true, openWorldHint: true },
  scope: 'tab',
  targetKeys: ['target'],
  async handler(a, ctx) {
    const tab = ctx.tab;
    let frame = tab.page.mainFrame();
    const t = a.target ? await resolveElement(ctx.session, tab, a.target, { timeoutMs: capMs(ctx, ctx.config.actionTimeout) }) : undefined;
    if (t) frame = t.frame;
    // Round 3 C6: a script whose promise never settles must not hold the tab past the call's deadline
    // (the queue would wait QUEUE_GRACE_MS for it): the call ends at its own cap with an error.
    const capped = capMs(ctx, ctx.config.actionTimeout);
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new ToolError(`evaluate did not finish within ${capped}ms (a promise that never settles?)`, 'return a value or a promise that settles; poll with wait instead')),
        capped,
      );
    });
    const work = run();
    work.catch(() => undefined);
    try {
      return await Promise.race([work, limit]);
    } finally {
      if (timer) clearTimeout(timer);
      if (t) void t.handle.dispose().catch(() => undefined);
    }
    async function run(): Promise<string> {
      let result: JSHandle;
      try {
        const v = await frame.evaluateHandle(a.script);
        const isFn = await v.evaluate((x) => typeof x === 'function');
        if (isFn) {
          result = t ? await v.evaluateHandle((fn, el) => (fn as (e: Element) => unknown)(el), t.handle) : await v.evaluateHandle((fn) => (fn as () => unknown)());
          await v.dispose().catch(() => undefined);
        } else {
          result = v;
        }
      } catch (e) {
        throw pageException(e) ?? e;
      }
      const ser = await call(frame, 'serialize', result);
      await result.dispose().catch(() => undefined);
      const v = (ser.value !== null && typeof ser.value === 'object' ? ser.value : {}) as { json?: unknown; nodes?: unknown };
      const json = safeEngineJson(v.json);
      const nodes: unknown[] = Array.isArray(v.nodes) ? v.nodes : [];
      const lineFor = (i: number) => {
        const n = nodes[i];
        return n ? nodeLine(ctx.session, tab, frame, ser.docId, n as SnapNode).replace(/^- /, '') : '<element>';
      };
      const single = /^"\\u0000el:(\d+)"$/.exec(json);
      let body: string;
      if (single) body = `- ${lineFor(Number(single[1]))}`;
      else body = json.replace(MARKER, (_m, i: string) => jsonQuote(lineFor(Number(i))));
      const header = `[${tab.id}] evaluate result (untrusted page content):`;
      return capText(`${header}\n${escapeJsonBreaks(scrubSecrets(body))}`, ctx.config.maxOutputChars);
    }
  },
});
