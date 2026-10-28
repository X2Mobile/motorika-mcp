// Matching remembered secrets in output (PLAN.md "2026-10-26: secrets in text paths").
//
// The text is read two ways at once, each with one Aho-Corasick automaton over every remembered secret, so a pass
// costs O(text) whatever the number or length of the secrets (round 7b's regex per secret cost text x secret):
// - the raw view: the text's UTF-16 code units against literal spellings (secrets.ts encodedForms);
// - the decoded view: the text as UTF-8 bytes, where a `%XX` escape (hex in either case) is its byte, a `+` is a
//   space and, in text (not in a printed URL), a JSON escape (`\"`, `\\`, `\n`, `\u2028` ...) is its character's
//   bytes. A secret's decoded forms are matched there, so any mix of raw, percent-encoded and JSON-escaped characters
//   is one pattern.
// When the text holds no `%`, `\` or `+`, both views are the same text: one automaton over code units runs instead.
//
// A match is redacted only as a whole token. Its edges: the text's start or end, a `%XX` escape (whatever it decodes
// to), a JSON escape in text, a character that is not a letter or digit, or a position already claimed. Matches are
// resolved to the least fixpoint of that rule with a work list: a claimed run is an edge for its neighbours, so
// touching and overlapping secrets are all redacted, in any order of remembering; overlapping claims merge.

/** A letter or digit (Unicode). */
const LETTER_OR_DIGIT = /^[\p{L}\p{N}]$/u;
const ldCache = new Map<number, boolean>();
function isLD(cp: number): boolean {
  if (cp < 0x80) return (cp >= 0x30 && cp <= 0x39) || ((cp | 0x20) >= 0x61 && (cp | 0x20) <= 0x7a);
  let v = ldCache.get(cp);
  if (v === undefined) {
    v = LETTER_OR_DIGIT.test(String.fromCodePoint(cp));
    if (ldCache.size > 4096) ldCache.clear();
    ldCache.set(cp, v);
  }
  return v;
}
/** The code point that ends just before index i (a surrogate pair counts as one). */
function cpBefore(s: string, i: number): number {
  const lo = s.charCodeAt(i - 1);
  if (lo >= 0xdc00 && lo <= 0xdfff && i >= 2) {
    const hi = s.charCodeAt(i - 2);
    if (hi >= 0xd800 && hi <= 0xdbff) return ((hi - 0xd800) << 10) + (lo - 0xdc00) + 0x10000;
  }
  return lo;
}
const isHexCode = (c: number): boolean => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
const hexVal = (c: number): number => (c <= 0x39 ? c - 0x30 : (c | 0x20) - 0x57);
/** A `%XX` escape starts at index i. Escapes never overlap: `%` is not a hex digit. */
export function escapeAt(s: string, i: number): boolean {
  return i >= 0 && i + 2 < s.length && s.charCodeAt(i) === 0x25 && isHexCode(s.charCodeAt(i + 1)) && isHexCode(s.charCodeAt(i + 2));
}

// ---- JSON escapes (round 4, F3; round 5, item 5): backslash runs, filled left to right on demand ----

let runs: { s: string; len: Int32Array; filled: number } | null = null;
/** How many backslashes end at index i (exclusive). An odd count means the next character is escaped. */
function backslashesBefore(s: string, i: number): number {
  if (i <= 0 || s.charCodeAt(i - 1) !== 0x5c) return 0;
  if (!runs || runs.s !== s) runs = { s, len: new Int32Array(s.length + 1), filled: 0 };
  const r = runs;
  for (let j = r.filled; j < i; j++) r.len[j + 1] = s.charCodeAt(j) === 0x5c ? (r.len[j] as number) + 1 : 0;
  if (i > r.filled) r.filled = i;
  return r.len[i] as number;
}
/** Index i is right after a JSON escape (`\n`, `\t`, `\u2028`): a secret there still starts a token. */
function jsonEscapeEndsAt(s: string, i: number): boolean {
  if (i >= 2 && 'bfnrt'.includes(s[i - 1] as string) && backslashesBefore(s, i - 1) % 2 === 1) return true;
  return i >= 6 && s.charCodeAt(i - 5) === 0x75 && s.charCodeAt(i - 6) === 0x5c && /^\\u[0-9a-fA-F]{4}$/.test(s.slice(i - 6, i)) && backslashesBefore(s, i - 5) % 2 === 1;
}
/** The character at index i is the second character of a JSON escape (a match may not start or end there). */
function insideJsonEscape(s: string, i: number): boolean {
  return i < s.length && backslashesBefore(s, i) % 2 === 1 && '"\\/bfnrtu'.includes(s[i] as string);
}

// ---- the automaton ----

/** Aho-Corasick over integer symbols (UTF-16 code units, or bytes). */
export class Automaton {
  private readonly root: Int32Array;
  private readonly oneSym: Int32Array;
  private readonly oneNext: Int32Array;
  private readonly many: (Map<number, number> | undefined)[];
  /** 1 for a node with several children (its transitions are in `many`). */
  private readonly branchy: Uint8Array;
  private readonly fail: Int32Array;
  /** Length of the pattern that ends at the node, 0 when none does. */
  readonly out: Int32Array;
  /** The nearest node on the fail chain (itself excluded) where a pattern ends, or -1. */
  readonly dict: Int32Array;

  constructor(patterns: ArrayLike<number>[], alphabet: number) {
    let cap = 1;
    for (const p of patterns) cap += p.length;
    const first = new Int32Array(cap).fill(-1);
    const sibling = new Int32Array(cap).fill(-1);
    const sym = new Int32Array(cap);
    const out = new Int32Array(cap);
    let n = 1;
    for (const p of patterns) {
      if (p.length === 0) continue;
      let node = 0;
      for (let i = 0; i < p.length; i++) {
        const c = p[i] as number;
        let ch = first[node] as number;
        while (ch >= 0 && sym[ch] !== c) ch = sibling[ch] as number;
        if (ch < 0) {
          ch = n++;
          sym[ch] = c;
          sibling[ch] = first[node] as number;
          first[node] = ch;
        }
        node = ch;
      }
      out[node] = p.length;
    }
    this.root = new Int32Array(alphabet).fill(-1);
    this.oneSym = new Int32Array(n).fill(-1);
    this.oneNext = new Int32Array(n).fill(-1);
    this.many = new Array<Map<number, number> | undefined>(n).fill(undefined);
    this.branchy = new Uint8Array(n);
    for (let ch = first[0] as number; ch >= 0; ch = sibling[ch] as number) this.root[sym[ch] as number] = ch;
    for (let v = 1; v < n; v++) {
      const f = first[v] as number;
      if (f < 0) continue;
      if ((sibling[f] as number) < 0) {
        this.oneSym[v] = sym[f] as number;
        this.oneNext[v] = f;
        continue;
      }
      const m = new Map<number, number>();
      for (let ch = f; ch >= 0; ch = sibling[ch] as number) m.set(sym[ch] as number, ch);
      this.many[v] = m;
      this.branchy[v] = 1;
    }
    this.out = out.subarray(0, n);
    this.fail = new Int32Array(n);
    this.dict = new Int32Array(n).fill(-1);
    const queue = new Int32Array(n);
    let qt = 0;
    for (let ch = first[0] as number; ch >= 0; ch = sibling[ch] as number) queue[qt++] = ch;
    for (let qh = 0; qh < qt; qh++) {
      const u = queue[qh] as number;
      for (let ch = first[u] as number; ch >= 0; ch = sibling[ch] as number) {
        const c = sym[ch] as number;
        let f = u === 0 ? 0 : (this.fail[u] as number);
        let g = this.step(f, c);
        while (g < 0 && f !== 0) {
          f = this.fail[f] as number;
          g = this.step(f, c);
        }
        const fl = u === 0 || g < 0 ? 0 : g;
        this.fail[ch] = fl;
        this.dict[ch] = (this.out[fl] as number) > 0 ? fl : (this.dict[fl] as number);
        queue[qt++] = ch;
      }
    }
  }

  /** The child of `node` on symbol `c`, or -1. */
  private step(node: number, c: number): number {
    if (node === 0) return c < this.root.length ? (this.root[c] as number) : -1;
    if (this.oneSym[node] === c) return this.oneNext[node] as number;
    return this.many[node]?.get(c) ?? -1;
  }

  /** Scans a string's code units; rec[i] is the node reached after unit i when a pattern ends there, else 0. */
  scanString(s: string, rec: Int32Array): boolean {
    const { root, oneSym, oneNext, many, branchy, fail, out, dict } = this;
    const rootLen = root.length;
    let node = 0;
    let any = false;
    for (let i = 0, len = s.length; i < len; i++) {
      const c = s.charCodeAt(i);
      for (;;) {
        if (node === 0) {
          const g = c < rootLen ? (root[c] as number) : -1;
          if (g >= 0) node = g;
          break;
        }
        if (oneSym[node] === c) {
          node = oneNext[node] as number;
          break;
        }
        if (branchy[node] === 1) {
          const g = (many[node] as Map<number, number>).get(c);
          if (g !== undefined) {
            node = g;
            break;
          }
        }
        node = fail[node] as number;
      }
      if ((out[node] as number) > 0 || (dict[node] as number) >= 0) {
        rec[i] = node;
        any = true;
      }
    }
    return any;
  }

  /** The same over bytes. */
  scanBytes(b: Uint8Array, len: number, rec: Int32Array): boolean {
    const { root, oneSym, oneNext, many, branchy, fail, out, dict } = this;
    let node = 0;
    let any = false;
    for (let i = 0; i < len; i++) {
      const c = b[i] as number;
      for (;;) {
        if (node === 0) {
          const g = root[c] as number;
          if (g >= 0) node = g;
          break;
        }
        if (oneSym[node] === c) {
          node = oneNext[node] as number;
          break;
        }
        if (branchy[node] === 1) {
          const g = (many[node] as Map<number, number>).get(c);
          if (g !== undefined) {
            node = g;
            break;
          }
        }
        node = fail[node] as number;
      }
      if ((out[node] as number) > 0 || (dict[node] as number) >= 0) {
        rec[i] = node;
        any = true;
      }
    }
    return any;
  }
}

// ---- the decoded view ----

export interface Decoded {
  bytes: Uint8Array;
  len: number;
  /** Per byte: where its token (a raw character, a `%XX` escape, a JSON escape) starts in the text. */
  start: Int32Array;
}

/** UTF-8 of one code point (a lone surrogate is U+FFFD, as Buffer encodes it). A `+` is a space (form encoding). */
function utf8(cp: number, put: (b: number) => void): void {
  if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd;
  if (cp < 0x80) put(cp === 0x2b ? 0x20 : cp);
  else if (cp < 0x800) {
    put(0xc0 | (cp >> 6));
    put(0x80 | (cp & 63));
  } else if (cp < 0x10000) {
    put(0xe0 | (cp >> 12));
    put(0x80 | ((cp >> 6) & 63));
    put(0x80 | (cp & 63));
  } else {
    put(0xf0 | (cp >> 18));
    put(0x80 | ((cp >> 12) & 63));
    put(0x80 | ((cp >> 6) & 63));
    put(0x80 | (cp & 63));
  }
}
const JSON_ESCAPE: Record<number, number> = { 0x22: 0x22, 0x5c: 0x5c, 0x2f: 0x2f, 0x62: 8, 0x66: 12, 0x6e: 10, 0x72: 13, 0x74: 9 };

/** The text as bytes: `%XX` its byte, `+` a space, and with json a JSON escape its character. */
export function decode(s: string, json: boolean): Decoded {
  const n = s.length;
  let cap = n + 16;
  let bytes = new Uint8Array(cap);
  let start = new Int32Array(cap);
  let len = 0;
  let tok = 0;
  const grow = (): void => {
    cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(bytes);
    bytes = nb;
    const ns = new Int32Array(cap);
    ns.set(start);
    start = ns;
  };
  const put = (b: number): void => {
    if (len === cap) grow();
    bytes[len] = b;
    start[len++] = tok;
  };
  for (let i = 0; i < n; ) {
    const c = s.charCodeAt(i);
    if (c === 0x25 && i + 2 < n && isHexCode(s.charCodeAt(i + 1)) && isHexCode(s.charCodeAt(i + 2))) {
      const b = (hexVal(s.charCodeAt(i + 1)) << 4) | hexVal(s.charCodeAt(i + 2));
      if (len === cap) grow();
      bytes[len] = b === 0x2b ? 0x20 : b;
      start[len++] = i;
      i += 3;
      continue;
    }
    if (c < 0x80 && !(json && c === 0x5c)) {
      if (len === cap) grow();
      bytes[len] = c === 0x2b ? 0x20 : c;
      start[len++] = i;
      i += 1;
      continue;
    }
    tok = i;
    if (json && c === 0x5c && i + 1 < n) {
      const e = JSON_ESCAPE[s.charCodeAt(i + 1)];
      if (e !== undefined) {
        put(e);
        i += 2;
        continue;
      }
      if (s.charCodeAt(i + 1) === 0x75 && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 2, i + 6))) {
        let cu = parseInt(s.slice(i + 2, i + 6), 16);
        let len = 6;
        // Fix round 2 (W1): a high-surrogate escape followed by a low-surrogate escape is one character, as an
        // ensure_ascii JSON encoder (Python's json.dumps) writes an emoji; alone, each half is U+FFFD as before.
        if (cu >= 0xd800 && cu <= 0xdbff && s.charCodeAt(i + 6) === 0x5c && s.charCodeAt(i + 7) === 0x75 && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 8, i + 12))) {
          const lo = parseInt(s.slice(i + 8, i + 12), 16);
          if (lo >= 0xdc00 && lo <= 0xdfff) {
            cu = ((cu - 0xd800) << 10) + (lo - 0xdc00) + 0x10000;
            len = 12;
          }
        }
        utf8(cu, put);
        i += len;
        continue;
      }
    }
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < n) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        utf8(((c - 0xd800) << 10) + (d - 0xdc00) + 0x10000, put);
        i += 2;
        continue;
      }
    }
    utf8(c, put);
    i += 1;
  }
  return { bytes, len, start };
}

// ---- claims ----

/** What claimSecrets needs from the remembered secrets: the automata, built on demand. */
export interface Matchers {
  /** Raw view over code units (literal spellings), and the decoded view over bytes, for text or a printed URL. */
  raw(): Automaton;
  decoded(json: boolean): Automaton;
  /** One automaton over code units for a text without `%`, `\` or `+`: the literals and the decoded forms. */
  plain(json: boolean): Automaton;
}

/**
 * Marks in `claimed` every whole-token occurrence of a remembered secret in `s` (json: `s` may hold JSON escapes,
 * as all output text does; false for a raw URL). Positions already set in `claimed` (secret-named parameters) count
 * as claimed. Returns whether anything new was claimed.
 */
export function claimSecrets(s: string, json: boolean, claimed: Uint8Array, m: Matchers): boolean {
  const n = s.length;
  const plain = s.indexOf('%') < 0 && s.indexOf('\\') < 0 && s.indexOf('+') < 0;
  const rawA = plain ? m.plain(json) : m.raw();
  const recR = new Int32Array(n);
  const anyR = rawA.scanString(s, recR);
  let dec: Decoded | undefined;
  let recD: Int32Array | undefined;
  let anyD = false;
  const decA = plain ? undefined : m.decoded(json);
  if (decA) {
    dec = decode(s, json);
    recD = new Int32Array(dec.len);
    anyD = decA.scanBytes(dec.bytes, dec.len, recD);
  }
  if (!anyR && !anyD) return false;

  // Static edges, on the raw text. A `%` is not a letter or digit, so an escape after a match needs no own check.
  const SL = (a: number): boolean =>
    a <= 0 || !isLD(cpBefore(s, a)) || escapeAt(s, a - 3) || (json && jsonEscapeEndsAt(s, a));
  /** The text itself gives a right edge at b: its end, or a character that is not a letter or digit. */
  const SR = (b: number): boolean => {
    if (b >= n) return true;
    const c = s.charCodeAt(b);
    if (c < 0x80) return !((c >= 0x30 && c <= 0x39) || ((c | 0x20) >= 0x61 && (c | 0x20) <= 0x7a));
    return !isLD(s.codePointAt(b) as number);
  };
  /** The right edge holds at b: statically, or b is claimed. */
  const R = (b: number): boolean => (b < n && claimed[b] === 1) || SR(b);
  // A match that starts or ends inside a `%XX` escape takes the whole escape (round 7b).
  const widenEnd = (b0: number): number => (plain ? b0 : escapeAt(s, b0 - 1) ? b0 + 2 : escapeAt(s, b0 - 2) ? b0 + 1 : b0);

  // Claim state, made on the first claim: `jump` skips claimed runs (0: not yet claimed here), `queue` the new ones.
  let jump: Int32Array | undefined;
  let queue: Int32Array | undefined;
  let qn = 0;
  /** The first position at or after p not yet claimed here (union-find with path compression; n is the end). */
  const find = (p: number): number => {
    const J = jump as Int32Array;
    let r = p;
    while (r < n && (J[r] as number) !== 0) r = J[r] as number;
    while (p < r) {
      const q = J[p] as number;
      J[p] = r;
      p = q;
    }
    return r;
  };
  const claim = (a: number, b: number): void => {
    jump ??= new Int32Array(n + 1);
    queue ??= new Int32Array(n);
    for (let p = find(a); p < b; p = find(p + 1)) {
      jump[p] = p + 1;
      if (claimed[p] === 1) continue; // a secret-named parameter's value: its edges held from the start
      claimed[p] = 1;
      queue[qn++] = p;
    }
  };
  /** Candidates whose right edge holds and whose left waits for position a-1 to be claimed: key a-1. */
  const waitLeft = new Map<number, number[]>();
  const offer = (a: number, b: number, leftStatic: boolean): boolean => {
    // A backslash right before either edge is the only way to be inside a JSON escape.
    if (json && ((a > 0 && s.charCodeAt(a - 1) === 0x5c) || (b > 0 && s.charCodeAt(b - 1) === 0x5c)) && (insideJsonEscape(s, a) || insideJsonEscape(s, b))) return false;
    if (leftStatic || (a > 0 && claimed[a - 1] === 1) || SL(a)) {
      claim(a, b);
      return true;
    }
    const w = waitLeft.get(a - 1);
    if (w) w.push(a, b);
    else waitLeft.set(a - 1, [a, b]);
    return false;
  };
  // A record's right edge holds: offer its matches, longest first; once one is claimed the shorter ones (same
  // end, later start) are inside it.
  const rOut = rawA.out;
  const rDict = rawA.dict;
  const walkRaw = (i: number, b: number): void => {
    const node = recR[i] as number;
    for (let x = (rOut[node] as number) > 0 ? node : (rDict[node] as number); x >= 0; x = rDict[x] as number) {
      const a0 = i + 1 - (rOut[x] as number);
      if (plain) {
        if (offer(a0, b, false)) return;
        continue;
      }
      const straddle = escapeAt(s, a0 - 1); // starts at an escape's first hex digit: the `%` before it is a non-letter
      const a = straddle ? a0 - 1 : escapeAt(s, a0 - 2) ? a0 - 2 : a0;
      if (offer(a, b, straddle)) return;
    }
  };
  const walkDec = (j: number, b: number): void => {
    const st = (dec as Decoded).start;
    const dOut = (decA as Automaton).out;
    const dDict = (decA as Automaton).dict;
    const node = (recD as Int32Array)[j] as number;
    for (let x = (dOut[node] as number) > 0 ? node : (dDict[node] as number); x >= 0; x = dDict[x] as number) {
      if (offer(st[j + 1 - (dOut[x] as number)] as number, b, false)) return;
    }
  };
  /** The raw end of the token whose last byte is j, or -1 when j is not a token's last byte. */
  const decEnd = (j: number): number => {
    const d = dec as Decoded;
    if (j + 1 >= d.len) return n;
    return d.start[j + 1] !== d.start[j] ? (d.start[j + 1] as number) : -1;
  };
  for (let i = 0; i < n; i++) {
    if (recR[i] === 0) continue;
    const b = plain ? i + 1 : widenEnd(i + 1);
    if (b < n && claimed[b] !== 1) {
      // Inline right edge for the common case: an ASCII letter or digit right after the match.
      const c = s.charCodeAt(b);
      if (c < 0x80 ? (c >= 0x30 && c <= 0x39) || ((c | 0x20) >= 0x61 && (c | 0x20) <= 0x7a) : !SR(b)) continue;
    }
    walkRaw(i, b);
  }
  if (recD) {
    for (let j = 0; j < recD.length; j++) {
      if (recD[j] === 0) continue;
      const b = decEnd(j);
      if (b >= 0 && R(b)) walkDec(j, b);
    }
  }
  if (qn === 0) {
    // Nothing claimed: a match waiting for a neighbour's claim can never get one.
    runs = null;
    return false;
  }
  // Matches without a static right edge wait for their end to be claimed: by end position (one raw and one
  // decoded record per end; widening can map up to three raw records to one end, the extra ones go to a map).
  const pendRaw = new Int32Array(n + 1);
  const pendRawMore = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    if (recR[i] === 0) continue;
    const b = widenEnd(i + 1);
    // By the static edge: a match whose end was claimed during the first pass is walked again when that
    // position is dequeued (a walk is idempotent).
    if (b > n || SR(b)) continue;
    if (pendRaw[b] === 0) pendRaw[b] = i + 1;
    else {
      const l = pendRawMore.get(b);
      if (l) l.push(i);
      else pendRawMore.set(b, [i]);
    }
  }
  const pendDec = recD ? new Int32Array(n + 1) : undefined;
  if (recD && pendDec) {
    for (let j = 0; j < recD.length; j++) {
      if (recD[j] === 0) continue;
      const b = decEnd(j);
      if (b >= 0 && !SR(b)) pendDec[b] = j + 1;
    }
  }
  // Newly claimed positions: the matches that end there get their right edge, those waiting on them their left.
  for (let qh = 0; qh < qn; qh++) {
    const p = (queue as Int32Array)[qh] as number;
    if ((pendRaw[p] as number) !== 0) {
      walkRaw((pendRaw[p] as number) - 1, p);
      for (const i of pendRawMore.get(p) ?? []) walkRaw(i, p);
    }
    if (pendDec && (pendDec[p] as number) !== 0) walkDec((pendDec[p] as number) - 1, p);
    if (waitLeft.size === 0) continue;
    const w = waitLeft.get(p);
    if (w) {
      waitLeft.delete(p);
      for (let k = 0; k < w.length; k += 2) claim(w[k] as number, w[k + 1] as number);
    }
  }
  runs = null;
  return qn > 0;
}

// ---- output ----

/**
 * The partner of every `"` that delimits a JSON string, -1 elsewhere. Lines are read as a consumer reads them: a
 * `"` opens a string that must be valid JSON and end on its line; after an invalid one the rest of the line is not
 * read as strings.
 */
function quotePartners(s: string): Int32Array {
  const n = s.length;
  const partner = new Int32Array(n).fill(-1);
  const isBreak = (c: number): boolean => c === 0x0a || c === 0x0d || c === 0x0b || c === 0x0c || c === 0x85 || c === 0x2028 || c === 0x2029;
  let i = 0;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c !== 0x22) {
      i++;
      continue;
    }
    let j = i + 1;
    let ok = false;
    while (j < n) {
      const d = s.charCodeAt(j);
      if (d === 0x22) {
        ok = true;
        break;
      }
      if (d === 0x5c) {
        const e = s.charCodeAt(j + 1);
        if (e === 0x75 && /^[0-9a-fA-F]{4}$/.test(s.slice(j + 2, j + 6))) {
          j += 6;
          continue;
        }
        if (JSON_ESCAPE[e] !== undefined) {
          j += 2;
          continue;
        }
        break;
      }
      if (d < 0x20 || isBreak(d)) break;
      j++;
    }
    if (ok) {
      partner[i] = j;
      partner[j] = i;
      i = j + 1;
      continue;
    }
    // Not a string: the rest of this line is not read as strings.
    while (i < n && !isBreak(s.charCodeAt(i))) i++;
  }
  return partner;
}

/**
 * Text with each claimed run printed as `marker`. A `"` that delimits a JSON string whose other quote is outside
 * the run is kept, so a redaction never ends or opens a quoted string (a secret ending in `"` ate a closing quote).
 */
export function emitText(s: string, claimed: Uint8Array, marker: string): string {
  const n = s.length;
  let partner: Int32Array | undefined;
  let out = '';
  /** The next `"` at or after the current run (n: none left); runs go left to right, so one scan in all. */
  let nq = -1;
  for (let i = 0; i < n; ) {
    let j = i;
    const c = claimed[i];
    while (j < n && claimed[j] === c) j++;
    if (c !== 1) {
      out += s.slice(i, j);
      i = j;
      continue;
    }
    if (nq < i) {
      nq = s.indexOf('"', i);
      if (nq < 0) nq = n;
    }
    if (nq >= j) {
      out += marker;
      i = j;
      continue;
    }
    partner ??= quotePartners(s);
    let piece = false;
    for (let p = i; p < j; p++) {
      const o = s.charCodeAt(p) === 0x22 ? (partner[p] as number) : -1;
      if (o >= 0 && (o < i || o >= j)) {
        if (piece) out += marker;
        out += '"';
        piece = false;
      } else {
        piece = true;
      }
    }
    if (piece) out += marker;
    i = j;
  }
  return out;
}
