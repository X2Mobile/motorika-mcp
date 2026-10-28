// Secrets in output (PLAN amendment "decisions from the three review lenses", item 5):
// - values the server typed into password fields are remembered for the life of the process and printed
//   as <redacted> in every result;
// - in every URL the server prints, query parameters with a secret-like name have their values redacted.

import { Automaton, claimSecrets, decode, emitText, type Matchers } from './secret-match.js';

export const REDACTED = '<redacted>';

/**
 * Query parameter names whose values are redacted in printed URLs, matched as a word part
 * (re-check item 6), so `author` and `passengers` are left alone. Round 4, F3: `[` and `]` separate words
 * too, so the bracket form `user[password]=` (Rails, PHP) is redacted.
 */
export const SECRET_PARAM = /(^|[_.\-[\]])(pass(word)?|passwd|pwd|secret|token|api[-_]?key|auth|authorization)($|[_.\-[\]])/i;

/**
 * P11: a parameter name is secret when SECRET_PARAM matches it with camelCase word starts turned into
 * `_` first, so `accessToken`, `apiKey` and `APIKey` match and `author` still does not.
 */
export function isSecretParam(name: string): boolean {
  const words = name.replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, '$1_$2').replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1_$2');
  return SECRET_PARAM.test(words);
}

const hex = (c: string): string => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`;

/**
 * P11: the spellings a secret takes in a URL or a form body: encodeURIComponent, the same with `+` for a
 * space, form-urlencoded (Chrome's GET form: `!` is `%21`, `*` kept) and fully percent-encoded.
 */
export function encodedForms(value: string): string[] {
  let uri: string;
  try {
    uri = encodeURIComponent(value);
  } catch {
    // Round 7b: a lone surrogate (URIError) has no URL encoding; the raw and JSON spellings remain, and
    // urlPattern covers its URL spelling (`%EF%BF%BD`). rememberSecret used to throw here.
    return [value, ...(jsonForm(value) === value ? [] : [jsonForm(value)])];
  }
  const form = uri.replace(/[!'()~]/g, hex);
  const full = uri.replace(/[!'()*~]/g, hex);
  const out = [value];
  for (const v of [uri, uri.replace(/%20/g, '+'), form.replace(/%20/g, '+'), form, full, full.replace(/%20/g, '+')]) if (!out.includes(v)) out.push(v);
  // Round 4, F3: the spelling inside a JSON-quoted result (`Hu"nt\er2!` prints as `Hu\"nt\\er2!`).
  const json = jsonForm(value);
  if (!out.includes(json)) out.push(json);
  return out;
}

/** Literals shorter than this are not scrubbed: they would match ordinary text everywhere (re-check item 6). */
export const MIN_SECRET_LEN = 6;
/** At most this many secrets are remembered; the most recent are kept (re-check item 6). */
export const MAX_SECRETS = 64;

/**
 * Words the output grammar itself prints as tokens: roles and ref or tab ids. A literal equal to one is
 * not remembered, because scrubbing it would corrupt every snapshot line (re-check item 6: roles and
 * ref tokens are never altered).
 */
const GRAMMAR_WORDS = new Set([
  'alert', 'alertdialog', 'application', 'article', 'audio', 'banner', 'blockquote', 'button', 'canvas', 'caption', 'cell',
  'checkbox', 'code', 'columnheader', 'combobox', 'complementary', 'contentinfo', 'definition', 'deletion', 'dialog',
  'directory', 'document', 'emphasis', 'feed', 'figure', 'file', 'form', 'generic', 'grid', 'gridcell', 'group', 'heading',
  'iframe', 'img', 'insertion', 'link', 'list', 'listbox', 'listitem', 'log', 'main', 'marquee', 'math', 'menu', 'menubar',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'meter', 'navigation', 'none', 'note', 'option', 'paragraph',
  'presentation', 'progressbar', 'radio', 'radiogroup', 'region', 'row', 'rowgroup', 'rowheader', 'scrollbar', 'search',
  'searchbox', 'separator', 'slider', 'spinbutton', 'status', 'strong', 'subscript', 'superscript', 'switch', 'tab',
  'table', 'tablist', 'tabpanel', 'term', 'textbox', 'time', 'timer', 'toolbar', 'tooltip', 'tree', 'treegrid',
  'treeitem', 'video', 'focused', 'checked', 'disabled', 'expanded', 'selected', 'required', 'redacted',
]);
const GRAMMAR_TOKEN = /^[et]\d+$/i;

/** Insertion order is recency: the oldest entry is evicted first. */
const secrets = new Map<string, Spellings>();

/** A remembered secret's spellings, built on demand. */
interface Spellings {
  /** Literal spellings for the raw view (today's scrub list): the value, its URL and JSON encodings. */
  literals: string[];
  /** Decoded forms for text and for a printed URL (secret-match.ts). */
  text?: Uint8Array[];
  url?: Uint8Array[];
}

/**
 * Secrets in text paths: the characters of `v` that are read as an escape when written raw: `%` before two hex
 * digits, and in text a backslash. Each subset of them written escaped (the rest raw) is one spelling to match.
 */
function specials(v: string, json: boolean): number[] {
  const out: number[] = [];
  for (let i = 0; i < v.length; i++) {
    if (v[i] === '%' && /^[0-9a-fA-F]{2}$/.test(v.slice(i + 1, i + 3))) out.push(i);
    else if (json && v[i] === '\\') out.push(i);
  }
  return out;
}
/**
 * Up to this many such characters, in a secret up to MAX_MIX_LEN long, every mix is matched (at most 16 forms);
 * otherwise all raw and all escaped, so 64 long page-chosen secrets cannot grow the automata 16-fold.
 */
const MAX_SPECIAL_MIX = 4;
const MAX_MIX_LEN = 128;

/**
 * The decoded forms of `v` (UTF-8 bytes, as secret-match.ts reads text): `v` itself, and `v` as the text reader
 * sees it when its `%XX`-like or backslash sequences are written raw. A form that reads as a grammar word or is
 * shorter than MIN_SECRET_LEN is dropped (`%62utton` written raw reads `button`; its literal still matches).
 */
function decodedForms(v: string, json: boolean): Uint8Array[] {
  const sp = specials(v, json);
  const spell = (escaped: (k: number) => boolean): string => {
    let out = '';
    let last = 0;
    sp.forEach((i, k) => {
      out += v.slice(last, i) + (escaped(k) ? (v[i] === '%' ? '%25' : '%5C') : v[i]);
      last = i + 1;
    });
    return out + v.slice(last);
  };
  const choices: ((k: number) => boolean)[] =
    sp.length <= MAX_SPECIAL_MIX && v.length <= MAX_MIX_LEN
      ? Array.from({ length: 1 << sp.length }, (_, m) => (k: number) => ((m >> k) & 1) === 1)
      : [() => false, () => true];
  const out: Uint8Array[] = [];
  const seen = new Set<string>();
  for (const c of choices) {
    const d = decode(spell(c), json);
    const bytes = d.bytes.slice(0, d.len);
    const key = Buffer.from(bytes).toString('latin1');
    if (seen.has(key)) continue;
    seen.add(key);
    const text = Buffer.from(bytes).toString('utf8');
    const word = text.trim();
    if (text.length < MIN_SECRET_LEN || GRAMMAR_WORDS.has(word.toLowerCase()) || GRAMMAR_TOKEN.test(word)) continue;
    out.push(bytes);
  }
  return out;
}
function formsOf(value: string, sp: Spellings, json: boolean): Uint8Array[] {
  if (json) return (sp.text ??= decodedForms(value, true));
  if (sp.url) return sp.url;
  const j = jsonForm(value);
  return (sp.url = j === value ? decodedForms(value, false) : [...decodedForms(value, false), ...decodedForms(j, false)]);
}
const codeUnits = (s: string): Uint16Array => {
  const u = new Uint16Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
};

/** The automata over every remembered secret (secret-match.ts), built on first use after a change. */
let built: { raw?: Automaton; text?: Automaton; url?: Automaton; plainText?: Automaton; plainUrl?: Automaton } = {};
function literalUnits(): Uint16Array[] {
  const out: Uint16Array[] = [];
  for (const sp of secrets.values()) for (const l of sp.literals) out.push(codeUnits(l));
  return out;
}
function plainUnits(json: boolean): Uint16Array[] {
  const out = literalUnits();
  for (const [value, sp] of secrets) {
    for (const f of formsOf(value, sp, json)) {
      const t = Buffer.from(f).toString('utf8');
      // A form that is not valid UTF-8 comes from an escape in the text; a text without escapes cannot hold it.
      if (Buffer.from(t, 'utf8').equals(Buffer.from(f))) out.push(codeUnits(t));
    }
  }
  return out;
}
const matchers: Matchers = {
  raw: () => (built.raw ??= new Automaton(literalUnits(), 0x10000)),
  decoded: (json) => {
    const forms = (): Uint8Array[] => [...secrets].flatMap(([value, sp]) => formsOf(value, sp, json));
    return json ? (built.text ??= new Automaton(forms(), 256)) : (built.url ??= new Automaton(forms(), 256));
  },
  plain: (json) => (json ? (built.plainText ??= new Automaton(plainUnits(true), 0x10000)) : (built.plainUrl ??= new Automaton(plainUnits(false), 0x10000))),
};

/** The JSON-escaped spelling of a secret (round 4, F3: `Hu"nt\er2!` prints as `Hu\"nt\\er2!` in a quoted result). */
function jsonForm(value: string): string {
  return JSON.stringify(value).slice(1, -1).replace(/[\u2028\u2029\u0085]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function rebuild(): void {
  built = {};
}

/** Remember a value the server typed into a password field. */
export function rememberSecret(value: string): void {
  if (value.length < MIN_SECRET_LEN || GRAMMAR_WORDS.has(value.toLowerCase()) || GRAMMAR_TOKEN.test(value)) return;
  secrets.delete(value); // re-typing refreshes its recency
  // A secret also appears URL-encoded (GET forms, query strings), P11.
  secrets.set(value, { literals: encodedForms(value) });
  while (secrets.size > MAX_SECRETS) {
    const oldest = secrets.keys().next().value;
    if (oldest === undefined) break;
    secrets.delete(oldest);
  }
  rebuild();
}

/**
 * Replace every remembered secret with <redacted>, only as a whole token: no letter or digit directly before or
 * after it. Secrets in text paths: a `%XX` escape next to it is a token edge too, and it is matched in its literal,
 * percent-encoded and JSON-escaped spellings and any mix of them (secret-match.ts). With nothing remembered, or
 * nothing found, the text is returned as it is.
 */
export function scrubSecrets(text: string): string {
  if (secrets.size === 0 || text.length === 0) return text;
  const claimed = new Uint8Array(text.length);
  if (!claimSecrets(text, true, claimed, matchers)) return text;
  claimParamsOfTouchedUrls(text, claimed);
  return emitText(text, claimed, REDACTED);
}

// ---- Fix round 2 (review of ee4c863, C1): the parameters of every URL a scrub redacts something in ----
//
// The dispatcher's net (redactPrintedUrls) reads a URL up to a `<`, and read, console and evaluate scrub before it
// does. So once a scrub put a `<redacted>` inside a URL in page text, the secret-named parameters after it printed in
// clear (`?q=%27<redacted>%27&token=…`). The scrub itself now checks the parameters of each URL that holds one of its
// claims, on the text before the marker is printed. A URL run starts at a `scheme://` (no word edge needed: a URL
// can be glued after the secret) and goes on over URL characters and claimed runs. It is parsed as one URL (what the
// net would have read with the secret in place) and from each `scheme://` inside it (a URL glued after the secret),
// so it never hides less than the net. URLs holding no claim are left to the net, as before.

const SCHEME_AT = /(?:https?|wss?|file):\/\//g;
/** The net's URL stop characters (dispatch.ts PRINTED_URL): whitespace (JS `\s`), quotes, angle brackets, backslash. */
function urlStop(c: number): boolean {
  if (c < 0x80) return c === 0x20 || (c >= 0x09 && c <= 0x0d) || c === 0x22 || c === 0x27 || c === 0x3c || c === 0x3e || c === 0x5c;
  return c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}
const PEEL = new Set([0x29, 0x5d, 0x2e, 0x2c, 0x3b, 0x3a, 0x21, 0x3f]); // ) ] . , ; : ! ? (dispatch.ts trailingPunctStart)
/** PAIR as a reusable global scanner for claimParamsOfTouchedUrls (made on first use: PAIR is declared below). */
let pairScan: RegExp | undefined;

/** Whether a raw parameter name is secret, as claimParams decides it; cached, since a page repeats its names. */
const rawNameCache = new Map<string, boolean>();
function secretRawName(rawName: string): boolean {
  let v = rawNameCache.get(rawName);
  if (v !== undefined) return v;
  let name = rawName.replace(URL_UNSAFE_G, pct);
  try {
    name = decodeURIComponent(name.replace(/\+/g, ' '));
  } catch {
    /* keep the encoded name */
  }
  v = isSecretParam(name);
  if (rawNameCache.size >= 4096) rawNameCache.clear();
  rawNameCache.set(rawName, v);
  return v;
}

function claimParamsOfTouchedUrls(s: string, claimed: Uint8Array): void {
  const n = s.length;
  /** Claims the values of secret-named parameters in the URL s[a, b), after peeling trailing punctuation. */
  const parse = (a: number, b: number): void => {
    while (b > a && claimed[b - 1] !== 1 && PEEL.has(s.charCodeAt(b - 1))) b--;
    const u = s.slice(a, b);
    const hashAt = u.indexOf('#');
    const beforeHash = hashAt < 0 ? u : u.slice(0, hashAt);
    const q = beforeHash.indexOf('?');
    if (q >= 0) claimPairs(a + q + 1, beforeHash.slice(q + 1));
    if (hashAt >= 0) claimPairs(a + hashAt + 1, u.slice(hashAt + 1));
  };
  const claimPairs = (at: number, part: string): void => {
    const pair = (pairScan ??= new RegExp(PAIR.source, 'g')); // one shared scanner: parse is not re-entrant
    pair.lastIndex = 0;
    for (let m = pair.exec(part); m; m = pair.exec(part)) {
      const [whole, pre, rawName, value] = m as unknown as [string, string, string, string];
      if (whole.length === 0) {
        pair.lastIndex++;
        continue;
      }
      if (value === '' || value === REDACTED || !secretRawName(rawName)) continue;
      const start = at + m.index + pre.length + rawName.length + 1;
      claimed.fill(1, start, start + value.length);
    }
  };
  const inner: number[] = [];
  SCHEME_AT.lastIndex = 0;
  let m = SCHEME_AT.exec(s);
  while (m) {
    // One run: from this scheme over URL characters and claimed runs. Whether it holds a claim is read before any
    // parameter of it is claimed; runs never overlap, so a later run's extent is not changed by these claims.
    const from = m.index;
    let end = from;
    let hit = false;
    while (end < n) {
      if (claimed[end] === 1) hit = true;
      else if (urlStop(s.charCodeAt(end))) break;
      end++;
    }
    inner.length = 0;
    for (m = SCHEME_AT.exec(s); m && m.index < end; m = SCHEME_AT.exec(s)) inner.push(m.index);
    if (!hit) continue;
    parse(from, end);
    for (let k = 0; k < inner.length; k++) parse(inner[k] as number, inner[k + 1] ?? end);
  }
}

/** name=value pairs at the start of a query or fragment part, or after `?`, `&` or `;`. */
const PAIR = /(^|[?&;])([^=&?;#]*)=([^&;#]*)/g;

function redactPairs(part: string): string {
  return part.replace(PAIR, (m: string, pre: string, rawName: string, value: string) => {
    if (value === '' || value === REDACTED) return m;
    let name = rawName;
    try {
      name = decodeURIComponent(rawName.replace(/\+/g, ' '));
    } catch {
      /* keep raw */
    }
    return isSecretParam(name) ? `${pre}${rawName}=${REDACTED}` : m;
  });
}

/**
 * Redact the values of secret-named parameters in the query and, P11, in the fragment (`#access_token=`,
 * `#/cb?token=`). Anything else is unchanged.
 */
export function redactUrlParams(url: string): string {
  const hashAt = url.indexOf('#');
  const beforeHash = hashAt < 0 ? url : url.slice(0, hashAt);
  const q = beforeHash.indexOf('?');
  const head = q < 0 ? beforeHash : `${beforeHash.slice(0, q + 1)}${redactPairs(beforeHash.slice(q + 1))}`;
  if (hashAt < 0) return head;
  return `${head}#${redactPairs(url.slice(hashAt + 1))}`;
}

/**
 * Round 7 (item 7): characters a printed URL never carries raw: whitespace (every Unicode space and line
 * separator), quotes, angle brackets, backslash, backtick and the C0/DEL/C1 controls. A data: URL (a
 * cross-origin frame can navigate itself to one) printed raw broke the header grammar with its spaces and
 * quotes and showed `e99999` as a token.
 */
const URL_UNSAFE_G = /[\s"'<>\\`\u0000-\u001f\u007f-\u009f]/g;

/** Percent-encodes `c` (its UTF-8 bytes). */
function pct(c: string): string {
  return [...Buffer.from(c, 'utf8')].map((b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join('');
}

// ---- Round 7b (C1): one walk over the raw URL ----
//
// Round 7 percent-encoded first and redacted after, so a secret next to a character it encoded (`'`, `\\`, a space)
// got a hex digit glued to it (`%27Hunter2xZ%27`) and the whole-token rule refused it. Now the raw URL is claimed
// first: the values of secret-named parameters, then every remembered secret in any URL spelling (secret-match.ts,
// without JSON escapes: a printed URL is raw), where a `%XX` escape is one unit that is never split and counts as a
// token edge. Claimed runs print as `<redacted>`; everything else is percent-encoded (URL_UNSAFE_G), so a
// `<redacted>` in a printed URL is always ours, never page text. Since "secrets in text paths" all other text uses
// the same matcher with JSON escapes (scrubSecrets).

/** Claims the values of secret-named parameters (the rules of redactUrlParams, on the raw URL). */
function claimParams(url: string, claimed: Uint8Array): void {
  const hashAt = url.indexOf('#');
  const beforeHash = hashAt < 0 ? url : url.slice(0, hashAt);
  const q = beforeHash.indexOf('?');
  const parts: [number, string][] = [];
  if (q >= 0) parts.push([q + 1, beforeHash.slice(q + 1)]);
  if (hashAt >= 0) parts.push([hashAt + 1, url.slice(hashAt + 1)]);
  for (const [at, part] of parts) {
    const pair = new RegExp(PAIR.source, 'g');
    for (let m = pair.exec(part); m; m = pair.exec(part)) {
      const [whole, pre, rawName, value] = m as unknown as [string, string, string, string];
      if (whole.length === 0) {
        pair.lastIndex++;
        continue;
      }
      if (value === '') continue;
      // The name as round 7 checked it (after encoding), so the parameter rules are unchanged (AC3).
      let name = rawName.replace(URL_UNSAFE_G, pct);
      try {
        name = decodeURIComponent(name.replace(/\+/g, ' '));
      } catch {
        /* keep the encoded name */
      }
      if (!isSecretParam(name)) continue;
      const start = at + m.index + pre.length + rawName.length + 1;
      claimed.fill(1, start, start + value.length);
    }
  }
}

function claimUrl(url: string): Uint8Array {
  const claimed = new Uint8Array(url.length);
  claimParams(url, claimed);
  if (secrets.size > 0) claimSecrets(url, false, claimed, matchers);
  return claimed;
}

/** Claimed runs become one `<redacted>` each; `plain` renders the text between them. */
function emit(url: string, claimed: Uint8Array, plain: (s: string) => string): string {
  let out = '';
  for (let i = 0; i < url.length; ) {
    let j = i;
    const c = claimed[i];
    while (j < url.length && claimed[j] === c) j++;
    out += c === 1 ? REDACTED : plain(url.slice(i, j));
    i = j;
  }
  return out;
}

/**
 * A URL for output: secret parameters redacted, remembered secrets redacted in any URL spelling, and one
 * token (URL_UNSAFE_G percent-encoded around the `<redacted>` markers).
 */
export function safeUrl(url: string): string {
  return emit(url, claimUrl(url), (s) => s.replace(URL_UNSAFE_G, pct));
}

/** The same redaction for a URL printed inside a JSON string (a snapshot line's `href=`): nothing encoded. */
export function redactUrl(url: string): string {
  return emit(url, claimUrl(url), (s) => s);
}

/** Test hook: forget every remembered secret. */
export function resetSecretsForTest(): void {
  secrets.clear();
  built = {};
}
