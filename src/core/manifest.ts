/**
 * .manifest.json read/write for .claude-shared/.
 *
 * The manifest is the durable index of what has been exported. Each
 * entry is keyed by `sessionId` and points at a bundle directory that
 * holds the main transcript plus any sidecars (subagents, remote-agents,
 * session-memory). On-disk bundle layout:
 *
 *   .claude-shared/sessions/<sessionId>/
 *     main.jsonl
 *     metadata.json
 *     subagents/<name>.jsonl
 *     subagents/<name>.meta.json
 *     remote-agents/<id>.jsonl
 *     session-memory/<file>.md
 *
 * Schema v2 replaces v1's "one flat file per session" shape. v1 manifests
 * are still readable; they're migrated to v2 shape on load so older
 * exports keep showing up in status/list. New exports always write v2.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type ArtifactKind =
  | 'transcript' // main session transcript (always present)
  | 'subagent' // per-subagent JSONL under <sid>/subagents/
  | 'subagent-meta' // per-subagent JSON sidecar under <sid>/subagents/
  | 'remote-agent' // per-remote-agent JSONL under <sid>/remote-agents/
  | 'session-memory'; // markdown under <sid>/session-memory/

export interface BundleArtifact {
  kind: ArtifactKind;
  /** Path relative to the session bundle dir, e.g. "main.jsonl" or "subagents/foo.jsonl". */
  bundlePath: string;
  /** Path relative to the Claude store sidecar dir on the source machine; empty for `main.jsonl`. */
  originalRelativePath: string;
  /** Number of JSONL records written, when applicable. */
  recordCount?: number;
  /** Redaction markers written into this artifact. */
  redactionHits?: number;
  /** Size of the exported artifact on disk. */
  bytes?: number;
}

export interface ManifestEntry {
  sessionId: string;
  author: string;
  exportedAt: string;
  /** Canonicalized project root this session was captured in, when known. */
  sourceProjectRoot?: string;
  /** Snapshot of customTitle or lastPrompt at export time, for human browsing. */
  title?: string;
  firstTimestamp?: string;
  lastTimestamp?: string;
  totalRedactionHits: number;
  totalMalformed: number;
  totalRecovered: number;
  totalSkipped: number;
  artifacts: BundleArtifact[];

  // --- Iteration-support fields (added for 0.2.0).
  /**
   * mtime of the local `<sid>.jsonl` source file at export time, in ms
   * since epoch. Used to detect whether the session has changed since
   * the last export. On import we `utimes()` the destination file back
   * to this value so this field remains the authoritative equality
   * signal across the handoff.
   */
  sourceMtimeMs?: number;
  /**
   * Record count of the source file at export time (not the count
   * written to the bundle — those can differ when --strip-progress
   * drops records). Used alongside `sourceMtimeMs` for fork detection:
   * if a local session has FEWER records than the shared bundle, that
   * usually means teammate work is about to be overwritten.
   */
  sourceRecordCount?: number;
  /**
   * Prior export rounds for this session ID, oldest first. Each
   * round is moved here when the entry gets rewritten during an
   * iterative re-export. Lets `status` / `list` show "round N,
   * most recent by X at T".
   */
  previousExports?: Array<{ author: string; exportedAt: string }>;

  // --- v1 legacy fields, kept only so a v1 manifest round-trips without loss.
  // Never populated on new exports; may exist when we loaded an old manifest
  // and haven't rewritten it yet.
  legacyOriginalFilename?: string;
  legacyExportedFilename?: string;
}

/**
 * A single shared memory file. Memory lives project-wide (not per
 * session), so it's tracked at the top level of the manifest rather
 * than inside a ManifestEntry.
 */
export interface MemoryArtifact {
  /** Path relative to `.claude-shared/memory/`, matches the original. */
  bundlePath: string;
  bytes?: number;
  redactionHits?: number;
}

export interface MemoryBundle {
  exportedAt: string;
  /** Canonical git root this memory set was captured from, when known. */
  sourceGitRoot?: string;
  files: MemoryArtifact[];
}

export interface Manifest {
  schemaVersion: number;
  toolVersion: string;
  lastExportAt: string;
  sessions: ManifestEntry[];
  /** Optional project-level memory bundle, written when `export --memory` ran. */
  memory?: MemoryBundle;
}

export const SCHEMA_VERSION = 2;

export function createEmptyManifest(toolVersion: string): Manifest {
  return {
    schemaVersion: SCHEMA_VERSION,
    toolVersion,
    lastExportAt: new Date().toISOString(),
    sessions: [],
  };
}

export async function readManifest(sharedDir: string): Promise<Manifest | null> {
  const manifestPath = path.join(sharedDir, '.manifest.json');
  let content: string;
  try {
    content = await readFile(manifestPath, 'utf-8');
  } catch {
    return null;
  }
  const parsed = JSON.parse(content) as Partial<Manifest> & {
    sessions?: unknown[];
    schemaVersion?: number;
  };
  const version = parsed.schemaVersion ?? 1;
  if (version === SCHEMA_VERSION) {
    return parsed as Manifest;
  }
  if (version === 1) {
    return migrateV1(parsed as V1Manifest);
  }
  throw new Error(
    `Unknown manifest schemaVersion ${version}. This tool supports v1 (read-only) and v${SCHEMA_VERSION} (read/write).`,
  );
}

export async function writeManifest(sharedDir: string, manifest: Manifest): Promise<void> {
  const manifestPath = path.join(sharedDir, '.manifest.json');
  const normalized: Manifest = { ...manifest, schemaVersion: SCHEMA_VERSION };
  await writeFile(manifestPath, JSON.stringify(normalized, null, 2) + '\n', 'utf-8');
}

// --- v1 → v2 migration ---

interface V1Entry {
  sessionId: string;
  originalFilename: string;
  exportedFilename: string;
  author: string;
  exportedAt: string;
  recordCount: number;
  redactionHits: number;
}

interface V1Manifest {
  schemaVersion: 1;
  toolVersion: string;
  lastExportAt: string;
  sessions: V1Entry[];
}

/**
 * Convert a v1 manifest (each session = one flat exported file) into a v2
 * manifest (each session = a bundle dir with N artifacts). The single
 * exported file becomes a synthetic transcript artifact; legacy filenames
 * are preserved so imports from an older .claude-shared/ keep working.
 */
export function migrateV1(v1: V1Manifest): Manifest {
  return {
    schemaVersion: SCHEMA_VERSION,
    toolVersion: v1.toolVersion,
    lastExportAt: v1.lastExportAt,
    sessions: v1.sessions.map((s) => ({
      sessionId: s.sessionId,
      author: s.author,
      exportedAt: s.exportedAt,
      totalRedactionHits: s.redactionHits,
      totalMalformed: 0,
      totalRecovered: 0,
      totalSkipped: 0,
      artifacts: [
        {
          kind: 'transcript' as const,
          bundlePath: s.exportedFilename, // v1 file sits flat under sessions/
          originalRelativePath: '',
          recordCount: s.recordCount,
          redactionHits: s.redactionHits,
        },
      ],
      legacyOriginalFilename: s.originalFilename,
      legacyExportedFilename: s.exportedFilename,
    })),
  };
}
