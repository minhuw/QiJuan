import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { normalizeRelativePath } from './catalog.js';

export interface LibraryFile {
  relativePath: string;
  absolutePath: string;
}

export type LocateFailure = 'invalid_path' | 'not_found' | 'too_many';

export type LocatedFiles = { ok: true; files: LibraryFile[] } | { ok: false; reason: LocateFailure };

const MAX_LISTED_FILES = 1000;

/**
 * Lists regular files under a directory that stays inside an indexed library root.
 * Symlinks that resolve outside the root are skipped. A requested path that itself
 * escapes the root is rejected.
 */
export function listLibraryFiles(libraryRoot: string, requested: string): LocatedFiles {
  if (typeof requested !== 'string' || requested.includes('\0')) return { ok: false, reason: 'invalid_path' };
  let rootReal: string;
  try {
    if (!statSync(libraryRoot).isDirectory()) return { ok: false, reason: 'not_found' };
    rootReal = realpathSync(libraryRoot);
  } catch {
    return { ok: false, reason: 'not_found' };
  }

  const located = locateDirectory(libraryRoot, rootReal, requested);
  if (!located.ok) return located;

  const files: LibraryFile[] = [];
  const seen = new Set<string>();
  const failure = walk(libraryRoot, rootReal, located.lexical, seen, files);
  if (failure) return { ok: false, reason: failure };
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return { ok: true, files };
}

/** Absolute path of one indexed import item, or null when it escapes or is missing. */
export function resolveInsideRoot(libraryRoot: string, relativePath: string): string | null {
  const relative = normalizeRelativePath(relativePath);
  if (!relative) return null;
  const rootAbs = path.resolve(libraryRoot);
  const lexical = path.resolve(rootAbs, ...relative.split('/'));
  const rel = path.relative(rootAbs, lexical);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  if (!insideReal(libraryRoot, lexical)) return null;
  return lexical;
}

function locateDirectory(
  libraryRoot: string,
  rootReal: string,
  requested: string,
): { ok: true; lexical: string } | { ok: false; reason: LocateFailure } {
  const trimmed = requested.trim();
  let lexical: string;
  if (trimmed === '' || trimmed === '.') {
    lexical = path.resolve(libraryRoot);
  } else if (isAbsoluteRequest(trimmed)) {
    lexical = path.resolve(trimmed);
  } else {
    const relative = normalizeRelativePath(trimmed);
    if (!relative) return { ok: false, reason: 'invalid_path' };
    lexical = path.resolve(libraryRoot, ...relative.split('/'));
    const relLexical = path.relative(path.resolve(libraryRoot), lexical);
    if (relLexical.startsWith('..') || path.isAbsolute(relLexical)) return { ok: false, reason: 'invalid_path' };
  }

  try {
    const linked = lstatSync(lexical);
    if (!linked.isDirectory() && !linked.isSymbolicLink()) return { ok: false, reason: 'invalid_path' };
    if (!statSync(realpathSync(lexical)).isDirectory()) return { ok: false, reason: 'invalid_path' };
  } catch {
    return { ok: false, reason: 'not_found' };
  }
  if (!insideReal(rootReal, lexical)) return { ok: false, reason: 'invalid_path' };
  return { ok: true, lexical };
}

function walk(
  libraryRoot: string,
  rootReal: string,
  dirLexical: string,
  seen: Set<string>,
  files: LibraryFile[],
): LocateFailure | null {
  let dirReal: string;
  try {
    dirReal = realpathSync(dirLexical);
  } catch {
    return null;
  }
  if (!insideReal(rootReal, dirReal)) return 'invalid_path';
  if (seen.has(dirReal)) return null;
  seen.add(dirReal);

  let entries;
  try {
    entries = readdirSync(dirLexical, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name.includes('\0') || entry.name.includes('/') || entry.name.includes('\\')) {
      continue;
    }
    const child = path.join(dirLexical, entry.name);
    const rel = path.relative(path.resolve(libraryRoot), child);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return 'invalid_path';
    const relativePath = rel.split(path.sep).join('/');
    if (!normalizeRelativePath(relativePath)) return 'invalid_path';

    if (entry.isSymbolicLink()) {
      let linkReal: string;
      try {
        linkReal = realpathSync(child);
      } catch {
        continue;
      }
      if (!insideReal(rootReal, linkReal)) continue;
      let linked;
      try {
        linked = statSync(linkReal);
      } catch {
        continue;
      }
      if (linked.isDirectory()) {
        const failure = walk(libraryRoot, rootReal, child, seen, files);
        if (failure) return failure;
      } else if (linked.isFile()) {
        files.push({ relativePath, absolutePath: child });
      }
    } else if (entry.isDirectory()) {
      const failure = walk(libraryRoot, rootReal, child, seen, files);
      if (failure) return failure;
    } else if (entry.isFile()) {
      files.push({ relativePath, absolutePath: child });
    }
    if (files.length > MAX_LISTED_FILES) return 'too_many';
  }
  return null;
}

function insideReal(root: string, candidate: string): boolean {
  let rootReal = root;
  let fileReal = candidate;
  try {
    if (!path.isAbsolute(root) || statSync(root).isDirectory()) rootReal = realpathSync(root);
    fileReal = realpathSync(candidate);
  } catch {
    return false;
  }
  if (rootReal === fileReal) return true;
  const rel = path.relative(rootReal, fileReal);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function isAbsoluteRequest(value: string): boolean {
  return path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || value.startsWith('/');
}
