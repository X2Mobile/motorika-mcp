// Snapshot grammar and effect-line parser, written from PLAN.md "Snapshot grammar" and "Effect summary".
// It is strict on purpose: a line that does not match the contract is reported, never skipped.

export const ROLES = new Set([
  // ARIA
  'link', 'button', 'textbox', 'searchbox', 'combobox', 'listbox', 'option', 'checkbox', 'radio', 'switch',
  'slider', 'spinbutton', 'tab', 'tablist', 'tabpanel', 'menu', 'menubar', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'tree', 'treeitem', 'grid', 'row', 'cell', 'columnheader', 'rowheader', 'heading', 'img',
  'dialog', 'alertdialog', 'alert', 'status', 'log', 'progressbar', 'banner', 'navigation', 'main',
  'complementary', 'contentinfo', 'search', 'form', 'region', 'list', 'listitem', 'table', 'figure', 'article',
  'group', 'toolbar',
  // non-ARIA (text is a separate line kind)
  'iframe', 'video', 'audio', 'canvas', 'file', 'clickable',
]);

const JSTR = String.raw`"(?:[^"\\]|\\.)*"`;
const JARR = String.raw`\[\s*(?:${JSTR}\s*(?:,\s*${JSTR}\s*)*)?\]`;

/** Attribute tokens in their fixed contract order. */
const ATTRS: { key: string; re: RegExp }[] = [
  { key: 'level', re: /^level=(\d+)/ },
  { key: 'type', re: /^type=([^\s"]+)/ },
  { key: 'password', re: /^password(?=\s|$)/ },
  { key: 'checked', re: /^checked=(true|false|mixed)(?=\s|$)/ },
  { key: 'selected', re: /^selected(?=\s|$)/ },
  { key: 'pressed', re: /^pressed=(true|false|mixed)(?=\s|$)/ },
  { key: 'expanded', re: /^expanded=(true|false)(?=\s|$)/ },
  { key: 'disabled', re: /^disabled(?=\s|$)/ },
  { key: 'readonly', re: /^readonly(?=\s|$)/ },
  { key: 'required', re: /^required(?=\s|$)/ },
  { key: 'invalid', re: /^invalid(?=\s|$)/ },
  { key: 'focused', re: /^focused(?=\s|$)/ },
  { key: 'value', re: new RegExp(String.raw`^value=(${JSTR}|<redacted>)(?=\s|$)`) },
  { key: 'options', re: new RegExp(String.raw`^options=(${JARR})(?=\s|$)`) },
  { key: 'href', re: new RegExp(String.raw`^href=(${JSTR})(?=\s|$)`) },
  { key: 'frame', re: /^frame=(f\d+)(?=\s|$)/ },
  // Round 7b (W1): the server's mark on an iframe whose frame's content is not shown.
  { key: 'unavailable', re: /^unavailable(?=\s|$)/ },
];

export type Attrs = {
  level?: number;
  type?: string;
  password?: true;
  checked?: 'true' | 'false' | 'mixed';
  selected?: true;
  pressed?: 'true' | 'false' | 'mixed';
  expanded?: 'true' | 'false';
  disabled?: true;
  readonly?: true;
  required?: true;
  invalid?: true;
  focused?: true;
  /** JSON-decoded value, or the literal `<redacted>`. */
  value?: string;
  options?: string[];
  href?: string;
  frame?: string;
  unavailable?: true;
};

export interface ElementLine {
  kind: 'element';
  raw: string;
  depth: number;
  role: string;
  name: string | null;
  ref: string;
  attrs: Attrs;
  /** Index of the enclosing element line in `Snapshot.lines`, or -1 at top level. */
  parent: number;
}

export interface TextLine {
  kind: 'text';
  raw: string;
  depth: number;
  text: string;
  parent: number;
}

export type BodyLine = ElementLine | TextLine;

export interface Header {
  tab: string;
  title: string;
  url: string;
}

export interface Footer {
  more: number;
  offset: number;
}

/**
 * Footer of the snapshot attached automatically to a new document (PLAN "Decisions from the bench"):
 * `… viewport only: <n> more off-screen[, <k> more lines] (find or read for text; snapshot for the whole
 * page[; offset=<m> with viewport_only to continue])`. `more`/`offset` are 0/null when no line was cut.
 */
export interface ViewportFooter {
  viewport: true;
  offscreen: number;
  more: number;
  offset: number | null;
}

export interface Snapshot {
  header: Header;
  lines: BodyLine[];
  elements: ElementLine[];
  footer: Footer | ViewportFooter | null;
  /** Lines that matched nothing in the grammar (C1 requires none). */
  errors: string[];
}

const HEADER_RE = new RegExp(String.raw`^\[(t\d+)\] (${JSTR}) (\S+) \(untrusted page content\)$`);
const FOOTER_RE = /^… (\d+) more lines \(offset=(\d+) to continue; or narrow with scope, find or viewport_only\)$/;
const VIEWPORT_FOOTER_RE =
  /^… viewport only: (\d+) more off-screen(?:, (\d+) more lines)? \(find or read for text; snapshot for the whole page(?:; offset=(\d+) with viewport_only to continue)?\)$/;
const ELEMENT_HEAD_RE = new RegExp(String.raw`^( *)- ([a-z]+)(?: (${JSTR}))? (e\d+)(?=\s|$)`);
const TEXT_RE = new RegExp(String.raw`^( *)- text (${JSTR})$`);

export function isHeaderLine(line: string): boolean {
  return HEADER_RE.test(line);
}

export function parseHeader(line: string): Header | null {
  const m = HEADER_RE.exec(line);
  if (!m) return null;
  return { tab: m[1]!, title: JSON.parse(m[2]!) as string, url: m[3]! };
}

/** Parses attribute tokens; returns null when a token is unknown, repeated or out of order. */
export function parseAttrs(rest: string): { attrs: Attrs; error: string | null } {
  const attrs: Record<string, unknown> = {};
  let s = rest;
  let lastIndex = -1;
  while (s.length > 0) {
    if (!s.startsWith(' ')) return { attrs: attrs as Attrs, error: `expected a space before "${s}"` };
    s = s.slice(1);
    let matched = false;
    for (let i = 0; i < ATTRS.length; i++) {
      const a = ATTRS[i]!;
      const m = a.re.exec(s);
      if (!m) continue;
      if (i <= lastIndex) return { attrs: attrs as Attrs, error: `attribute ${a.key} out of order or repeated` };
      lastIndex = i;
      const v = m[1];
      switch (a.key) {
        case 'level':
          attrs.level = Number(v);
          break;
        case 'value':
          attrs.value = v === '<redacted>' ? '<redacted>' : (JSON.parse(v!) as string);
          break;
        case 'options':
          attrs.options = JSON.parse(v!) as string[];
          break;
        case 'href':
          attrs.href = JSON.parse(v!) as string;
          break;
        default:
          attrs[a.key] = v === undefined ? true : v;
      }
      s = s.slice(m[0].length);
      matched = true;
      break;
    }
    if (!matched) return { attrs: attrs as Attrs, error: `unknown attribute token at "${s}"` };
  }
  return { attrs: attrs as Attrs, error: null };
}

/** Parses one element line (indentation included). `suffixAllowed` lets find hits carry `  in …`. */
export function parseElementLine(line: string): { el: Omit<ElementLine, 'parent'> | null; error: string | null } {
  const m = ELEMENT_HEAD_RE.exec(line);
  if (!m) return { el: null, error: 'not an element line' };
  const indent = m[1]!.length;
  if (indent % 2 !== 0) return { el: null, error: 'indent is not a multiple of 2' };
  const role = m[2]!;
  if (!ROLES.has(role)) return { el: null, error: `role "${role}" not in the vocabulary` };
  const name = m[3] ? (JSON.parse(m[3]) as string) : null;
  if (name !== null && name.length === 0) return { el: null, error: 'empty name must be omitted' };
  if (name !== null && name.length > 101) return { el: null, error: 'name longer than 100 chars + …' };
  const { attrs, error } = parseAttrs(line.slice(m[0].length));
  if (error) return { el: null, error };
  return { el: { kind: 'element', raw: line, depth: indent / 2, role, name, ref: m[4]!, attrs }, error: null };
}

/**
 * Finds the first snapshot header in `text` and parses everything after it as snapshot body.
 * Lines before the header (effect summary, notices) are ignored.
 */
export function parseSnapshot(text: string): Snapshot {
  const all = text.split('\n');
  const start = all.findIndex((l) => HEADER_RE.test(l));
  if (start < 0) throw new Error(`no snapshot header line in:\n${text.slice(0, 500)}`);
  const header = parseHeader(all[start]!)!;
  const lines: BodyLine[] = [];
  const errors: string[] = [];
  let footer: Footer | ViewportFooter | null = null;
  const stack: number[] = []; // index of the element line at each depth
  for (const raw of all.slice(start + 1)) {
    if (raw === '' && footer === null && lines.length === 0) continue;
    if (raw === '') {
      // A blank line ends the snapshot block (e.g. batch output continues after it).
      break;
    }
    if (footer !== null) {
      errors.push(`line after footer: ${raw}`);
      continue;
    }
    const f = FOOTER_RE.exec(raw);
    if (f) {
      footer = { more: Number(f[1]), offset: Number(f[2]) };
      continue;
    }
    const v = VIEWPORT_FOOTER_RE.exec(raw);
    if (v) {
      // The line count and the continuation offset come together or not at all.
      if ((v[2] === undefined) !== (v[3] === undefined)) errors.push(`viewport footer with lines but no offset (or the reverse): ${raw}`);
      if (v[2] === undefined && Number(v[1]) === 0) errors.push(`viewport footer with nothing left out: ${raw}`);
      footer = { viewport: true, offscreen: Number(v[1]), more: v[2] === undefined ? 0 : Number(v[2]), offset: v[3] === undefined ? null : Number(v[3]) };
      continue;
    }
    const t = TEXT_RE.exec(raw);
    if (t) {
      const depth = t[1]!.length / 2;
      lines.push({ kind: 'text', raw, depth, text: JSON.parse(t[2]!) as string, parent: depth > 0 ? (stack[depth - 1] ?? -1) : -1 });
      continue;
    }
    const { el, error } = parseElementLine(raw);
    if (!el) {
      errors.push(`${error}: ${raw}`);
      continue;
    }
    const parent = el.depth > 0 ? (stack[el.depth - 1] ?? -1) : -1;
    if (el.depth > 0 && parent === -1) errors.push(`indented line with no parent: ${raw}`);
    stack[el.depth] = lines.length;
    stack.length = el.depth + 1;
    lines.push({ ...el, parent });
  }
  const elements = lines.filter((l): l is ElementLine => l.kind === 'element');
  const seen = new Set<string>();
  for (const e of elements) {
    if (seen.has(e.ref)) errors.push(`duplicate ref ${e.ref}`);
    seen.add(e.ref);
  }
  return { header, lines, elements, footer, errors };
}

export interface Match {
  role?: string;
  name?: string | RegExp;
}

function nameMatches(el: ElementLine, name: string | RegExp | undefined): boolean {
  if (name === undefined) return true;
  if (typeof name === 'string') return el.name === name;
  return el.name !== null && name.test(el.name);
}

export function findAll(snap: Snapshot | ElementLine[], m: Match): ElementLine[] {
  const els = Array.isArray(snap) ? snap : snap.elements;
  return els.filter((e) => (m.role === undefined || e.role === m.role) && nameMatches(e, m.name));
}

export function findOne(snap: Snapshot | ElementLine[], m: Match): ElementLine {
  const hits = findAll(snap, m);
  if (hits.length !== 1) {
    const els = Array.isArray(snap) ? snap : snap.elements;
    throw new Error(
      `expected exactly one ${m.role ?? '*'} ${String(m.name ?? '')}, found ${hits.length}. Elements:\n` +
        els.map((e) => e.raw).join('\n').slice(0, 4000),
    );
  }
  return hits[0]!;
}

/** "find line by role+name → ref" */
export function refOf(snap: Snapshot | ElementLine[], role: string, name: string | RegExp): string {
  return findOne(snap, { role, name }).ref;
}

/** Element lines nested (at any depth) under the element at index `idx`. */
export function descendants(snap: Snapshot, el: ElementLine): BodyLine[] {
  const idx = snap.lines.indexOf(el);
  const out: BodyLine[] = [];
  for (let i = idx + 1; i < snap.lines.length; i++) {
    const l = snap.lines[i]!;
    if (l.depth <= el.depth) break;
    out.push(l);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// find results: "Each hit is a snapshot-grammar line with its ref, followed by `  in <context>`".
// CONTRACT-QUESTION: is `  in …` on the same line as the hit, or on the next line? Both are accepted.

export interface FindHit {
  el: Omit<ElementLine, 'parent'>;
  context: string | null;
}

export function parseFindHits(text: string): FindHit[] {
  const hits: FindHit[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trimStart();
    if (line.startsWith('in ') && hits.length > 0 && hits[hits.length - 1]!.context === null) {
      hits[hits.length - 1]!.context = line.slice(3);
      continue;
    }
    if (!line.startsWith('- ')) continue;
    const sameLine = /^(.*?)  in (.*)$/.exec(line);
    const candidates = sameLine ? [sameLine[1]!, line] : [line];
    for (const c of candidates) {
      const { el } = parseElementLine(c);
      if (el) {
        hits.push({ el: { ...el, depth: 0 }, context: sameLine && c === sameLine[1] ? sameLine[2]! : null });
        break;
      }
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------------------------
// Effect lines (PLAN.md "Effect summary"): `→ ` is U+2192 + space.

export const ARROW = '→ ';

export type Effect =
  | { kind: 'navigated'; url: string; title: string; status: string }
  | { kind: 'url'; url: string }
  | { kind: 'new tab'; tab: string; url: string }
  | { kind: 'tab closed'; tab: string }
  | { kind: 'dialog pending'; type: string; message: string }
  | { kind: 'dialog accepted'; type: string; message: string }
  | { kind: 'download'; path: string; size: string }
  | { kind: 'alert'; text: string }
  | { kind: 'console'; count: number; first: string }
  | { kind: 'blocked'; url: string; reason: string }
  | { kind: 'unknown'; raw: string };

const EFFECTS: [RegExp, (m: RegExpExecArray) => Effect][] = [
  [new RegExp(String.raw`^→ navigated (\S+) (${JSTR}) \(([^)]*)\)$`), (m) => ({ kind: 'navigated', url: m[1]!, title: JSON.parse(m[2]!) as string, status: m[3]! })],
  [/^→ url (\S+)$/, (m) => ({ kind: 'url', url: m[1]! })],
  [/^→ new tab (t\d+) (\S+)$/, (m) => ({ kind: 'new tab', tab: m[1]!, url: m[2]! })],
  [/^→ tab closed (t\d+)$/, (m) => ({ kind: 'tab closed', tab: m[1]! })],
  [new RegExp(String.raw`^→ dialog pending (alert|confirm|prompt|beforeunload) (${JSTR}) \(use dialog accept\|dismiss\)$`), (m) => ({ kind: 'dialog pending', type: m[1]!, message: JSON.parse(m[2]!) as string })],
  [new RegExp(String.raw`^→ dialog accepted (alert|confirm|prompt|beforeunload) (${JSTR})$`), (m) => ({ kind: 'dialog accepted', type: m[1]!, message: JSON.parse(m[2]!) as string })],
  [/^→ download (\/.+) \(([^)]+)\)$/, (m) => ({ kind: 'download', path: m[1]!, size: m[2]! })],
  [new RegExp(String.raw`^→ alert (${JSTR})$`), (m) => ({ kind: 'alert', text: JSON.parse(m[1]!) as string })],
  [/^→ console (\d+) new errors?: (.*)$/, (m) => ({ kind: 'console', count: Number(m[1]), first: m[2]! })],
  // PLAN amendment "decisions from the three review lenses" 1: `→ blocked <url> (<reason>)`
  [/^→ blocked (\S+) \((.+)\)$/, (m) => ({ kind: 'blocked', url: m[1]!, reason: m[2]! })],
];

/** All `→ ` lines in a result, parsed. Unparseable arrow lines come back as kind 'unknown'. */
export function parseEffects(text: string): Effect[] {
  const out: Effect[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith(ARROW)) continue;
    let e: Effect = { kind: 'unknown', raw: line };
    for (const [re, mk] of EFFECTS) {
      const m = re.exec(line);
      if (m) {
        e = mk(m);
        break;
      }
    }
    out.push(e);
  }
  return out;
}

/** The first `[tN]` token of a result, e.g. "t3". */
export function tabIdOf(text: string): string | null {
  return /\[(t\d+)\]/.exec(text)?.[1] ?? null;
}

/** `tabs list` lines: `t1 "Title" https://url (active)` plus an optional ` dialog=<type>` and ` crashed`. */
export interface TabLine {
  id: string;
  title: string;
  url: string;
  active: boolean;
  dialog: string | null;
  crashed: boolean;
  raw: string;
}

const TAB_LINE_RE = new RegExp(String.raw`^(t\d+) (${JSTR}) (\S+)((?: \(active\)| dialog=[a-z]+| crashed)*)$`);

export function parseTabsList(text: string): TabLine[] {
  const out: TabLine[] = [];
  for (const raw of text.split('\n')) {
    const m = TAB_LINE_RE.exec(raw.trim());
    if (!m) continue;
    const tail = m[4] ?? '';
    out.push({
      id: m[1]!,
      title: JSON.parse(m[2]!) as string,
      url: m[3]!,
      active: tail.includes('(active)'),
      dialog: /dialog=([a-z]+)/.exec(tail)?.[1] ?? null,
      crashed: / crashed\b/.test(tail),
      raw,
    });
  }
  return out;
}

/** `frame <i>/<n> @ <mm:ss.ss>` labels of video frames, in order, as seconds. */
export function parseFrameLabels(text: string): { i: number; n: number; seconds: number }[] {
  const out: { i: number; n: number; seconds: number }[] = [];
  for (const m of text.matchAll(/frame (\d+)\/(\d+) @ (\d+):(\d{2}(?:\.\d+)?)/g)) {
    out.push({ i: Number(m[1]), n: Number(m[2]), seconds: Number(m[3]) * 60 + Number(m[4]) });
  }
  return out;
}

/** `mm:ss.ss` -> seconds */
export function mmss(s: string): number {
  const m = /^(\d+):(\d{2}(?:\.\d+)?)$/.exec(s);
  if (!m) throw new Error(`not mm:ss.ss: ${s}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

// ---------------------------------------------------------------------------------------------
// `video list` line, PLAN contract answer 14 as amended by review-lens decision 7:
// `<ref> frame=<fN> src=<JSON> duration=<s.ss|Infinity|unknown> time=<s.ss> paused=<bool> muted=<bool>
//  volume=<0..1> rate=<x> size=<w>x<h> ready=<0-4> tracks=<n>`

export interface VideoLine {
  ref: string;
  frame: string;
  src: string;
  /** seconds, Infinity, or null for `unknown` */
  duration: number | null;
  time: number;
  paused: boolean;
  muted: boolean;
  volume: number;
  rate: number;
  width: number;
  height: number;
  ready: number;
  tracks: number;
  raw: string;
}

const VIDEO_RE = new RegExp(
  String.raw`^(e\d+) frame=(f\d+) src=(${JSTR}) duration=(\d+(?:\.\d+)?|Infinity|unknown) time=(\d+(?:\.\d+)?) ` +
    String.raw`paused=(true|false) muted=(true|false) volume=(\d+(?:\.\d+)?) rate=(\d+(?:\.\d+)?) size=(\d+)x(\d+) ready=([0-4]) tracks=(\d+)$`,
);

export function parseVideoLine(line: string): VideoLine | null {
  const m = VIDEO_RE.exec(line.trim());
  if (!m) return null;
  const d = m[4]!;
  return {
    ref: m[1]!,
    frame: m[2]!,
    src: JSON.parse(m[3]!) as string,
    duration: d === 'unknown' ? null : d === 'Infinity' ? Infinity : Number(d),
    time: Number(m[5]),
    paused: m[6] === 'true',
    muted: m[7] === 'true',
    volume: Number(m[8]),
    rate: Number(m[9]),
    width: Number(m[10]),
    height: Number(m[11]),
    ready: Number(m[12]),
    tracks: Number(m[13]),
    raw: line,
  };
}

/** All video lines of a `video list` result; lines that look like a video line but do not parse throw. */
export function parseVideoList(text: string): VideoLine[] {
  const out: VideoLine[] = [];
  for (const l of text.split('\n')) {
    if (!/^e\d+ frame=/.test(l.trim())) continue;
    const v = parseVideoLine(l);
    if (!v) throw new Error(`video list line does not match answer 14: ${l}`);
    out.push(v);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// `console` output (PLAN line form + review-lens decision 3): `[level] hh:mm:ss.mmm <message> (<url>:<line>)`,
// continuation lines of a multi-line message start with `  | `.

export interface ConsoleEntry {
  level: string;
  time: string;
  /** first line of the message (location suffix included when it is on this line) */
  first: string;
  continuations: string[];
}

export function parseConsole(text: string): { entries: ConsoleEntry[]; stray: string[] } {
  const entries: ConsoleEntry[] = [];
  const stray: string[] = [];
  for (const l of text.split('\n')) {
    const m = /^\[([a-z]+)\] (\d{2}:\d{2}:\d{2}\.\d{3}) (.*)$/.exec(l);
    if (m) {
      entries.push({ level: m[1]!, time: m[2]!, first: m[3]!, continuations: [] });
      continue;
    }
    if (l.startsWith('  | ') && entries.length > 0) {
      entries[entries.length - 1]!.continuations.push(l.slice(4));
      continue;
    }
    if (l.trim() !== '') stray.push(l);
  }
  return { entries, stray };
}
