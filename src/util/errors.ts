// Tool errors: a one-line cause plus a hint for the next step.
import { LINE_BREAK } from './format.js';

/** Contract answer 2: line 1 is the cause, line 2 starts with `hint: ` and names the next step. */
export function errorText(cause: string, hint: string): string {
  return `${cause}\nhint: ${hint}`;
}

export class ToolError extends Error {
  constructor(
    readonly cause1: string,
    readonly hint: string,
  ) {
    super(errorText(cause1, hint));
  }
}

export function toolError(cause: string, hint: string): ToolError {
  return new ToolError(cause, hint);
}

const PW_NOISE = /^(page|frame|locator|elementHandle|browserContext|browser|keyboard|mouse)\.[A-Za-z]+: /;

/** Every C0 control (\t included), DEL and the C1 controls (NEL included), U+2028 and U+2029. */
const CONTROLS_G = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
/** Playwright's own ANSI styling in call logs (`\u001b[2m` … `\u001b[22m`). */
const ANSI_STYLE_G = /\u001b\[[0-9;]*m/g;

/** Round 5 (security): Playwright's call-log styling, dropped from text it quotes from its log. */
export function stripAnsiStyle(s: string): string {
  return s.replace(ANSI_STYLE_G, '');
}

/**
 * Round 5 (security), round 6 (items 9, 10): unquoted text for an output line (page text, a caller's URL)
 * with every control character written as a `\uXXXX` escape: the 7 line separators, ESC, NUL, DEL, the C1
 * range and tabs. It can neither start a line of its own nor send terminal escapes.
 */
export function escapeControls(s: string): string {
  return s.replace(CONTROLS_G, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * First meaningful line of a Playwright error. Round 5 (security): the message can carry page text (a page
 * exception, an element preview), so it is split on all 7 line separators, not only `\n`, and what is left
 * is escaped (`escapeControls`): page text never starts a line.
 */
export function firstLine(e: unknown): string {
  return escapeControls(firstLineRaw(e));
}

/**
 * Round 6: the same first line, unescaped, for printing inside a JSON string (jsonQuote escapes it): an error
 * whose origin is not known may carry page text (a main-world evaluation under a replaced window.eval).
 */
export function firstLineRaw(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const line = msg.split(LINE_BREAK).find((l) => l.trim() !== '' && !l.startsWith('=')) ?? msg;
  return stripAnsiStyle(line.replace(PW_NOISE, '').trim());
}

export function errorLog(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function isTimeout(e: unknown): boolean {
  return e instanceof Error && (e.name === 'TimeoutError' || /Timeout \d+ms exceeded/.test(e.message));
}

export function isClosedError(e: unknown): boolean {
  return e instanceof Error && /Target page, context or browser has been closed|Target closed|Browser has been closed|has been closed/i.test(e.message);
}


export function isNavigationContextError(e: unknown): boolean {
  return (
    e instanceof Error &&
    /Execution context was destroyed|Cannot find context with specified id|frame was detached|Frame was detached|navigat/i.test(e.message)
  );
}
