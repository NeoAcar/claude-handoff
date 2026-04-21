/**
 * Claude Code session store discovery.
 *
 * Centralizes "where does Claude Code keep the files on this machine?".
 * Deliberately separate from `paths.ts`, which handles the unrelated
 * question of "how do we rewrite absolute paths so a session can travel
 * between machines?".
 *
 * The canonical matcher here follows the reference-implementation pattern:
 * compute a key from a canonicalized project root (realpath + Unicode
 * NFC), then fall back to inspecting `cwd` fields inside candidate
 * session files when the key lookup misses. That fallback is what makes
 * us robust to slug-rule drift, non-ASCII normalization mismatches
 * (macOS tends to produce NFD filenames, Linux doesn't), and symlinks.
 */

import path from 'node:path';
import os from 'node:os';
import { createReadStream } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';

/**
 * Root of Claude Code's per-project session storage.
 */
export function getClaudeProjectsDir(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

/**
 * Canonicalize a project root so it can be compared against a `cwd` value
 * Claude Code wrote into a session file. Two machines that resolve
 * symlinks differently, or that use different Unicode normalization
 * (HFS+/APFS often decompose to NFD, Linux ext4 doesn't touch), would
 * otherwise disagree about what is conceptually the same project.
 *
 * If the path doesn't exist yet (e.g. import is about to create a
 * target slug directory for the first time), fall back to the input
 * normalized to NFC — same shape, just without the realpath step.
 */
export async function canonicalizeProjectRoot(projectRoot: string): Promise<string> {
  const normalized = projectRoot.normalize('NFC');
  try {
    const resolved = await realpath(normalized);
    return resolved.normalize('NFC');
  } catch {
    return normalized;
  }
}

/**
 * The directory name Claude Code would use for a given canonical path:
 * every character that is not ASCII alphanumeric and not a dash becomes
 * a dash.
 *
 * Don't use this for lookups — use {@link findProjectStoreDir}. This
 * function is the forward-compute primitive only, useful for creating a
 * target directory on first import or for informational display.
 */
export function sanitizeProjectKey(canonicalPath: string): string {
  let normalized = canonicalPath.replace(/\\/g, '/');
  if (normalized.endsWith('/') && normalized.length > 1) {
    normalized = normalized.slice(0, -1);
  }
  return normalized.replace(/[^a-zA-Z0-9-]/g, '-');
}

/**
 * Find the actual `~/.claude/projects/<key>/` directory for a project.
 *
 * Strategy in order:
 *   1. Fast path: canonicalize, compute the key, check if a dir with
 *      that name exists under the projects root.
 *   2. Fallback: enumerate all candidate dirs, read the `cwd` field
 *      from one session file per candidate, and compare canonicalized
 *      paths. This handles slug-rule drift, long-path hashing that
 *      Claude Code may apply, and any NFC/realpath mismatches we
 *      couldn't resolve in step 1.
 *
 * Returns an absolute path to the matching directory, or `null` if no
 * match is found.
 */
export async function findProjectStoreDir(projectRoot: string): Promise<string | null> {
  const projectsDir = getClaudeProjectsDir();

  let entries: string[];
  try {
    entries = await readdir(projectsDir);
  } catch {
    return null;
  }

  const canonical = await canonicalizeProjectRoot(projectRoot);

  // Fast path: key match
  const expectedKey = sanitizeProjectKey(canonical);
  if (entries.includes(expectedKey)) {
    return path.join(projectsDir, expectedKey);
  }

  // Fallback: inspect stored cwd in each candidate
  for (const entry of entries) {
    const candidateDir = path.join(projectsDir, entry);
    const storedCwd = await peekStoredCwd(candidateDir);
    if (storedCwd === null) continue;
    const candidateCanonical = storedCwd.normalize('NFC');
    if (candidateCanonical === canonical) {
      return candidateDir;
    }
  }

  return null;
}

/**
 * Return the absolute path to a project's store directory, creating the
 * path reference even when the directory does not yet exist on disk.
 * Used on import when the target slug directory will be created fresh.
 */
export async function getOrComputeStoreDir(projectRoot: string): Promise<string> {
  const existing = await findProjectStoreDir(projectRoot);
  if (existing) return existing;
  const canonical = await canonicalizeProjectRoot(projectRoot);
  return path.join(getClaudeProjectsDir(), sanitizeProjectKey(canonical));
}

/**
 * List all main transcript files for a project, newest first by mtime.
 * Only top-level `.jsonl` files in the store are returned — sidecar
 * directories (subagents, session-memory) are covered by the artifact
 * collector in Phase 3C and aren't walked here.
 */
export async function listProjectSessionFiles(projectRoot: string): Promise<string[]> {
  const storeDir = await findProjectStoreDir(projectRoot);
  if (!storeDir) return [];
  return listJsonlFilesByMtime(storeDir);
}

/**
 * A single file inside a session's sidecar directory on the source
 * machine. Used as the input to the export pipeline's artifact loop.
 */
export interface SourceArtifact {
  kind: 'subagent' | 'subagent-meta' | 'remote-agent' | 'session-memory';
  /** Absolute path to the file on disk. */
  sourcePath: string;
  /** Path relative to `<storeDir>/<sessionId>/`, e.g. "subagents/foo.jsonl". */
  relativePath: string;
}

/**
 * Collect all sidecar artifacts that live beside a session's main
 * transcript: subagent transcripts and their meta sidecars, remote-agent
 * transcripts, and session-memory markdown. Returns an empty array if
 * the session has no sidecar directory.
 */
export async function collectSessionArtifacts(
  mainTranscriptPath: string,
): Promise<SourceArtifact[]> {
  const dir = path.dirname(mainTranscriptPath);
  const sessionId = path.basename(mainTranscriptPath, '.jsonl');
  const sidecarDir = path.join(dir, sessionId);

  try {
    const stats = await stat(sidecarDir);
    if (!stats.isDirectory()) return [];
  } catch {
    return [];
  }

  const results: SourceArtifact[] = [];
  await walkSidecars(sidecarDir, sidecarDir, results);
  return results;
}

async function walkSidecars(
  current: string,
  sidecarRoot: string,
  out: SourceArtifact[],
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(current);
  } catch {
    return;
  }

  for (const name of entries) {
    const fullPath = path.join(current, name);
    let entryStat;
    try {
      entryStat = await stat(fullPath);
    } catch {
      continue;
    }

    if (entryStat.isDirectory()) {
      await walkSidecars(fullPath, sidecarRoot, out);
      continue;
    }
    if (!entryStat.isFile()) continue;

    const relativePath = path.relative(sidecarRoot, fullPath).split(path.sep).join('/');
    const kind = classifySidecar(relativePath);
    if (kind === null) continue;

    out.push({ kind, sourcePath: fullPath, relativePath });
  }
}

function classifySidecar(
  relativePath: string,
): 'subagent' | 'subagent-meta' | 'remote-agent' | 'session-memory' | null {
  if (relativePath.startsWith('subagents/')) {
    if (relativePath.endsWith('.jsonl')) return 'subagent';
    if (relativePath.endsWith('.meta.json')) return 'subagent-meta';
    return null;
  }
  if (relativePath.startsWith('remote-agents/') && relativePath.endsWith('.jsonl')) {
    return 'remote-agent';
  }
  if (relativePath.startsWith('session-memory/')) {
    return 'session-memory';
  }
  return null;
}

/**
 * Resolve a `sessionId` to its main transcript file.
 *
 * If `projectRoot` is provided, look only inside that project's store
 * directory. If omitted, scan every directory under
 * `~/.claude/projects/` — slower but covers the case where the session
 * was continued in a different project or the current cwd doesn't
 * match what Claude Code recorded.
 */
export async function resolveMainSessionFile(
  sessionId: string,
  projectRoot?: string,
): Promise<string | null> {
  const targetName = `${sessionId}.jsonl`;

  if (projectRoot) {
    const storeDir = await findProjectStoreDir(projectRoot);
    if (!storeDir) return null;
    return fileExistsAt(path.join(storeDir, targetName));
  }

  const projectsDir = getClaudeProjectsDir();
  let entries: string[];
  try {
    entries = await readdir(projectsDir);
  } catch {
    return null;
  }

  for (const entry of entries) {
    const candidate = path.join(projectsDir, entry, targetName);
    const hit = await fileExistsAt(candidate);
    if (hit) return hit;
  }
  return null;
}

// --- internals ---

async function listJsonlFilesByMtime(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const jsonlFiles = entries.filter((e) => e.endsWith('.jsonl'));
  const withStats = await Promise.all(
    jsonlFiles.map(async (name) => {
      const fullPath = path.join(dir, name);
      const s = await stat(fullPath);
      return { path: fullPath, mtime: s.mtimeMs };
    }),
  );
  withStats.sort((a, b) => b.mtime - a.mtime);
  return withStats.map((f) => f.path);
}

async function fileExistsAt(filePath: string): Promise<string | null> {
  try {
    const s = await stat(filePath);
    return s.isFile() ? filePath : null;
  } catch {
    return null;
  }
}

/**
 * Open the oldest-sorted `.jsonl` in a candidate store directory and
 * return the first `cwd` string we find within the first few lines.
 * Used for project-dir fallback matching only.
 */
async function peekStoredCwd(candidateDir: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(candidateDir);
  } catch {
    return null;
  }

  const jsonlFiles = entries.filter((e) => e.endsWith('.jsonl'));
  if (jsonlFiles.length === 0) return null;

  // Deterministic choice so two lookups give the same answer.
  jsonlFiles.sort();
  return peekCwdInFile(path.join(candidateDir, jsonlFiles[0]));
}

async function peekCwdInFile(filePath: string, maxLines = 20): Promise<string | null> {
  const stream = createReadStream(filePath, { encoding: 'utf-8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  let read = 0;
  try {
    for await (const line of rl) {
      if (read++ >= maxLines) break;
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const record = JSON.parse(trimmed) as { cwd?: unknown };
        if (typeof record.cwd === 'string') {
          return record.cwd;
        }
      } catch {
        // skip malformed line; the session module handles recovery elsewhere
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return null;
}
