import { z } from 'zod';
import type { ElementHandle } from 'playwright-core';
import { call, handleFor } from '../page/engine.js';
import type { ElementKind } from '../page/protocol.js';
import { parseRef, resolveElement, resolveTarget, type Target } from '../page/target.js';
import { ToolError, firstLine } from '../util/errors.js';
import { ELLIPSIS, capText, jsonQuote, q, safeRole } from '../util/format.js';
import { PathDenied, confineUploadPath } from '../util/paths.js';
import { rememberSecret } from '../util/secrets.js';
import type { Config } from '../config.js';
import { act, actionError, capMs, frontFor } from './common.js';
import { defineTool, snapshotArg, tabArg, timeoutArg } from './types.js';

type Value = string | boolean | string[];
type El = Extract<Target, { kind: 'element' }>;

const SET_VALUE_TYPES = new Set(['date', 'time', 'datetime-local', 'month', 'week', 'color', 'range']);
const TEXT_TYPES = new Set(['text', 'email', 'password', 'search', 'tel', 'url', 'number', '']);

function asBool(v: Value, what: string): boolean {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw new ToolError(`${what} needs true or false`, 'pass a boolean value');
}

/**
 * Fix round 5 (sec): the element's tag and input type come from the engine, which page code can replace.
 * They are printed only as bare tokens; anything else prints as `element`.
 */
const TAG_TOKEN = /^[a-z][a-z0-9-]{0,63}$/;
export function kindLabel(k: Pick<ElementKind, 'tag' | 'type'>): string {
  if (typeof k.tag !== 'string' || !TAG_TOKEN.test(k.tag)) return 'element';
  const type = typeof k.type === 'string' && TAG_TOKEN.test(k.type) ? ` type=${k.type}` : '';
  return `<${k.tag}${type}>`;
}

export function optionsHint(labels: string[]): string {
  // Option labels are page text: scrubbed, clipped and JSON-quoted (all 7 separators escaped).
  const shown = labels.slice(0, 10).map((l) => q(typeof l === 'string' ? l : ''));
  if (labels.length > 10) shown.push(`${ELLIPSIS} +${labels.length - 10}`);
  return shown.join(', ');
}

/** Match requested select values against options by value, then label (exact, then case-insensitive). */
export function matchOptions(options: { value: string; label: string }[], wanted: string[]): { values: string[]; missing: string | undefined } {
  const values: string[] = [];
  for (const w of wanted) {
    const o =
      options.find((x) => x.value === w) ??
      options.find((x) => x.label === w) ??
      options.find((x) => x.label.toLowerCase() === w.toLowerCase() || x.value.toLowerCase() === w.toLowerCase());
    if (!o) return { values, missing: w };
    values.push(o.value);
  }
  return { values, missing: undefined };
}

async function setCheck(t: El, k: ElementKind, want: boolean, timeout: number): Promise<void> {
  if (k.checked === want) return;
  if (k.visible) {
    if (k.tag === 'input') await t.handle.setChecked(want, { timeout });
    else await t.handle.click({ timeout, noWaitAfter: true });
    return;
  }
  if (k.labelId !== undefined) {
    const label = await handleFor(t.frame, k.labelId);
    if (label) {
      try {
        await label.click({ timeout, noWaitAfter: true });
      } finally {
        await label.dispose().catch(() => undefined);
      }
      return;
    }
  }
  await t.handle.setChecked(want, { timeout, force: true });
}

/** Check the group member whose label or value is `value` (exact, then case-insensitive label). */
async function pickRadio(t: El, group: NonNullable<ElementKind['group']>, value: string, timeout: number): Promise<void> {
  const g = group.find((m) => m.label === value || m.value === value) ?? group.find((m) => m.label.toLowerCase() === value.toLowerCase());
  if (!g) {
    throw new ToolError(`no radio option ${jsonQuote(value)} (options: ${optionsHint(group.map((m) => m.label || m.value))})`, 'use one of the listed options');
  }
  const h = (await handleFor(t.frame, g.id)) as ElementHandle<Element> | null;
  if (!h) throw new ToolError('the radio option disappeared', 'take a new snapshot');
  try {
    const gk = (await call(t.frame, 'kind', h)).value;
    await setCheck({ ...t, handle: h }, gk, true, timeout);
  } finally {
    await h.dispose().catch(() => undefined);
  }
}

/** A field's target as printed when it has no resolved element: a ref bare, anything else JSON-quoted. */
function targetLabel(target: string): string {
  return parseRef(target) !== null ? target.trim() : JSON.stringify(target);
}

/**
 * `begin` runs right before the first page-changing call; it throws when the field was cancelled (a
 * dialog or the deadline cut the form short), so a fill still resolving its target never lands later.
 */
async function fillOne(t: El, value: Value, config: Config, timeout: number, begin: () => void): Promise<void> {
  const k = (await call(t.frame, 'kind', t.handle)).value;
  begin();
  const what = t.desc;
  const role = k.role || t.node.role;
  if (k.tag === 'input' && k.type === 'file') {
    let paths: string[];
    try {
      paths = (Array.isArray(value) ? value : [String(value)]).map((p) => confineUploadPath(p, config.fileRoots, config.allowHiddenFiles));
    } catch (e) {
      if (e instanceof PathDenied) throw new ToolError(`upload refused: ${e.reason} (${e.hint})`, e.hint);
      throw e;
    }
    await t.handle.setInputFiles(paths, { timeout });
    return;
  }
  if (k.tag === 'select') {
    const wanted = Array.isArray(value) ? value : [String(value)];
    if (wanted.length > 1 && !k.multiple) throw new ToolError('several values for a single select', 'pass one string');
    const opts = k.options ?? [];
    const m = matchOptions(opts, wanted);
    if (m.missing !== undefined) {
      throw new ToolError(`no option ${jsonQuote(m.missing)} (options: ${optionsHint(opts.map((o) => o.label))})`, 'use one of the listed options');
    }
    await t.handle.selectOption(m.values, { timeout });
    return;
  }
  if ((k.tag === 'input' && k.type === 'checkbox') || role === 'checkbox' || role === 'switch' || role === 'menuitemcheckbox') {
    await setCheck(t, k, asBool(value, what), timeout);
    return;
  }
  if (k.radioGroup && k.group) {
    // Contract answer 11: the target is the fieldset/radiogroup; the value picks one of its radios.
    if (typeof value !== 'string') throw new ToolError('a radio group needs the label or value of the radio to pick', 'pass a string value');
    await pickRadio(t, k.group, value, timeout);
    return;
  }
  if ((k.tag === 'input' && k.type === 'radio') || role === 'radio') {
    if (typeof value === 'string' && value !== 'true' && value !== 'false' && k.group) {
      await pickRadio(t, k.group, value, timeout);
      return;
    }
    const want = asBool(Array.isArray(value) ? 'x' : value, what);
    if (!want) throw new ToolError('a radio cannot be unchecked directly', 'select another option of the group');
    await setCheck(t, k, true, timeout);
    return;
  }
  if (Array.isArray(value) || typeof value === 'boolean') throw new ToolError(`${safeRole(t.node.role)} needs a string value`, 'pass a string');
  if (k.tag === 'input' && SET_VALUE_TYPES.has(k.type)) {
    await call(t.frame, 'setValue', t.handle, value);
    return;
  }
  // PLAN amendment item 5: a value typed into a password field is printed as <redacted> from now on.
  if (k.tag === 'input' && k.type === 'password') rememberSecret(value);
  if (k.tag === 'textarea' || k.contentEditable || (k.tag === 'input' && TEXT_TYPES.has(k.type)) || role === 'textbox' || role === 'searchbox' || role === 'combobox' || role === 'spinbutton') {
    await t.handle.fill(value, { timeout });
    return;
  }
  throw new ToolError(`${safeRole(t.node.role)} ${kindLabel(k)} is not a fillable field`, 'use click or type for this element');
}

export const fill_form = defineTool({
  name: 'fill_form',
  description:
    'Fill several fields in one call and optionally click submit (only if every field succeeded). Values: text-like fields take a string (replaced); select takes an option value or label (string[] for multiple); checkbox/switch take a boolean; radio takes true, or a label/value on any radio of the group; file inputs take path(s) inside the allowed roots; date/time/color/range take the string value. One result line per field; values are never echoed.',
  shape: {
    fields: z
      .array(z.object({ target: z.string().min(1), value: z.union([z.string(), z.boolean(), z.array(z.string())]) }))
      .min(1)
      .max(100),
    submit: z.string().optional().describe('Target to click after all fields succeeded'),
    tab: tabArg,
    snapshot: snapshotArg,
    timeout_ms: timeoutArg,
  },
  annotations: { openWorldHint: true },
  scope: 'tab',
  targetKeys: ['fields', 'submit'],
  handlesDialog: true,
  // Contract answer 1: one budget (timeout_ms, else the action timeout) shared by all fields and submit.
  timeoutMs: (a, c) => a.timeout_ms ?? c.actionTimeout,
  async handler(a, ctx) {
    const timeout = a.timeout_ms ?? ctx.config.actionTimeout;
    // The call's own budget, but never past the dispatcher's deadline counted from arrival (item 9).
    const deadline = Math.min(Date.now() + timeout, ctx.deadlineAt ?? Number.POSITIVE_INFINITY);
    /** What remains of the call budget; never 0, which Playwright reads as "no timeout". */
    const remaining = () => capMs(ctx, Math.max(1, deadline - Date.now()));
    await frontFor(ctx, ctx.tab);
    const lines: string[] = [];
    let failed = 0;
    let attempted = 0;
    let notAttempted = 0;
    let submitDesc = '';
    let submitSkipped = false;
    return act(
      ctx,
      () => {
        const head =
          `[${ctx.tab.id}] filled ${attempted - failed}/${attempted} fields` +
          (notAttempted > 0 ? `; ${notAttempted} not attempted (dialog pending)` : '') +
          (submitDesc ? ` and clicked ${submitDesc}` : '') +
          (submitSkipped ? '; submit not clicked (dialog pending)' : '');
        // Many fields can outgrow --max-output-chars; leave room for an attached snapshot's minimum.
        const cap = Math.max(200, ctx.config.maxOutputChars - 400);
        if (failed === 0) return capText([head, ...lines].join('\n'), cap);
        // Contract answer 2: line 1 is the cause, line 2 the hint; the per-field lines follow.
        const cause = `${head}; ${failed} field${failed === 1 ? '' : 's'} failed${a.submit && !submitSkipped ? ', submit not clicked' : ''}`;
        return capText([cause, 'hint: fix the failed fields (see the lines below) and retry', ...lines].join('\n'), cap);
      },
      async () => {
        // PLAN amendment item 10: stop at the first dialog. Later fields are not attempted and submit is
        // not clicked, so nothing keeps acting on the page after the result reports the dialog.
        const dialogAbort = new AbortController();
        let dialog = false;
        const dialogP = ctx.tab.dialogOpened(dialogAbort.signal).then(() => {
          dialog = true;
          return 'dialog' as const;
        });
        const stopRest = (from: number) => {
          for (const f of a.fields.slice(from)) {
            notAttempted++;
            lines.push(`skipped ${targetLabel(f.target)}: not attempted (dialog pending)`);
          }
        };
        try {
          for (const [i, f] of a.fields.entries()) {
            if (dialog || ctx.tab.dialog) {
              stopRest(i);
              break;
            }
            if (deadline - Date.now() <= 0) {
              // Never got a turn: the shared call budget is spent (item 9: no page action after it).
              attempted++;
              failed++;
              lines.push(`failed ${targetLabel(f.target)}: timed out (call budget)`);
              continue;
            }
            attempted++;
            let t: El | undefined;
            // Re-check item 8: a field is `ok` only when its fill really ran; one cut short never lands.
            let started = false;
            let cancelled = false;
            const begin = () => {
              if (cancelled || ctx.tab.dialog) {
                cancelled = true;
                throw new ToolError('fill cancelled (dialog pending)', 'handle the dialog, then fill again');
              }
              started = true;
            };
            const fieldBudget = remaining();
            const step = (async () => {
              t = await resolveElement(ctx.session, ctx.tab, f.target, { timeoutMs: fieldBudget });
              try {
                await fillOne(t, f.value, ctx.config, remaining(), begin);
              } finally {
                await t.handle.dispose().catch(() => undefined);
              }
            })();
            step.catch(() => undefined);
            try {
              const r = await Promise.race([step.then(() => 'done' as const), dialogP]);
              if (r === 'dialog') {
                if (!started) {
                  // The dialog came while the field was still being resolved: it was never filled, and
                  // it must not be filled after the dialog is handled.
                  cancelled = true;
                  attempted--;
                  stopRest(i);
                  break;
                }
                // The field's own handler raised the dialog: its value was set.
                lines.push(`ok ${t ? (t as El).desc : targetLabel(f.target)} (a dialog opened)`);
                stopRest(i + 1);
                break;
              }
              const done = t as El | undefined;
              lines.push(`ok ${done ? `${done.desc}${done.note ? ` ${done.note}` : ''}` : targetLabel(f.target)}`);
            } catch (e) {
              failed++;
              const tt = t as El | undefined;
              const err = e instanceof ToolError ? e : actionError(e, tt?.desc ?? f.target, fieldBudget);
              const reason = err instanceof ToolError ? err.cause1 : firstLine(err);
              // Strip the element description the cause starts with (it is already on the line).
              const shown = tt && reason.startsWith(`${tt.desc} `) ? reason.slice(tt.desc.length + 1) : reason;
              lines.push(`failed ${tt ? tt.desc : targetLabel(f.target)}: ${shown}`);
            }
          }
          if (a.submit && failed === 0) {
            if (dialog || ctx.tab.dialog) {
              submitSkipped = true;
              return;
            }
            if (deadline - Date.now() <= 0) {
              throw new ToolError(`submit not clicked: the call budget of ${timeout}ms ran out after the fields`, 'retry with a larger timeout_ms, or click submit next');
            }
            const s = await resolveTarget(ctx.session, ctx.tab, a.submit, { timeoutMs: remaining() });
            submitDesc = s.desc;
            try {
              if (s.kind === 'point') await ctx.tab.page.mouse.click(s.x, s.y);
              else await s.handle.click({ timeout: remaining(), noWaitAfter: true });
            } catch (e) {
              throw actionError(e, s.desc, timeout);
            } finally {
              if (s.kind === 'element') await s.handle.dispose().catch(() => undefined);
            }
          }
        } finally {
          dialogAbort.abort();
        }
      },
      { snapshot: a.snapshot, budgetMs: capMs(ctx, timeout) },
    ).then((r) => (failed > 0 ? { ...r, isError: true } : r));
  },
});
