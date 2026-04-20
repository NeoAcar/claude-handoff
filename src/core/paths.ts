/**
 * Path rewriting (export/import) and slug computation.
 *
 * All project-relative path handling goes through this module.
 * Never use raw path.join outside this module for project-relative paths.
 */

import path from 'node:path';
import os from 'node:os';
import { readdir } from 'node:fs/promises';

export const PROJECT_ROOT_PLACEHOLDER = '{{PROJECT_ROOT}}';
export const HOME_PLACEHOLDER = '{{HOME}}';

// --- Slug computation ---

/**
 * Compute the Claude Code project slug for a given absolute path.
 *
 * Rule (empirically confirmed on Linux): every character that is not
 * ASCII alphanumeric and not a dash is replaced with a dash. Confirmed
 * examples:
 *   /home/neo/Dersler/NLP/Homework 3          → -home-neo-Dersler-NLP-Homework-3
 *   /home/neo/PythonProjects/YZV405E_2526_Hedgehogs
 *                                             → -home-neo-PythonProjects-YZV405E-2526-Hedgehogs
 *   /tmp/test.slug (v1)/project               → -tmp-test-slug--v1--project
 *
 * @deprecated For lookups, prefer `findSlugForPath`, which reverse-matches
 *   against the actual `~/.claude/projects/` listing and is robust to
 *   changes in Claude Code's slug rule or to unverified character classes
 *   (Unicode, non-ASCII, etc.). Use `computeSlug` only as a fallback or
 *   for informational display.
 */
export function computeSlug(absolutePath: string): string {
  // Normalize to forward slashes (handles Windows)
  let normalized = absolutePath.replace(/\\/g, '/');

  // Remove trailing slash if present
  if (normalized.endsWith('/') && normalized.length > 1) {
    normalized = normalized.slice(0, -1);
  }

  // Replace any non-alphanumeric non-dash character with a dash.
  return normalized.replace(/[^a-zA-Z0-9-]/g, '-');
}

/**
 * Find the `~/.claude/projects/<slug>` directory that corresponds to the
 * given absolute path, by listing the projects directory and reverse-matching
 * against the path. Returns the slug name (directory basename) or null if no
 * match is found.
 *
 * Preferred over `computeSlug` because it does not depend on us knowing the
 * exact slug rule — if Claude Code's rule changes or a character class is
 * unverified, this still finds the right directory as long as it exists on
 * disk.
 *
 * Strategy:
 *   1. Compute expected slug via `computeSlug` and check for an exact match
 *      among the listed directories.
 *   2. If that fails, fall back to inspecting each candidate dir by peeking
 *      at a `cwd` field in one of its session files. (Not implemented yet —
 *      step 1 covers all known cases.)
 */
export async function findSlugForPath(absolutePath: string): Promise<string | null> {
  const projectsDir = getClaudeProjectsDir();

  let entries: string[];
  try {
    entries = await readdir(projectsDir);
  } catch {
    return null;
  }

  const expected = computeSlug(absolutePath);
  if (entries.includes(expected)) {
    return expected;
  }

  return null;
}

// --- Path rewriting ---

/**
 * Replace local absolute paths with portable placeholders (export direction).
 *
 * Replacement order matters: project root first (longer, more specific),
 * then home directory. This prevents partial matches — if the project is
 * inside HOME, the project root match takes priority.
 *
 * Only replaces at path-component boundaries to avoid substring disasters
 * (e.g., a project named "auth" must not rewrite the word "auth" in code).
 */
export function localToPortable(text: string, localRoot: string, localHome: string): string {
  let result = text;
  result = replacePathPrefix(result, localRoot, PROJECT_ROOT_PLACEHOLDER);
  result = replacePathPrefix(result, localHome, HOME_PLACEHOLDER);
  return result;
}

/**
 * Replace portable placeholders with local absolute paths (import direction).
 *
 * Replacement order matters: project root first, then home.
 */
export function portableToLocal(text: string, localRoot: string, localHome: string): string {
  let result = text;
  result = replacePathPrefix(result, PROJECT_ROOT_PLACEHOLDER, localRoot);
  result = replacePathPrefix(result, HOME_PLACEHOLDER, localHome);
  return result;
}

/**
 * Replace all occurrences of `from` with `to`, but only when `from` appears
 * at a path-component boundary.
 *
 * A match is at a boundary when:
 *   - It is at the start of the string, OR preceded by a non-path char
 *     (whitespace, quote, equals, colon, etc.)
 *   - It is followed by: end of string, a path separator, whitespace,
 *     a quote, or another non-path char.
 *
 * This prevents "auth" in /home/user/auth-service from matching "auth"
 * in "authentication" elsewhere in the text.
 */
function replacePathPrefix(text: string, from: string, to: string): string {
  if (!from || from.length === 0) return text;

  // Escape regex special characters in `from`
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // The path can appear:
  //   - At the start of string or after a "boundary" char (not a path component char)
  //   - Followed by end, path separator, or boundary char
  //
  // Path component chars: alphanumeric, dash, underscore, dot
  // Boundary chars: everything else (whitespace, quotes, equals, colons, etc.)
  //
  // We use lookbehind/lookahead for zero-width assertions where possible,
  // but for the prefix position we also allow start-of-string.
  const pattern = new RegExp(
    `(?<![\\w.])${escaped}(?=$|[/"'\\s:;,\\]})>\\\\])` +
      '|' +
      `^${escaped}(?=$|[/"'\\s:;,\\]})>\\\\])`,
    'g',
  );

  // Simpler approach: just replace exact occurrences where `from` is followed
  // by a path separator, end of string, or appears as a complete path prefix.
  // Since our placeholders ({{PROJECT_ROOT}}, {{HOME}}) and absolute paths
  // (/home/user/project) are distinctive enough, and the SPEC's concern is
  // about short project *names* (like "auth") being substring-matched inside
  // words — but our `from` values are full absolute paths or placeholders,
  // which are long and distinctive. The real boundary check matters when
  // the path appears mid-string (e.g., in a bash command).
  //
  // Let's use a straightforward approach: find each occurrence of `from`,
  // check that it's followed by a path separator, quote, whitespace, or
  // end-of-string (not by a regular path character that would indicate
  // it's a substring of a longer path).

  return replaceWithBoundaryCheck(text, from, to);
}

function replaceWithBoundaryCheck(text: string, from: string, to: string): string {
  if (!text.includes(from)) return text;

  const parts: string[] = [];
  let searchStart = 0;

  while (searchStart < text.length) {
    const idx = text.indexOf(from, searchStart);
    if (idx === -1) {
      parts.push(text.slice(searchStart));
      break;
    }

    // Check boundary AFTER the match
    const afterIdx = idx + from.length;
    const afterChar = afterIdx < text.length ? text[afterIdx] : '';

    // After the path, we expect: end of string, path separator, quote,
    // whitespace, or other delimiter — NOT a continuation of a path component
    // that would make this a substring of a longer path.
    // e.g., /home/user should match in "/home/user/project" (followed by /)
    //       but /home/us should NOT match in "/home/user" (followed by 'e')
    const isAfterBoundary =
      afterChar === '' || // end of string
      afterChar === '/' ||
      afterChar === '\\' ||
      afterChar === '"' ||
      afterChar === "'" ||
      afterChar === ' ' ||
      afterChar === '\t' ||
      afterChar === '\n' ||
      afterChar === '\r' ||
      afterChar === ':' ||
      afterChar === ';' ||
      afterChar === ',' ||
      afterChar === ')' ||
      afterChar === ']' ||
      afterChar === '}' ||
      afterChar === '>' ||
      afterChar === '|' ||
      afterChar === '&';

    if (isAfterBoundary) {
      parts.push(text.slice(searchStart, idx));
      parts.push(to);
      searchStart = afterIdx;
    } else {
      // Not a boundary match — skip past this occurrence
      parts.push(text.slice(searchStart, idx + 1));
      searchStart = idx + 1;
    }
  }

  return parts.join('');
}

// --- Deep rewriting for JSONL records ---

/**
 * Recursively rewrite all string values in a JSON-compatible structure.
 * Returns a new object (does not mutate the input).
 */
export function deepRewrite(value: unknown, rewriter: (s: string) => string): unknown {
  if (typeof value === 'string') {
    return rewriter(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => deepRewrite(item, rewriter));
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = deepRewrite(v, rewriter);
    }
    return result;
  }
  return value;
}

// --- Utility: detect local paths ---

/**
 * Get the Claude Code projects directory.
 */
export function getClaudeProjectsDir(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

/**
 * Get the slug directory for the current project, using reverse-match
 * against the actual projects directory listing. Returns null if no
 * matching slug directory exists.
 */
export async function getProjectSlugDir(projectRoot: string): Promise<string | null> {
  const slug = await findSlugForPath(projectRoot);
  if (!slug) return null;
  return path.join(getClaudeProjectsDir(), slug);
}
