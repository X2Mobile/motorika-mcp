import { z } from 'zod';
import { ELLIPSIS, cutResultLine, cutResultText } from '../util/format.js';
import { defineTool, type Content, type ToolResult } from './types.js';

export const MAX_STEPS = 50;

/** One step as it ran: its result, or skipped after a failure (stop_on_error). */
export interface StepRun {
  n: number;
  tool: string;
  result?: ToolResult;
}

/** The note that ends a step body cut by the shared cap (PLAN amendment 2026-10-26). */
export const BATCH_CUT_NOTE = (k: number, n: number): string =>
  `${ELLIPSIS} ${k} chars cut from step ${n} (rerun it alone, or use read/snapshot with offset)`;

const headerOf = (s: StepRun): string => `## step ${s.n}: ${s.tool}${s.result?.isError ? ' (error)' : ''}`;

/** The batch output as it is when nothing is cut: each step under its header, images kept. */
export function layoutSteps(steps: StepRun[]): Content[] {
  const content: Content[] = [];
  for (const s of steps) {
    if (!s.result) {
      content.push({ type: 'text', text: `${headerOf(s)}\nskipped` });
      continue;
    }
    let first = true;
    for (const c of s.result.content) {
      if (first && c.type === 'text') {
        content.push({ type: 'text', text: `${headerOf(s)}\n${c.text}` });
        first = false;
      } else {
        if (first) {
          content.push({ type: 'text', text: headerOf(s) });
          first = false;
        }
        content.push(c);
      }
    }
  }
  return content;
}

/**
 * The text size a consumer sees: every text part, and one separator between two text parts (clients join
 * the parts with a newline). Images are not text.
 */
export function textSize(content: Content[]): number {
  const texts = content.filter((c) => c.type === 'text');
  return texts.reduce((n, c) => n + c.text.length, 0) + Math.max(0, texts.length - 1);
}

/** A step split into the part that is always shown (`head`) and the rest, which shares the budget. */
/**
 * A piece of a step's output after its head: an image; the pinned first line(s) of a result whose first
 * part is an image (shown always, in the fixed part); or text of the rest, which shares the budget.
 */
type Seg =
  | { kind: 'img'; c: Content }
  | { kind: 'pin'; text: string }
  | { kind: 'text'; text: string; cont: boolean; own: boolean };

interface Model {
  s: StepRun;
  head: string;
  segs: Seg[];
  /** Chars always shown: the head, and a pinned line as its own part (with its separator). */
  fixed: number;
  /** Text size of the rest: each text costs its length plus one (its newline or its part separator). */
  rest: number;
}

/** How many leading lines of a result's first text are its "first line": an error's cause through hint. */
function firstLines(lines: string[], isError: boolean | undefined, keepFirst: boolean): number {
  if (isError) {
    const hint = lines.findIndex((l) => l.startsWith('hint: '));
    return hint >= 0 ? hint + 1 : 1;
  }
  return keepFirst ? 1 : 0;
}

function model(s: StepRun, keepFirst: boolean): Model {
  const h = headerOf(s);
  if (!s.result) return { s, head: `${h}\nskipped`, segs: [], fixed: h.length + 8, rest: 0 };
  const parts = s.result.content;
  // The result's first text: its first line(s) are the step's own (AC1), wherever that text sits.
  const ft = parts.findIndex((c) => c.type === 'text');
  let head = h;
  const segs: Seg[] = [];
  parts.forEach((c, i) => {
    if (c.type !== 'text') {
      segs.push({ kind: 'img', c });
      return;
    }
    if (i !== ft) {
      segs.push({ kind: 'text', text: c.text, cont: false, own: false });
      return;
    }
    const lines = c.text.split('\n');
    const k = firstLines(lines, s.result?.isError, keepFirst);
    const restText = lines.slice(k).join('\n');
    if (k > 0 && i === 0) head = `${h}\n${lines.slice(0, k).join('\n')}`;
    // Review of dc80dfe, item 2: after an image, the first line(s) are pinned as their own part.
    else if (k > 0) segs.push({ kind: 'pin', text: lines.slice(0, k).join('\n') });
    if (k < lines.length) segs.push({ kind: 'text', text: restText, cont: k > 0 || i === 0, own: k === 0 });
  });
  const pin = segs.reduce((n, x) => n + (x.kind === 'pin' ? 1 + x.text.length : 0), 0);
  const rest = segs.reduce((n, x) => n + (x.kind === 'text' ? x.text.length + 1 : 0), 0);
  return { s, head, segs, fixed: head.length + pin, rest };
}

/** Max-min fair shares of `budget` over `demands`: a demand under the even share is met whole. */
function waterFill(budget: number, demands: number[]): number[] {
  const order = demands.map((d, i) => [d, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(demands.length).fill(0);
  let left = Math.max(0, budget);
  order.forEach(([d, i], j) => {
    const a = Math.min(d, Math.floor(left / (order.length - j)));
    out[i] = a;
    left -= a;
  });
  return out;
}

const noteCost = (m: Model): number => 2 + BATCH_CUT_NOTE(m.rest, m.s.n).length;

/** The rest of one step within `room` chars: its parts (head first) and the chars of the rest used. */
function fill(m: Model, room: number): { out: Content[]; cur: string | null; used: number } {
  const out: Content[] = [];
  let cur: string | null = m.head;
  let used = 0;
  let stopped = false;
  const open = (text: string): void => {
    if (cur !== null) out.push({ type: 'text', text: cur });
    cur = text;
  };
  for (const seg of m.segs) {
    if (seg.kind === 'img') {
      // Images are kept as they are.
      if (cur !== null) out.push({ type: 'text', text: cur });
      cur = null;
      out.push(seg.c);
      continue;
    }
    if (seg.kind === 'pin') {
      open(seg.text);
      continue;
    }
    if (stopped) continue;
    let text = seg.text;
    if (used + 1 + text.length > room) {
      text = cutResultText(text, room - used - 1, seg.own);
      stopped = true;
      if (text === '') continue;
    }
    used += 1 + text.length;
    // A continuation goes on the head's (or the pinned line's) part; any other text is its own part.
    if (seg.cont && cur !== null) cur = `${cur}\n${text}`;
    else open(text);
  }
  return { out, cur, used };
}

/** One step's output with `room` chars of its rest; a cut one ends with its note (reserved apart). */
function emit(m: Model, room: number): Content[] {
  const { out, cur, used } = fill(m, room);
  let last = cur;
  if (used < m.rest) {
    const note = BATCH_CUT_NOTE(m.rest - used, m.s.n);
    // A blank line before the note: it ends an attached snapshot block, and it separates the note from
    // an image between the body and the note (review of cc50db4, item 4).
    last = last === null ? `\n${note}` : `${last}\n\n${note}`;
  }
  if (last !== null) out.push({ type: 'text', text: last });
  return out;
}

function shareWith(steps: StepRun[], max: number, keepFirst: boolean): Content[] | null {
  const models = steps.map((s) => model(s, keepFirst));
  const fixed = models.reduce((n, m) => n + m.fixed, 0) + Math.max(0, models.length - 1);
  const budget = max - fixed;
  if (budget < 0) return null;
  // The cut set only grows, so this ends within steps.length rounds; each cut step's note is reserved.
  const cut = new Set<number>();
  let room = budget;
  let shares: number[] = [];
  for (;;) {
    room = budget - [...cut].reduce((n, i) => n + noteCost(models[i] as Model), 0);
    if (room < 0) return null;
    shares = waterFill(room, models.map((m) => m.rest));
    const before = cut.size;
    shares.forEach((a, i) => {
      if (a < (models[i] as Model).rest) cut.add(i);
    });
    if (cut.size === before) break;
  }
  // Review of cc50db4, item 2: a share a step cannot use (a line dropped at its cut, a rounding rest)
  // goes to the steps still cut, until nothing more is taken. Allowances are rebased on what each step
  // used, so their sum never passes `room`.
  let used = models.map((m, i) => fill(m, shares[i] ?? 0).used);
  for (let round = 0; round < 8; round++) {
    const free = room - used.reduce((n, u) => n + u, 0);
    const open = models.map((m, i) => i).filter((i) => (used[i] ?? 0) < (models[i] as Model).rest);
    if (free <= 0 || open.length === 0) break;
    const extra = waterFill(free, open.map((i) => (models[i] as Model).rest - (used[i] ?? 0)));
    const next = [...used];
    open.forEach((i, j) => {
      shares[i] = (used[i] ?? 0) + (extra[j] ?? 0);
      next[i] = fill(models[i] as Model, shares[i] ?? 0).used;
    });
    if (next.every((u, i) => u === used[i])) break;
    used = next;
  }
  return models.flatMap((m, i) => emit(m, shares[i] ?? 0));
}

/** `1-5, 7, 9-12` */
function ranges(ns: number[]): string {
  const out: string[] = [];
  for (let i = 0; i < ns.length; i++) {
    const a = ns[i] as number;
    let b = a;
    while (ns[i + 1] === b + 1) b = ns[++i] as number;
    out.push(a === b ? `${a}` : `${a}-${b}`);
  }
  return out.join(', ');
}

/** The closing line of the headers-only fallback: the steps whose output (or header) did not fit. */
export const NO_ROOM_LINE = (ns: number[]): string =>
  ns.length === 1 ? `${ELLIPSIS} step ${ns[0]}: no room; rerun it` : `${ELLIPSIS} steps ${ranges(ns)}: no room; rerun them`;

/**
 * Review of cc50db4, item 1: when not even the headers and the cut notes fit, as many whole headers as fit
 * (in order, each with its images; a skipped step with `skipped`), then one line naming every step whose
 * output was not fully shown or that got no header. A header is never cut. Review of dc80dfe, item 1: when
 * every header fits, the room left goes first to the errors' cause and hint lines (whole, in step order),
 * then max-min fairly to the other steps' first lines (clipped). null when not even the line fits.
 */
function headersOnly(steps: StepRun[], max: number): Content[] | null {
  const heads = steps.map((s) => (s.result ? headerOf(s) : `${headerOf(s)}\nskipped`));
  const texts = steps.map((s) => (s.result?.content ?? []).filter((c) => c.type === 'text').map((c) => (c as { text: string }).text));
  const firsts = steps.map((s, i) => {
    const lines = (texts[i]?.[0] ?? '').split('\n');
    return texts[i]?.length ? lines.slice(0, firstLines(lines, s.result?.isError, true)).join('\n') : '';
  });
  const build = (k: number, extras: string[]): { out: Content[]; size: number } | null => {
    // A step's output is fully shown when its only text is the extra shown.
    const lost = steps
      .filter((s, i) => i >= k || ((texts[i]?.length ?? 0) > 0 && !((texts[i]?.length ?? 0) === 1 && extras[i] === texts[i]?.[0])))
      .map((s) => s.n);
    const line = lost.length > 0 ? NO_ROOM_LINE(lost) : null;
    const out: Content[] = [];
    steps.slice(0, k).forEach((s, i) => {
      out.push({ type: 'text', text: extras[i] ? `${heads[i]}\n${extras[i]}` : (heads[i] as string) });
      for (const c of s.result?.content ?? []) if (c.type !== 'text') out.push(c);
    });
    if (line !== null) out.push({ type: 'text', text: line });
    const size = textSize(out);
    return size <= max ? { out, size } : null;
  };
  const none = steps.map(() => '');
  for (let k = steps.length; k >= 0; k--) {
    const base = build(k, none);
    if (!base) continue;
    if (k < steps.length) return base.out;
    // Every header fits: spend the room left on the errors first, then on the first lines.
    const extras = [...none];
    let free = max - base.size;
    steps.forEach((s, i) => {
      const f = firsts[i] ?? '';
      if (s.result?.isError && f !== '' && 1 + f.length <= free) {
        extras[i] = f;
        free -= 1 + f.length;
      }
    });
    const others = steps.map((s, i) => i).filter((i) => !steps[i]?.result?.isError && (firsts[i] ?? '') !== '');
    const shares = waterFill(free, others.map((i) => 1 + (firsts[i] ?? '').length));
    others.forEach((i, j) => {
      extras[i] = cutResultLine(firsts[i] ?? '', (shares[j] ?? 0) - 1, true);
    });
    // The no-room line can grow (a step fully shown splits a range): give back first lines, last first.
    for (let drop = others.length; drop >= 0; drop--) {
      const tried = build(k, extras.map((x, i) => (others.indexOf(i) >= drop ? '' : x)));
      if (tried) return tried.out;
    }
    return build(k, extras.map((x, i) => (steps[i]?.result?.isError ? x : '')))?.out ?? base.out;
  }
  return null;
}

/**
 * PLAN amendment 2026-10-26 (batch shares the output cap per step). When the steps' output fits in `max`
 * it is returned exactly as before. Otherwise every step keeps its header and the first line of its result
 * (an error: its cause and hint lines; a skipped step: `skipped`), and the rest of `max` is shared max-min
 * fairly over the steps' remaining text: a step whose rest is under the even share keeps it whole, the
 * others are cut at a grammar-safe point and end with BATCH_CUT_NOTE; a share a step cannot use goes to
 * the others. Images are kept. If the first lines do not fit, they share the budget too (clipped, never
 * dropped; an error keeps its cause and hint). Below that, whole headers and one NO_ROOM_LINE; when every
 * header fits, the room left goes to the errors' cause and hint, then to the first lines (headersOnly).
 */
export function shareOutput(steps: StepRun[], max: number): Content[] {
  const plain = layoutSteps(steps);
  if (textSize(plain) <= max) return plain;
  return shareWith(steps, max, true) ?? shareWith(steps, max, false) ?? headersOnly(steps, max) ?? plain;
}

export const batch = defineTool({
  name: 'batch',
  description:
    'Run up to 50 tool calls sequentially in one call: steps [{tool, args}]. Each step\'s output is under "## step <n>: <tool>" (images kept). stop_on_error (default true) lists the remaining steps as skipped after a failure. Over the output cap, every step keeps its header and first line and the rest is shared; a cut step ends with "… <k> chars cut from step <n>". batch cannot nest.',
  shape: {
    steps: z
      .array(z.object({ tool: z.string().min(1), args: z.record(z.string(), z.unknown()).optional() }))
      .min(1)
      .max(MAX_STEPS),
    stop_on_error: z.boolean().optional(),
  },
  annotations: { openWorldHint: true },
  scope: 'free',
  needsBrowser: () => false,
  timeoutMs: (a, c) => a.steps.length * (c.navigationTimeout + 4000),
  async handler(a, ctx) {
    const stop = a.stop_on_error ?? true;
    const runs: StepRun[] = [];
    let failed = 0;
    let stopped = false;
    for (let i = 0; i < a.steps.length; i++) {
      const step = a.steps[i];
      if (!step) continue;
      const n = i + 1;
      if (stopped) {
        runs.push({ n, tool: step.tool });
        continue;
      }
      const r = await ctx.dispatch(step.tool, step.args ?? {});
      runs.push({ n, tool: step.tool, result: r });
      if (r.isError) {
        failed++;
        if (stop) stopped = true;
      }
    }
    // The dispatcher puts the client's pending notices in front of this result before its cap: room for them.
    const notices = ctx.client.notices.length > 0 ? ctx.client.notices.join('\n').length + 1 : 0;
    const content = shareOutput(runs, ctx.config.maxOutputChars - notices);
    if (failed > 0 && stop) return { content, isError: true };
    return { content };
  },
});
