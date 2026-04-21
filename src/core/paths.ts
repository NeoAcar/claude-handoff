/**
 * Placeholder path rewriting for exported/imported session records.
 *
 * This module's single job is translating absolute paths into portable
 * `{{PROJECT_ROOT}}` / `{{HOME}}` placeholders and back. It knows nothing
 * about where Claude Code stores session files on disk — that's
 * `src/core/store.ts`.
 */

export const PROJECT_ROOT_PLACEHOLDER = '{{PROJECT_ROOT}}';
export const HOME_PLACEHOLDER = '{{HOME}}';
/**
 * Absolute path of the project's Claude store directory
 * (`~/.claude/projects/<key>/`). Session JSONL records sometimes carry
 * absolute paths that point inside this directory — memory file edits,
 * `system.memory_saved` records, subagent meta sidecars referencing
 * `worktreePath`. The store key is derived from the machine's
 * canonicalized project root (or git root, for auto-memory), so it
 * differs between Alice and Neo. Without this placeholder, rewriting
 * just `{{HOME}}` would leave Alice's key baked in — references
 * would land on a non-existent path after import.
 */
export const CLAUDE_STORE_PLACEHOLDER = '{{CLAUDE_STORE}}';

// --- Path rewriting ---

/**
 * Replace local absolute paths with portable placeholders (export direction).
 *
 * Replacement order matters — longest / most specific first:
 *   1. The Claude store directory, if given. Typically a subpath of HOME,
 *      so it must run before the HOME pass.
 *   2. The project root, which itself often sits inside HOME.
 *   3. HOME.
 *
 * Only replaces at path-component boundaries to avoid substring disasters
 * (e.g., a project named "auth" must not rewrite the word "auth" in code).
 */
export function localToPortable(
  text: string,
  localRoot: string,
  localHome: string,
  localStoreDir?: string,
): string {
  let result = text;
  if (localStoreDir) {
    result = replacePathPrefix(result, localStoreDir, CLAUDE_STORE_PLACEHOLDER);
  }
  result = replacePathPrefix(result, localRoot, PROJECT_ROOT_PLACEHOLDER);
  result = replacePathPrefix(result, localHome, HOME_PLACEHOLDER);
  return result;
}

/**
 * Replace portable placeholders with local absolute paths (import direction).
 *
 * Placeholders don't overlap, so ordering is cosmetic here — we still do
 * `{{PROJECT_ROOT}}` → HOME → `{{CLAUDE_STORE}}` so the reverse reads
 * symmetrically with the export pass.
 */
export function portableToLocal(
  text: string,
  localRoot: string,
  localHome: string,
  localStoreDir?: string,
): string {
  let result = text;
  result = replacePathPrefix(result, PROJECT_ROOT_PLACEHOLDER, localRoot);
  result = replacePathPrefix(result, HOME_PLACEHOLDER, localHome);
  if (localStoreDir) {
    result = replacePathPrefix(result, CLAUDE_STORE_PLACEHOLDER, localStoreDir);
  }
  return result;
}

/**
 * Replace all occurrences of `from` with `to`, but only when `from` appears
 * at a path-component boundary.
 *
 * A match is at a boundary when it is followed by: end of string, a path
 * separator, whitespace, a quote, or another non-path char. This prevents
 * "auth" in /home/user/auth-service from matching the substring "auth" in
 * "authentication" elsewhere in the text.
 */
function replacePathPrefix(text: string, from: string, to: string): string {
  if (!from || from.length === 0) return text;
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
