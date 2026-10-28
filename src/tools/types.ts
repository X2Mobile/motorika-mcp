// Tool definition: one file per tool exporting a Tool built with defineTool().
import { z } from 'zod';
import type { Session } from '../browser/session.js';
import type { Client, Tab } from '../browser/tabs.js';
import type { Config } from '../config.js';
import { ToolError } from '../util/errors.js';

export type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

export interface ToolResult {
  content: Content[];
  isError?: boolean;
}

export interface Annotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
  idempotentHint?: boolean;
}

export interface CallCtx {
  session: Session;
  config: Config;
  client: Client;
  /** The resolved tab for tab-scoped tools. */
  tab: Tab;
  /** Dispatch another tool (batch). */
  dispatch: (name: string, args: unknown) => Promise<ToolResult>;
  /** Absolute deadline of this call (epoch ms), counted from its arrival (PLAN review item 9). */
  deadlineAt?: number;
}

/**
 * scope:
 * - 'tab': the call targets one tab (resolved from refs, `tab`, or the active tab) and runs in its queue.
 * - 'free': no tab routing; the handler manages the browser itself (session, tabs, batch, dialog).
 */
export interface ToolSpec<S extends z.ZodRawShape> {
  name: string;
  title?: string;
  description: string;
  shape: S;
  annotations: Annotations;
  scope: 'tab' | 'free';
  /** Arg names holding targets whose refs route the call to their tab. */
  targetKeys?: string[];
  /** Action tools race the dialog themselves (effect summary reports `dialog pending`). */
  handlesDialog?: boolean;
  /** Allowed while a dialog is pending on the tab (and bypasses the tab queue). */
  dialogExempt?: (args: z.infer<z.ZodObject<S>>) => boolean;
  /** Per-call timeout in ms (the dispatcher guarantees a result by timeout + 1.9 s). */
  timeoutMs?: (args: z.infer<z.ZodObject<S>>, config: Config) => number;
  /** Does this call need the browser started (false for e.g. session status). */
  needsBrowser?: (args: z.infer<z.ZodObject<S>>) => boolean;
  handler: (args: z.infer<z.ZodObject<S>>, ctx: CallCtx) => Promise<ToolResult | string>;
}

export interface Tool {
  name: string;
  title: string | undefined;
  description: string;
  shape: z.ZodRawShape;
  annotations: Annotations;
  scope: 'tab' | 'free';
  targetKeys: string[];
  handlesDialog: boolean;
  parse(raw: unknown): Record<string, unknown>;
  dialogExempt(args: Record<string, unknown>): boolean;
  timeoutMs(args: Record<string, unknown>, config: Config): number;
  needsBrowser(args: Record<string, unknown>): boolean;
  run(args: Record<string, unknown>, ctx: CallCtx): Promise<ToolResult>;
}

function issuesText(e: z.ZodError): string {
  return e.issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.') || 'args'}: ${i.message}`)
    .join('; ');
}

export function defineTool<S extends z.ZodRawShape>(spec: ToolSpec<S>): Tool {
  const schema = z.object(spec.shape);
  type A = z.infer<typeof schema>;
  const cast = (a: Record<string, unknown>) => a as A;
  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    shape: spec.shape,
    annotations: spec.annotations,
    scope: spec.scope,
    targetKeys: spec.targetKeys ?? [],
    handlesDialog: spec.handlesDialog ?? false,
    parse(raw) {
      const r = schema.safeParse(raw ?? {});
      if (!r.success) throw new ToolError(`invalid arguments for ${spec.name}: ${issuesText(r.error)}`, 'fix the arguments and retry');
      return r.data as Record<string, unknown>;
    },
    dialogExempt: (a) => spec.dialogExempt?.(cast(a)) ?? false,
    timeoutMs: (a, c) => spec.timeoutMs?.(cast(a), c) ?? c.actionTimeout,
    needsBrowser: (a) => spec.needsBrowser?.(cast(a)) ?? true,
    async run(a, ctx) {
      const r = await spec.handler(cast(a), ctx);
      return typeof r === 'string' ? text(r) : r;
    },
  };
}

export function text(s: string): ToolResult {
  return { content: [{ type: 'text', text: s }] };
}

export function errorResult(s: string): ToolResult {
  return { content: [{ type: 'text', text: s }], isError: true };
}

// Shared schema pieces.
export const tabArg = z.string().regex(/^t\d+$/).optional().describe('Tab id such as "t3"; default is the active tab');
export const timeoutArg = z.number().int().positive().max(600000).optional().describe('Timeout in ms; default is the configured action/navigation timeout');
export const snapshotArg = z.boolean().optional().describe('true attaches a full-page snapshot after the effect summary; false skips the viewport snapshot attached when the action opens a new document (call snapshot for the whole page)');
export const targetArg = z
  .string()
  .min(1)
  .describe('A ref from snapshot/find ("e12"), a point "x,y" in the last screenshot\'s pixels, or a Playwright selector (text=…, role=button[name="…"], #id, css=…, xpath=…)');
