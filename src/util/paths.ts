// File-root confinement for upload sources and filename sanitising for written files.
import { existsSync, realpathSync, statSync } from 'node:fs';
import { expandHome } from '../config.js';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export class PathDenied extends Error {
  constructor(
    readonly reason: string,
    readonly hint: string,
  ) {
    super(`${reason}; ${hint}`);
  }
}

function realOrResolved(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function isInside(child: string, root: string): boolean {
  const rel = relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && rel.split(sep)[0] !== '..');
}

function hasHiddenSegment(p: string): boolean {
  return p.split(/[\\/]+/).some((seg) => seg.startsWith('.') && seg !== '.' && seg !== '..');
}

/**
 * Resolve an upload source path. It must exist, be a regular file, and resolve (realpath, symlinks
 * followed) inside one of the roots. Hidden segments (a dot-file or dot-dir) are denied unless
 * allowHidden. They are checked relative to the root that contains the path, because a root may itself
 * live under a dot-dir (the default output dir is ~/.motorika/output); this check is applied to both the
 * path as given (dot-segments normalised) and the realpath.
 */
export function confineUploadPath(input: string, roots: string[], allowHidden: boolean, cwd: string = process.cwd()): string {
  if (input.trim() === '') throw new PathDenied('empty path', 'pass an absolute file path');
  const given = resolve(cwd, expandHome(input));
  const hidden = (): PathDenied =>
    new PathDenied(`"${input}" is a hidden file or inside a hidden directory`, 'refused; start the server with --allow-hidden-files to permit dot-files');
  const lexicalRoots = roots.map((r) => resolve(r));
  const lexicalRoot = lexicalRoots.filter((r) => isInside(given, r)).sort((a, b) => b.length - a.length)[0];
  if (!allowHidden && hasHiddenSegment(lexicalRoot === undefined ? given : relative(lexicalRoot, given))) {
    throw hidden();
  }
  if (!existsSync(given)) throw new PathDenied(`"${input}" does not exist`, 'pass an existing file path');
  const real = realpathSync(given);
  const realRoots = roots.map(realOrResolved);
  const realRoot = realRoots.filter((r) => isInside(real, r)).sort((a, b) => b.length - a.length)[0];
  if (realRoot === undefined) {
    throw new PathDenied(
      `"${input}" is outside the allowed upload roots (${realRoots.join(', ')})`,
      'refused; start the server with --allow-file-root <dir> to add a root',
    );
  }
  if (!allowHidden && hasHiddenSegment(relative(realRoot, real))) throw hidden();
  if (!statSync(real).isFile()) throw new PathDenied(`"${input}" is not a regular file`, 'pass a file, not a directory');
  return real;
}

/** Sanitise a filename: no separators, no "..", no leading dot, no control chars or line separators, at most 120 chars. */
export function sanitizeFilename(name: string, fallback = 'file'): string {
  let s = basename(name.replace(/\\/g, '/'));
  // P10: NEL, U+2028 and U+2029 are line separators too; a page-chosen name never carries one.
  s = s.replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029/\\:*?"<>|]/g, '_');
  s = s.replace(/\.\.+/g, '.');
  s = s.replace(/^[.\s]+/, '').replace(/\s+$/, '');
  if (s === '' || s === '.') s = fallback;
  if (s.length > 120) {
    const ext = extname(s).slice(0, 20);
    s = s.slice(0, 120 - ext.length) + ext;
  }
  return s;
}

/** Join a sanitised name inside dir, adding a numeric suffix on collision. Result stays inside dir. */
export function uniquePathIn(dir: string, name: string, taken: (p: string) => boolean = existsSync): string {
  const safe = sanitizeFilename(name);
  const ext = extname(safe);
  const stem = ext ? safe.slice(0, -ext.length) : safe;
  let candidate = join(dir, safe);
  for (let i = 1; taken(candidate); i++) {
    const suffix = `-${i}`;
    candidate = join(dir, `${stem.slice(0, 120 - ext.length - suffix.length)}${suffix}${ext}`);
  }
  if (!isInside(resolve(candidate), resolve(dir))) throw new PathDenied(`refusing to write outside ${dir}`, 'use a plain file name');
  return candidate;
}
