// Output formatting: snapshot lines, paging, effect lines, redaction, sizes.
import type { SnapAttrs } from '../page/protocol.js';
import { redactUrl, safeUrl, scrubSecrets } from './secrets.js';

export const ARROW = '→ ';
export const ELLIPSIS = '…';

/** Truncate to at most max chars (the ellipsis counts toward max). */
export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = Math.max(0, max - 1);
  // Round 4 nit: never keep the high half of a surrogate pair without its low half.
  const last = s.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${s.slice(0, end)}${ELLIPSIS}`;
}

/** Round 4, D3: page titles in result lines (navigate, `→ navigated`, tabs) are clipped to this. */
export const TITLE_MAX = 200;

/** A page title for a result line: secrets scrubbed, clipped to TITLE_MAX, JSON-quoted (round 4, D3). */
export function titleQ(title: string): string {
  return jsonQuote(clip(scrubSecrets(typeof title === 'string' ? title : ''), TITLE_MAX));
}

/**
 * Re-check item 5: these all count as line breaks wherever page text is escaped or continued.
 */
export const LINE_BREAK = /\r\n|[\r\n\u2028\u2029\u0085\v\f]/;
const LINE_BREAK_G = new RegExp(LINE_BREAK.source, 'g');
// Review of cc50db4, item 3: `… ` too (the batch cut note and the paging footers start with it).
const SERVER_LINE_AFTER_BREAK = new RegExp(`(^|${LINE_BREAK.source})(→ |hint: |notice:|\\[t\\d+\\]|## step \\d|… )`, 'g');
/** Round 6 (item 10): DEL and the C1 controls too (NEL is one); JSON.stringify escapes only C0. */
const RAW_JSON_BREAKS = /[\u007f-\u009f\u2028\u2029]/g;

/** JSON text with U+2028, U+2029 and U+0085 escaped too (JSON.stringify leaves them raw). */
export function escapeJsonBreaks(json: string): string {
  return json.replace(RAW_JSON_BREAKS, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
/** JSON.stringify for output: no raw line separator survives in a quoted field (re-check item 5). */
export function jsonQuote(v: unknown): string {
  return escapeJsonBreaks(JSON.stringify(v) ?? 'undefined');
}
/** Unquoted page text (a download path) with each of the 7 line separators written as a \uXXXX escape (P10). */
export function escapeBreaks(text: string): string {
  return text.replace(LINE_BREAK_G, (m) => Array.from(m, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join(''));
}
/** Continue page text on the next line with `prefix` after every line break (console messages). */
export function continueLines(text: string, prefix: string): string {
  return text.replace(LINE_BREAK_G, `\n${prefix}`);
}

/** A JSON-quoted page string for output: remembered secrets scrubbed, then clipped. */
export function q(s: string, max = 100): string {
  return jsonQuote(clip(scrubSecrets(s), max));
}

/**
 * Show a same-origin href as path+query+hash; anything else verbatim. Round 7b (C1): a printed URL, so
 * redacted with the printed-URL rules (redactUrl: secret parameters, and remembered secrets in any URL
 * spelling, next to an escape too); it is JSON-quoted by the caller, so nothing is percent-encoded.
 */
export function displayHref(href: string, pageUrl: string): string {
  try {
    const u = new URL(href, pageUrl);
    const p = new URL(pageUrl);
    if (u.origin === p.origin && u.origin !== 'null') return redactUrl(`${u.pathname}${u.search}${u.hash}`);
    return redactUrl(u.href);
  } catch {
    return redactUrl(href);
  }
}

/**
 * P9: the roles a snapshot line may print (the engine's vocabulary plus `clickable`). The engine is page
 * code a page can replace, so any other role string prints as `group`, the role describe() already gives
 * a non-semantic element (`generic` is not in the snapshot grammar).
 */
export const SNAP_ROLES: ReadonlySet<string> = new Set([
  'link', 'button', 'textbox', 'searchbox', 'combobox', 'listbox', 'option', 'checkbox', 'radio', 'switch',
  'slider', 'spinbutton', 'tab', 'tablist', 'tabpanel', 'menu', 'menubar', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'tree', 'treeitem', 'grid', 'row', 'cell', 'columnheader', 'rowheader', 'heading', 'img',
  'dialog', 'alertdialog', 'alert', 'status', 'log', 'progressbar', 'banner', 'navigation', 'main',
  'complementary', 'contentinfo', 'search', 'form', 'region', 'list', 'listitem', 'table', 'figure',
  'article', 'group', 'toolbar', 'iframe', 'video', 'audio', 'canvas', 'file', 'clickable',
]);
export const FALLBACK_ROLE = 'group';
/** P9: a role from the engine, or the fallback when it is not in the vocabulary. */
export function safeRole(role: unknown): string {
  return typeof role === 'string' && SNAP_ROLES.has(role) ? role : FALLBACK_ROLE;
}
/** P9: `level=` is printed only as a small positive integer (aria-level, heading level). */
export const MAX_LEVEL = 99;
/** P9: `type=` is a bare token in the grammar, so only an input-type-shaped word is printed. */
const INPUT_TYPE = /^[a-z][a-z-]{0,23}$/;
const isTri = (v: unknown): boolean => v === 'true' || v === 'false' || v === 'mixed';

/**
 * `unavailable` (round 7b, W1): the server's mark on an iframe line whose frame's content is not shown (it did
 * not answer within its budget, failed, or no frame could be matched to it). It is a bare attribute after
 * `frame=fN` that only the server prints: a page's own text prints quoted, so it cannot produce the mark
 * (round 7's `- text "(frame unavailable)"` line was byte-identical to a page text node).
 */
export function formatAttrs(a: SnapAttrs | undefined, pageUrl: string, frameId?: string, unavailable = false): string {
  const out: string[] = [];
  // P9: every field comes from an engine the page may have planted; only the grammar's own forms print.
  if (a !== null && typeof a === 'object') {
    if (Number.isSafeInteger(a.level) && (a.level as number) >= 1 && (a.level as number) <= MAX_LEVEL) out.push(`level=${a.level}`);
    if (typeof a.type === 'string' && INPUT_TYPE.test(a.type) && a.type !== 'text' && a.type !== 'password') out.push(`type=${a.type}`);
    if (a.password === true) out.push('password');
    if (isTri(a.checked)) out.push(`checked=${a.checked}`);
    if (a.selected === true) out.push('selected');
    if (isTri(a.pressed)) out.push(`pressed=${a.pressed}`);
    if (typeof a.expanded === 'boolean') out.push(`expanded=${a.expanded}`);
    if (a.disabled === true) out.push('disabled');
    if (a.readonly === true) out.push('readonly');
    if (a.required === true) out.push('required');
    if (a.invalid === true) out.push('invalid');
    if (a.focused === true) out.push('focused');
    if (a.password === true || a.valueRedacted === true) {
      if (a.valueRedacted === true) out.push('value=<redacted>');
    } else if (typeof a.value === 'string' && a.value !== '') {
      out.push(`value=${q(a.value)}`);
    }
    if (Array.isArray(a.options)) {
      const all = (a.options as unknown[]).filter((o): o is string => typeof o === 'string');
      const shown = all.slice(0, 10).map((o) => clip(o, 100));
      const t = a.optionsTotal;
      const total = typeof t === 'number' && Number.isSafeInteger(t) && t >= all.length ? t : all.length;
      if (total > shown.length) shown.push(`${ELLIPSIS}+${total - shown.length}`);
      out.push(`options=${jsonQuote(shown)}`);
    }
    if (typeof a.href === 'string') out.push(`href=${jsonQuote(displayHref(a.href, pageUrl))}`);
  }
  if (frameId !== undefined) out.push(`frame=${frameId}`);
  if (unavailable) out.push('unavailable');
  return out.length > 0 ? ` ${out.join(' ')}` : '';
}

export function elementLine(
  depth: number,
  role: string,
  name: string | undefined,
  ref: number,
  attrs: SnapAttrs | undefined,
  pageUrl: string,
  frameId?: string,
  unavailable = false,
): string {
  const n = typeof name === 'string' && name !== '' ? ` ${q(name)}` : '';
  return `${'  '.repeat(depth)}- ${safeRole(role)}${n} e${ref}${formatAttrs(attrs, pageUrl, frameId, unavailable)}`;
}

export function textLine(depth: number, text: string): string {
  return `${'  '.repeat(depth)}- text ${q(typeof text === 'string' ? text : '', 200)}`;
}

/** P7: the header's title and URL are clipped, so one huge title cannot take a page's whole budget. */
export const HEADER_TITLE_MAX = 200;
export const HEADER_URL_MAX = 500;

export function snapshotHeader(tabId: string, title: string, url: string): string {
  const t = typeof title === 'string' ? title : '';
  return `[${tabId}] ${jsonQuote(clip(scrubSecrets(t), HEADER_TITLE_MAX))} ${clip(safeUrl(url), HEADER_URL_MAX)} (untrusted page content)`;
}

export const SNAPSHOT_FOOTER_HINT = 'or narrow with scope, find or viewport_only';

export function snapshotFooter(remaining: number, nextOffset: number): string {
  return `${ELLIPSIS} ${remaining} more lines (offset=${nextOffset} to continue; ${SNAPSHOT_FOOTER_HINT})`;
}

/**
 * The snapshot attached automatically to a new document (navigate, tabs new, a navigating action) is
 * viewport-only and capped at this many chars, footer included (PLAN "Decisions from the bench").
 * An explicit snapshot:true keeps the full page under --max-output-chars.
 */
export const ATTACHED_SNAPSHOT_MAX_CHARS = 6000;

export const VIEWPORT_FOOTER_HINT = 'find or read for text; snapshot for the whole page';

/**
 * Footer of the attached viewport snapshot: one line when anything was left out (off-screen elements or
 * lines past the cap). find and read come before snapshot, so an agent does not pull the full page back
 * by default. `remaining`/`nextOffset` keep offset paging (snapshot viewport_only:true offset=<m>).
 */
export function viewportFooter(offscreen: number, remaining: number, nextOffset: number): string | null {
  if (offscreen <= 0 && remaining <= 0) return null;
  const more = remaining > 0 ? `, ${remaining} more lines` : '';
  const cont = remaining > 0 ? `; offset=${nextOffset} with viewport_only to continue` : '';
  return `${ELLIPSIS} viewport only: ${Math.max(0, offscreen)} more off-screen${more} (${VIEWPORT_FOOTER_HINT}${cont})`;
}

const JSON_STR = String.raw`"(?:[^"\\]|\\.)*"`;
const ELEMENT_HEAD = new RegExp(String.raw`^( *)- ([a-z]+)( ${JSON_STR})? (e\d+)`);
const TEXT_LINE = new RegExp(String.raw`^( *)- text (${JSON_STR})$`);
/** One indivisible unit of a JSON string's content: an escape (`\uXXXX` whole), a surrogate pair, or one char. */
const STR_UNIT = /\\u[0-9a-fA-F]{4}|\\[^]|[\uD800-\uDBFF][\uDC00-\uDFFF]|[^]/g;

/**
 * A JSON string token (`"…"`, quotes included) cut to at most `room` chars, ending with `…"`; whole when
 * it fits. Never ends inside an escape or between the halves of a surrogate pair (P6, P12). null when
 * not even `"…"` fits.
 */
function cutString(tok: string, room: number): string | null {
  if (tok.length <= room) return tok;
  if (room < 3) return null;
  const body = tok.slice(1, -1);
  let kept = '';
  STR_UNIT.lastIndex = 0;
  for (let m = STR_UNIT.exec(body); m; m = STR_UNIT.exec(body)) {
    if (kept.length + m[0].length + 3 > room) break;
    kept += m[0];
  }
  return `"${kept}${ELLIPSIS}"`;
}

/** A JSON array of strings (`["a","b"]`) cut to `room` chars: whole elements, then one cut element, then `]`. */
function cutArray(tok: string, room: number): string | null {
  if (tok.length <= room) return tok;
  const elems = tok.match(new RegExp(JSON_STR, 'g')) ?? [];
  let out = '[';
  for (const e of elems) {
    const sep = out === '[' ? '' : ',';
    if (out.length + sep.length + e.length + 1 <= room) {
      out += sep + e;
      continue;
    }
    const c = cutString(e, room - out.length - sep.length - 1);
    if (c !== null) out += sep + c;
    break;
  }
  return out === '[' ? null : `${out}]`;
}

/** Attribute tokens after the element head (each without its leading space); strings and arrays kept whole. */
function attrTokens(rest: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inStr = false;
  let depth = 0;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i] as string;
    if (inStr) {
      cur += c;
      if (c === '\\' && i + 1 < rest.length) cur += rest[++i];
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '[') depth++;
    else if (c === ']') depth--;
    else if (c === ' ' && depth <= 0) {
      if (cur !== '') out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur !== '') out.push(cur);
  return out;
}

/** The shortest form `cutLine` can give a line: its head with the name or text cut to `"…"`. */
export function lineFloor(line: string): number {
  const t = TEXT_LINE.exec(line);
  if (t) return Math.min(line.length, (t[1] ?? '').length + '- text "…"'.length);
  const m = ELEMENT_HEAD.exec(line);
  if (!m) return Math.min(line.length, 1);
  return Math.min(line.length, (m[1] ?? '').length + 2 + (m[2] ?? '').length + (m[3] ? ' "…"'.length : 0) + 1 + (m[4] ?? '').length);
}

/**
 * Cuts a snapshot line to at most `max` chars and keeps it in the grammar (P6): the element head
 * (indent, role, name, ref) stays whole when it fits, else its name is cut; attribute tokens follow in
 * order while they fit; a JSON string is cut at a whole unit and ends with `…"`; an options array keeps
 * whole elements and closes with `]`. Returns '' when not even lineFloor(line) fits: the caller must
 * then not count the line as shown (P7).
 */
export function cutLine(line: string, max: number): string {
  if (line.length <= max) return line;
  const t = TEXT_LINE.exec(line);
  if (t) {
    const prefix = `${t[1] ?? ''}- text `;
    const s = cutString(t[2] ?? '""', max - prefix.length);
    return s === null ? '' : `${prefix}${s}`;
  }
  const m = ELEMENT_HEAD.exec(line);
  if (!m) {
    // Not a grammar line: cut at a whole code point.
    if (max <= 0) return '';
    const s = line.slice(0, max);
    return /[\uD800-\uDBFF]$/.test(s) ? s.slice(0, -1) : s;
  }
  const indent = m[1] ?? '';
  const role = m[2] ?? '';
  const nameTok = (m[3] ?? '').slice(1);
  const ref = m[4] ?? '';
  const head = m[0];
  if (head.length > max) {
    if (nameTok === '') return '';
    const fixed = `${indent}- ${role}  ${ref}`.length;
    const name = cutString(nameTok, max - fixed);
    return name === null ? '' : `${indent}- ${role} ${name} ${ref}`;
  }
  let out = head;
  for (const tok of attrTokens(line.slice(head.length))) {
    if (out.length + 1 + tok.length <= max) {
      out += ` ${tok}`;
      continue;
    }
    const room = max - out.length - 1;
    const kv = /^(value=|href=)"/.exec(tok);
    if (kv) {
      const s = cutString(tok.slice(kv[1]!.length), room - kv[1]!.length);
      if (s !== null) out += ` ${kv[1]}${s}`;
    } else if (tok.startsWith('options=[')) {
      const a = cutArray(tok.slice('options='.length), room - 'options='.length);
      if (a !== null) out += ` options=${a}`;
    }
    break;
  }
  return out;
}

/** A line that starts like a server line: an effect, a hint, a notice, a tab-prefixed line, a batch step, a footer. */
const SERVER_LINE_START = /^(?:→ |hint: |notice:|\[t\d+\]|## step \d|… )/;
/** One indivisible unit outside a JSON string: a surrogate pair or one char. */
const CHAR_UNIT = /[\uD800-\uDBFF][\uDC00-\uDFFF]|[^]/g;

/**
 * Cuts any result line to at most `max` chars without breaking the output grammar (2026-10-26, batch
 * shares the output cap): a snapshot line goes through `cutLine`; a line that starts like a server line
 * (`→ `, `hint: `, `notice:`, `[tN]`, `## step N`, `… `) is never cut, it is dropped (''), unless `own`
 * (a step's own first line, printed by the server: review of cc50db4, item 2); any other line is cut at a
 * whole unit, and a JSON string open at the cut is closed with `…"` (never inside an escape or a surrogate
 * pair, as `cutString`). A backslash left at the end outside a string is dropped too (item 4: no lone `\`
 * line). '' when nothing fits.
 */
export function cutResultLine(line: string, max: number, own = false): string {
  if (line.length <= max) return line;
  if (max <= 0 || (!own && SERVER_LINE_START.test(line))) return '';
  if (TEXT_LINE.test(line) || ELEMENT_HEAD.test(line)) return cutLine(line, max);
  let out = '';
  let inStr = false;
  let i = 0;
  while (i < line.length) {
    const re: RegExp = inStr ? STR_UNIT : CHAR_UNIT;
    re.lastIndex = i;
    const unit: string = (re.exec(line) as RegExpExecArray)[0];
    const after: boolean = inStr ? unit !== '"' : unit === '"';
    // Inside a string, room is kept for the closing `…"`.
    if (out.length + unit.length + (after ? 2 : 0) > max) break;
    out += unit;
    inStr = after;
    i += unit.length;
  }
  if (inStr) return `${out}${ELLIPSIS}"`;
  return out.endsWith('\\') ? out.slice(0, -1) : out;
}

/**
 * The longest prefix of `text` within `max` chars that keeps the output grammar: whole lines, then the
 * first line that does not fit cut by `cutResultLine` (or dropped). `ownFirst`: the first line is the
 * server's own (a step's first line) and is clipped rather than dropped.
 */
export function cutResultText(text: string, max: number, ownFirst = false): string {
  if (text.length <= max) return text;
  const lines = text.split('\n');
  let out = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const sep = i === 0 ? 0 : 1;
    if (out.length + sep + line.length <= max) {
      out += `${sep ? '\n' : ''}${line}`;
      continue;
    }
    const part = cutResultLine(line, max - out.length - sep, ownFirst && i === 0);
    if (part !== '') out += `${sep ? '\n' : ''}${part}`;
    break;
  }
  return out;
}

const defaultFooter = (remaining: number, nextOffset: number): string | null =>
  remaining > 0 ? snapshotFooter(remaining, nextOffset) : null;

export interface Page {
  text: string;
  /** Body lines included (indexes [offset, end)). */
  end: number;
  total: number;
}

/**
 * Line paging. The header is emitted on every page; offset indexes body lines only; the footer counts
 * the remaining body lines and is never itself a body line. Output stays within maxChars, except when
 * maxChars is below header + the first line's head (lineFloor) + footer: progress is guaranteed (at least
 * one line per page, never an empty one), so that floor wins (P7). `footer` maps
 * (remaining lines, next offset) to the footer line, or null for none (default: snapshotFooter when lines remain).
 */
export function pageLines(
  header: string,
  lines: string[],
  offset: number,
  maxChars: number,
  omitted = 0,
  footer: (remaining: number, nextOffset: number) => string | null = defaultFooter,
): Page {
  // `omitted` lines exist after `lines` but were not built (the page stopped at max_chars + offset).
  const total = lines.length + omitted;
  const start = Math.max(0, Math.min(offset, total));
  let text = header;
  let i = start;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const after = footer(total - (i + 1), i + 1);
    const footerLen = after !== null ? 1 + after.length : 0;
    const room = maxChars - text.length - 1 - footerLen;
    if (line.length > room) {
      if (i > start) break;
      // A single line longer than the page (a huge href): cut to fit, so the page still makes progress and
      // stays within max_chars (PLAN "Decisions from the bench", item 5). P7: a page always shows its
      // first line, at least as its head (lineFloor); only a max_chars below header + head + footer is
      // exceeded, by that floor. An empty cut is never counted as shown.
      text += `\n${cutLine(line, Math.max(room, lineFloor(line)))}`;
      i++;
      continue;
    }
    text += `\n${line}`;
    i++;
  }
  const last = footer(total - i, i);
  if (last !== null) text += `\n${last}`;
  return { text, end: i, total };
}

/**
 * Character paging for read: exactly `maxChars` content chars from `offset` (no line-boundary cut), so
 * pages requested at offset, offset+maxChars, ... cover the content with no gaps and no overlaps.
 */
export function pageChars(body: string, offset: number, maxChars: number): { text: string; next: number | undefined } {
  const start = Math.max(0, Math.min(offset, body.length));
  const end = Math.min(body.length, start + Math.max(1, maxChars));
  return { text: body.slice(start, end), next: end < body.length ? end : undefined };
}

export function readFooter(remainingChars: number, next: number): string {
  return `${ELLIPSIS} ${remainingChars} more chars (offset=${next} to continue)`;
}

/**
 * PLAN amendment item 3: page text must not forge server lines. A line that would start like one
 * (an effect line, a hint, a notice, a tab-prefixed result line, a batch "## step <n>" marker: P12) gets a leading backslash.
 */
export function escapeServerLines(text: string): string {
  return text.replace(SERVER_LINE_AFTER_BREAK, '$1\\$2');
}

/** Room kept under --max-output-chars for a header and a truncation footer. */
export const OUTPUT_RESERVE = 200;

/**
 * Generic cap for any text result. `max` is a hard ceiling on the whole returned text, the truncation
 * note included.
 */
export function capText(s: string, max: number): string {
  if (s.length <= max) return s;
  // The note's digit count is at most that of s.length, so reserving that length keeps the total <= max.
  const noteMax = `\n${ELLIPSIS} truncated ${s.length} chars`.length;
  if (max <= noteMax) return s.slice(0, Math.max(0, max)); // no room for the note itself
  const keep = max - noteMax;
  return `${s.slice(0, keep)}\n${ELLIPSIS} truncated ${s.length - keep} chars`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export const REDACTED_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
]);

export function redactHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) out[k] = REDACTED_HEADERS.has(k.toLowerCase()) ? '<redacted>' : v;
  return out;
}

/** Field names whose values are redacted in request/response bodies. */
export const SECRET_FIELD = /pass|pwd|secret|token|api[-_]?key|auth/i;

/**
 * Redact password-like field values in a body: urlencoded pairs, multipart parts, and JSON string/number
 * values whose key matches SECRET_FIELD. Other content is returned unchanged.
 */
export function redactBody(body: string, contentType: string): string {
  const ct = contentType.toLowerCase();
  if (ct.includes('multipart/form-data') || /Content-Disposition: form-data/i.test(body)) {
    return body.replace(
      /(Content-Disposition: form-data; name="([^"]*)"(?:; filename="[^"]*")?\r?\n(?:[^\r\n]+\r?\n)*\r?\n)([\s\S]*?)(?=\r?\n--)/gi,
      (m, head: string, name: string) => (SECRET_FIELD.test(name) ? `${head}<redacted>` : m),
    );
  }
  if (ct.includes('json') || /^\s*[[{]/.test(body)) {
    return body.replace(/("([^"\\]*)"\s*:\s*)("(?:[^"\\]|\\.)*"|-?\d[\d.eE+-]*)/g, (m, head: string, key: string) =>
      SECRET_FIELD.test(key) ? `${head}"<redacted>"` : m,
    );
  }
  if (ct.includes('x-www-form-urlencoded') || /^[^\s=&]+=[^\s&]*(&[^\s=&]+=[^\s&]*)*$/.test(body.trim())) {
    return body
      .split('&')
      .map((pair) => {
        const i = pair.indexOf('=');
        if (i < 0) return pair;
        let key = pair.slice(0, i);
        try {
          key = decodeURIComponent(key.replace(/\+/g, ' '));
        } catch {
          /* keep raw */
        }
        return SECRET_FIELD.test(key) ? `${pair.slice(0, i)}=<redacted>` : pair;
      })
      .join('&');
  }
  return body;
}

// ---- effect lines (fixed forms) ----
export const effect = {
  navigated: (url: string, title: string, status: number | undefined) =>
    `${ARROW}navigated ${safeUrl(url)} ${titleQ(title)}${status !== undefined ? ` (${status})` : ''}`,
  url: (url: string) => `${ARROW}url ${safeUrl(url)}`,
  newTab: (id: string, url: string) => `${ARROW}new tab ${id} ${safeUrl(url)}`,
  tabClosed: (id: string) => `${ARROW}tab closed ${id}`,
  dialogPending: (type: string, message: string) =>
    `${ARROW}dialog pending ${type} ${jsonQuote(scrubSecrets(message))} (use dialog accept|dismiss)`,
  dialogAccepted: (type: string, message: string) => `${ARROW}dialog accepted ${type} ${jsonQuote(scrubSecrets(message))}`,
  // P10: a download name is page-chosen; a line separator in it is escaped, never printed raw.
  download: (path: string, size: number) => `${ARROW}download ${escapeBreaks(path)} (${formatBytes(size)})`,
  alert: (text: string) => `${ARROW}alert ${jsonQuote(clip(scrubSecrets(text), 200))}`,
  // P10: every line separator (NEL, \v and \f too, which `\s` misses or keeps) collapses to a space.
  // Round 7 (r3-builtins): the first error's text is the page's: JSON-quoted (its quotes, ESC and refs stay in the string).
  console: (n: number, first: string) =>
    `${ARROW}console ${n} new error${n === 1 ? '' : 's'}: ${jsonQuote(clip(scrubSecrets(first).replace(LINE_BREAK_G, ' ').replace(/\s+/g, ' '), 200))}`,
};

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function clockTime(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}
