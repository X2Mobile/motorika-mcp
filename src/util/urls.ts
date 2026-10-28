// URL policy (PLAN amendment "decisions from the three review lenses", items 1 and 2).
// - file: and view-source:file: only inside the allowed roots, with no dot-segment below the root.
// - chrome:, chrome-untrusted:, chrome-extension:, chrome-search:, devtools:, chrome-error: and every
//   about: except about:blank and about:srcdoc only with --allow-chrome-urls.
// - http(s) and ws(s) obey --blocked-origins / --allowed-origins.
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface UrlPolicy {
  fileRoots: string[];
  allowHiddenFiles: boolean;
  allowChromeUrls: boolean;
  blockedOrigins: string[];
  allowedOrigins: string[];
  /**
   * Directories inside a root that file: navigation still refuses (re-check item 4: <output-dir>/downloads,
   * which any page can write to). Upload sources do not use this list.
   */
  fileNavExcluded?: string[];
}

export type Verdict = { ok: true } | { ok: false; reason: string; hint: string };

const OK: Verdict = { ok: true };
const INTERNAL_SCHEMES = new Set(['chrome:', 'chrome-untrusted:', 'chrome-extension:', 'chrome-search:', 'devtools:', 'chrome-error:']);
const ABOUT_OK = new Set(['about:blank', 'about:srcdoc']);

function inside(child: string, root: string): boolean {
  const rel = relative(root, child);
  return rel === '' || (!isAbsolute(rel) && rel.split(sep)[0] !== '..');
}

function hidden(rel: string): boolean {
  return rel.split(/[\\/]+/).some((seg) => seg.startsWith('.') && seg !== '.' && seg !== '..');
}

/**
 * The canonical path: symlinks resolved and, on a case-insensitive disk (APFS default), the on-disk case
 * (round 3, C9: realpathSync keeps the case as given, realpathSync.native does not). A path that does not
 * exist yet is its deepest existing ancestor's canonical path plus the rest.
 */
function real(p: string): string {
  const abs = resolve(p);
  let head = abs;
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync.native(head), ...rest.reverse());
    } catch {
      const up = dirname(head);
      if (up === head) return abs;
      rest.push(basename(head));
      head = up;
    }
  }
}

/** A local path may be opened where an upload source could come from: inside a root, not hidden. */
export function checkLocalPath(path: string, policy: UrlPolicy): Verdict {
  const given = resolve(path);
  const target = real(given);
  // The realpath decides containment (a symlink out of a root is refused); dot-segments are checked
  // relative to the containing root both on the realpath and on the path as given.
  const realRels: string[] = [];
  const lexRels: string[] = [];
  for (const r of policy.fileRoots) {
    const rr = real(r);
    if (inside(target, rr)) realRels.push(relative(rr, target));
    const lr = resolve(r);
    if (inside(given, lr)) lexRels.push(relative(lr, given));
  }
  if (realRels.length === 0) {
    return {
      ok: false,
      reason: 'outside the allowed file roots',
      hint: 'open files inside the cwd, the output dir, ~/Downloads, ~/Desktop or ~/Documents, or start the server with --allow-file-root <dir>',
    };
  }
  if (!policy.allowHiddenFiles && [...realRels, ...lexRels].some(hidden)) {
    return { ok: false, reason: 'a hidden file or directory', hint: 'start the server with --allow-hidden-files to permit dot-files' };
  }
  return OK;
}

export function checkFileUrl(url: string, policy: UrlPolicy): Verdict {
  let path: string;
  try {
    path = fileURLToPath(url);
  } catch {
    return { ok: false, reason: 'not a local file URL', hint: 'use file:///absolute/path' };
  }
  const v = checkLocalPath(path, policy);
  if (!v.ok) return v;
  const target = real(resolve(path));
  // C9: canonical paths, and case-folded too: a case variant of the downloads folder is that folder on
  // a case-insensitive disk, even where it does not exist yet (fail closed).
  const fold = (x: string) => x.toLowerCase();
  for (const ex of policy.fileNavExcluded ?? []) {
    const exReal = real(ex);
    if (inside(target, exReal) || inside(fold(target), fold(exReal)) || inside(fold(resolve(path)), fold(resolve(ex)))) {
      return {
        ok: false,
        reason: 'inside the downloads folder, which web pages can write to',
        hint: 'downloaded pages are not opened as file: URLs; move the file to another allowed folder first if you trust it',
      };
    }
  }
  return OK;
}

/**
 * An IPv4-mapped IPv6 address (`::ffff:7f00:1`, `::ffff:127.0.0.1`, without brackets) as the IPv4 address it
 * reaches (`127.0.0.1`); anything else unchanged (round 4, G4). `::1` and `::127.0.0.1` (IPv4-compatible) are
 * other addresses, not mapped ones, so they stay as they are.
 */
export function unmapIPv4(h: string): string {
  let canon: string;
  try {
    // The URL parser writes every IPv6 spelling in one compressed form (`::ffff:7f00:1`).
    canon = new URL(`http://[${h}]/`).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return h;
  }
  const m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canon);
  if (!m) return canon;
  const x = parseInt(m[1] ?? '0', 16);
  const y = parseInt(m[2] ?? '0', 16);
  return `${x >> 8}.${x & 255}.${y >> 8}.${y & 255}`;
}

/**
 * A host in one canonical spelling: lower case, no brackets, its single trailing dot removed (`localhost.`
 * is `localhost`; re-check item 3, NEW-3), an IPv4-mapped IPv6 address as its IPv4 address, and an IPv4
 * address in any form the URL parser accepts (`127.1`, `2130706433`, `0x7f000001`, `0177.0.0.1`) as a dotted
 * quad (round 4, G4).
 */
export function bareHost(h: string): string {
  let l = h.toLowerCase().replace(/^\[|\]$/g, '');
  if (l.endsWith('.')) l = l.slice(0, -1);
  if (l.includes(':')) return unmapIPv4(l);
  if (/^[0-9a-fx.]+$/.test(l)) {
    try {
      const parsed = new URL(`http://${l}/`).hostname;
      if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(parsed)) return parsed;
    } catch {
      /* not an address: keep it */
    }
  }
  return l;
}

function hostMatches(rawEntry: string, u: URL): boolean {
  const host = bareHost(u.hostname);
  const entry = rawEntry.includes('://') ? rawEntry : bareHost(rawEntry);
  if (entry.includes('://')) {
    let e: URL;
    try {
      e = new URL(entry);
    } catch {
      return false;
    }
    const norm = (p: string) => (p === 'ws:' ? 'http:' : p === 'wss:' ? 'https:' : p);
    const port = (x: URL) => x.port || (norm(x.protocol) === 'https:' ? '443' : '80');
    return norm(e.protocol) === norm(u.protocol) && bareHost(e.hostname) === host && port(e) === port(u);
  }
  if (entry.startsWith('*.')) return host.endsWith(entry.slice(1));
  return host === entry || host.endsWith(`.${entry}`);
}

/** Origin lists apply to http(s) and ws(s) only. */
export function checkOrigin(url: string, policy: UrlPolicy): Verdict {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return OK;
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol)) return OK;
  if (policy.blockedOrigins.some((e) => hostMatches(e, u))) {
    return { ok: false, reason: `blocked by --blocked-origins: ${u.hostname}`, hint: 'this site is on the blocked list; pick another site, or remove it from --blocked-origins (MOTORIKA_BLOCKED_ORIGINS)' };
  }
  if (policy.allowedOrigins.length > 0 && !policy.allowedOrigins.some((e) => hostMatches(e, u))) {
    return { ok: false, reason: `blocked by --allowed-origins: ${u.hostname}`, hint: 'only the --allowed-origins sites load; add it there (MOTORIKA_ALLOWED_ORIGINS) to allow it' };
  }
  return OK;
}

/** The IPv4-mapped IPv6 spellings of a dotted-quad host (`::ffff:7f00:1`, `::ffff:127.0.0.1`); none for others. */
export function mappedSpellings(host: string): string[] {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return [];
  const [a, b, c, d] = m.slice(1).map(Number) as [number, number, number, number];
  const hex = (x: number, y: number) => ((x << 8) | y).toString(16);
  return [`::ffff:${hex(a, b)}:${hex(c, d)}`, `::ffff:${host}`];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** The host part of an origin-list entry (a full origin's hostname, a `*.` pattern's base, or the host). */
function entryHost(entry: string): { host: string; subOnly: boolean } {
  if (entry.includes('://')) {
    try {
      return { host: bareHost(new URL(entry).hostname), subOnly: false };
    } catch {
      return { host: bareHost(entry), subOnly: false };
    }
  }
  if (entry.startsWith('*.')) return { host: bareHost(entry.slice(2)), subOnly: true };
  return { host: bareHost(entry), subOnly: false };
}

/**
 * The URLs the origin route must see (re-check item 3, PN1): a superset of what the lists can refuse, so
 * every other request is never routed through the server. The route handler still decides with
 * checkOrigin. With an allow-list every http(s)/ws(s) URL can be refused, so all of them are routed.
 */
export function originRouteMatch(policy: Pick<UrlPolicy, 'blockedOrigins' | 'allowedOrigins'>): RegExp | undefined {
  if (policy.allowedOrigins.length > 0) return /^(?:https?|wss?):\/\//i;
  if (policy.blockedOrigins.length === 0) return undefined;
  const alts = policy.blockedOrigins.flatMap((e) => {
    const { host, subOnly } = entryHost(e);
    const h = host.includes(':') ? `\\[${escapeRe(host)}\\]` : escapeRe(host);
    // G4: an IPv4 entry also matches its IPv4-mapped IPv6 spellings.
    const mapped = mappedSpellings(host).map((m) => `\\[${escapeRe(m)}\\]`);
    return [`${subOnly ? '[^/?#@:\\[\\]]+\\.' : '(?:[^/?#@:\\[\\]]+\\.)?'}${h}`, ...mapped];
  });
  return new RegExp(`^(?:https?|wss?)://(?:[^/?#@]*@)?(?:${alts.join('|')})\\.?(?::\\d+)?(?:[/?#]|$)`, 'i');
}

/**
 * Chrome DevTools URL patterns for the blocked list: what the browser-level Fetch interception pauses
 * (round 3, C5/C8). A superset: the handler decides with checkOrigin. With and without a trailing dot,
 * subdomains, and a userinfo part.
 */
export function blockedUrlPatterns(policy: Pick<UrlPolicy, 'blockedOrigins'>): string[] {
  const out = new Set<string>();
  for (const e of policy.blockedOrigins) {
    const { host, subOnly } = entryHost(e);
    const h = host.includes(':') ? `[${host}]` : host;
    for (const d of ['', '.']) {
      for (const pre of subOnly ? ['*.', '*@*.'] : ['', '*.', '*@', '*@*.']) {
        out.add(`*://${pre}${h}${d}/*`);
        out.add(`*://${pre}${h}${d}:*`);
      }
    }
    // G4: Chrome writes http://[::ffff:127.0.0.1]/ as http://[::ffff:7f00:1]/; both reach the IPv4 entry.
    for (const m of mappedSpellings(host)) {
      for (const pre of ['', '*@']) {
        out.add(`*://${pre}[${m}]/*`);
        out.add(`*://${pre}[${m}]:*`);
      }
    }
  }
  return [...out];
}

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * Chrome `--host-resolver-rules` for the origin lists (round 4, G1): a resolver layer under the request
 * interception, for requests Chrome's DevTools interception never sees (speculation-rules prefetch and
 * prerender, WebSockets from dedicated, shared and service workers, WebRTC TURN over TCP). Chrome applies
 * the rules to IP-address hosts too (measured), so an IPv4 entry is listed with its mapped IPv6 spellings.
 * - `--blocked-origins`: each listed host and its subdomains resolve to nothing. A full-origin entry
 *   (`https://mail.google.com`) blocks the whole host here, every scheme and port (stricter than the list).
 * - `--allowed-origins`: every host resolves to nothing except the listed ones (and their subdomains).
 *   Chrome checks exclusions before mappings, so a blocked host under an allowed one is left to the
 *   interception.
 * undefined when no list is set (no switch at all).
 */
export function hostResolverRules(policy: Pick<UrlPolicy, 'blockedOrigins' | 'allowedOrigins'>): string | undefined {
  /** Rule patterns for one entry: the host, its subdomains, an IPv4 address's mapped IPv6 spellings. */
  const patterns = (entry: string): string[] => {
    const { host, subOnly } = entryHost(entry);
    if (host === '' || host.includes(':') || !/^[a-z0-9.-]+$/.test(host)) return [];
    if (IPV4.test(host)) return [host, ...mappedSpellings(host).flatMap((m) => [m, `[${m}]`])];
    return subOnly ? [`*.${host}`] : [host, `*.${host}`];
  };
  const rules: string[] = [];
  for (const e of policy.blockedOrigins) for (const p of patterns(e)) rules.push(`MAP ${p} ~NOTFOUND`);
  if (policy.allowedOrigins.length > 0) {
    rules.push('MAP * ~NOTFOUND');
    for (const e of policy.allowedOrigins) for (const p of patterns(e)) rules.push(`EXCLUDE ${p}`);
  }
  return rules.length > 0 ? [...new Set(rules)].join(', ') : undefined;
}

/** Full check for a URL the agent asks to open (navigate, tabs new). */
export function checkNavigation(url: string, policy: UrlPolicy): Verdict {
  const lower = url.trim().toLowerCase();
  if (lower.startsWith('view-source:')) return checkNavigation(url.trim().slice('view-source:'.length), policy);
  const scheme = /^([a-z][a-z0-9+.-]*:)/.exec(lower)?.[1] ?? '';
  if (scheme === 'file:') return checkFileUrl(url.trim(), policy);
  if (scheme === 'about:') {
    const bare = lower.replace(/[?#].*$/, '');
    if (ABOUT_OK.has(bare) || policy.allowChromeUrls) return OK;
    return { ok: false, reason: `${bare} is an internal browser page`, hint: 'start the server with --allow-chrome-urls to open internal pages' };
  }
  if (INTERNAL_SCHEMES.has(scheme)) {
    if (policy.allowChromeUrls) return OK;
    return { ok: false, reason: `${scheme} URLs are internal browser pages`, hint: 'start the server with --allow-chrome-urls to open internal pages' };
  }
  return checkOrigin(url, policy);
}

/**
 * Should a frame that just navigated to this URL be sent back to about:blank? The file: guard, and the
 * origin lists for http(s) (a redirect hop is never routed, so the commit is checked; re-check item 3).
 */
export function guardLanding(url: string, policy: UrlPolicy): Verdict {
  const lower = url.toLowerCase();
  const inner = lower.startsWith('view-source:') ? url.slice('view-source:'.length) : url;
  const il = inner.toLowerCase();
  if (il.startsWith('http:') || il.startsWith('https:')) return checkOrigin(inner, policy);
  if (!il.startsWith('file:')) return OK;
  return checkFileUrl(inner, policy);
}
