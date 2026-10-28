// The consumer-side oracle for remembered secrets in output (PLAN.md "2026-10-26: secrets in text paths").
// Written from the acceptance criteria and the reviewer's scripts (~/x2b-r7brc-sec/lib.mjs, e2e-sites.mjs), never
// from the server's code: a result line is split on all 7 separators, its JSON strings are decoded, every piece
// is split on <redacted>, and each piece is read raw and percent-decoded (+ as a space too).

export const R = '<redacted>';
export const SEPS = /\r\n|[\r\n\u2028\u2029\u0085\v\f]/;
const LD = /^[\p{L}\p{N}]$/u;

/** A line's text outside JSON strings (each string replaced by `""`) and its decoded strings (lib.mjs splitQuoted). */
export function splitQuoted(line: string): { outside: string; strings: string[]; bad: boolean } {
  let outside = '';
  const strings: string[] = [];
  let bad = false;
  let i = 0;
  while (i < line.length) {
    if (line[i] !== '"') {
      outside += line[i];
      i++;
      continue;
    }
    let j = i + 1;
    let ok = false;
    while (j < line.length) {
      const d = line[j] as string;
      if (d === '\\') {
        const e = line[j + 1];
        if (e === 'u' && /^[0-9a-fA-F]{4}$/.test(line.slice(j + 2, j + 6))) {
          j += 6;
          continue;
        }
        if (e !== undefined && '"\\/bfnrt'.includes(e)) {
          j += 2;
          continue;
        }
        break;
      }
      if (d === '"') {
        ok = true;
        break;
      }
      if (d.charCodeAt(0) < 0x20) break;
      j++;
    }
    if (!ok) {
      bad = true;
      outside += line.slice(i);
      break;
    }
    strings.push(JSON.parse(line.slice(i, j + 1)) as string);
    outside += '""';
    i = j + 1;
  }
  return { outside, strings, bad };
}

interface Unit {
  c: string;
  esc: boolean;
}
const ESC = /^%[0-9a-fA-F]{2}/;
/** Code points of s. With pct, each run of `%XX` escapes decodes as UTF-8 and its characters are marked esc. */
function units(s: string, pct: boolean, plus: boolean): Unit[] {
  const out: Unit[] = [];
  for (let i = 0; i < s.length; ) {
    if (pct && ESC.test(s.slice(i, i + 3))) {
      const bytes: number[] = [];
      while (ESC.test(s.slice(i, i + 3))) {
        bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
        i += 3;
      }
      for (const c of Buffer.from(bytes).toString('utf8')) out.push({ c, esc: true });
      continue;
    }
    const c = String.fromCodePoint(s.codePointAt(i) as number);
    out.push({ c: plus && c === '+' ? ' ' : c, esc: false });
    i += c.length;
  }
  return out;
}

/**
 * Whether `secret` is a whole token in the units: no letter or digit directly before or after it. A character
 * that came from a `%XX` escape is an edge whatever it decodes to (AC1: a secret next to a percent-escape).
 */
function wholeIn(us: Unit[], secret: string): boolean {
  const cps = [...secret];
  next: for (let i = 0; i + cps.length <= us.length; i++) {
    for (let k = 0; k < cps.length; k++) if (us[i + k]?.c !== cps[k]) continue next;
    const b = us[i - 1];
    const a = us[i + cps.length];
    if ((!b || b.esc || !LD.test(b.c)) && (!a || a.esc || !LD.test(a.c))) return true;
  }
  return false;
}

/** The first line of `out` that shows `secret` as a whole token, raw or decoded, or null. */
export function leak(out: string, secret: string): string | null {
  for (const line of out.split(SEPS)) {
    const q = splitQuoted(line);
    for (const seg of [q.outside, ...q.strings]) {
      for (const piece of seg.split(R)) {
        for (const [pct, plus] of [
          [false, false],
          [true, false],
          [true, true],
        ] as const) {
          if (wholeIn(units(piece, pct, plus), secret)) return line;
        }
      }
    }
  }
  return null;
}

/** A `%` that does not head a complete `%XX` escape. */
export const STRAY_PCT = /%(?![0-9a-fA-F]{2})/;

/**
 * AC3, against the same output with no secret remembered (`reference`): a line whose JSON strings parse there still
 * parses, a stray `%` (a split escape) appears only where the reference has one, and the marker is never encoded.
 */
export function structureProblems(out: string, reference: string): string[] {
  const p: string[] = [];
  const lo = out.split(SEPS);
  const lr = reference.split(SEPS);
  if (lo.length !== lr.length) p.push(`line count ${lo.length} != ${lr.length}`);
  lr.forEach((ref, i) => {
    const o = lo[i] ?? '';
    if (!splitQuoted(ref).bad && splitQuoted(o).bad) p.push(`line ${i} no longer parses: ${JSON.stringify(o.slice(0, 200))}`);
    if (!STRAY_PCT.test(ref) && STRAY_PCT.test(o)) p.push(`line ${i} has a split escape: ${JSON.stringify(o.slice(0, 200))}`);
  });
  if (/%3Credacted%3E|\\u003credacted|&lt;redacted/i.test(out)) p.push('an encoded marker');
  return p;
}
