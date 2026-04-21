/**
 * claude-handoff export — Alice's command.
 *
 * Packages each local session as a bundle directory under
 * .claude-shared/sessions/<sessionId>/, containing:
 *   main.jsonl            — streamed + transformed main transcript
 *   metadata.json         — author, exportedAt, title, timestamps
 *   subagents/*.jsonl     — per-subagent transcripts (if any)
 *   subagents/*.meta.json — per-subagent metadata sidecars (if any)
 *   remote-agents/*.jsonl — per-remote-agent transcripts (if any)
 *   session-memory/*      — session-memory markdown (if any)
 *
 * Every artifact runs through the same path-rewrite + redaction
 * pipeline as the main transcript, adapted to the artifact type
 * (streaming for JSONL, buffered for JSON/markdown).
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { localToPortable, deepRewrite } from '../core/paths.js';
import {
  collectSessionArtifacts,
  findCanonicalGitRoot,
  findExistingMemoryDir,
  findProjectStoreDir,
  getClaudeProjectsDir,
  listMemoryFiles,
  listProjectSessionFiles,
} from '../core/store.js';
import type { SourceArtifact } from '../core/store.js';
import { extractSessionMeta, transformSession } from '../core/session.js';
import type { SessionRecord } from '../core/session.js';
import { stripThinkingSignatures } from '../core/sanitizeRecord.js';
import { deepRedact, parseCustomPatterns, redactText } from '../core/redactor.js';
import type { RedactionHit, RedactionPattern } from '../core/redactor.js';
import { readManifest, writeManifest, createEmptyManifest } from '../core/manifest.js';
import type { BundleArtifact, ManifestEntry, MemoryArtifact } from '../core/manifest.js';

export interface ExportOptions {
  dryRun: boolean;
  noRedact: boolean;
  iKnowWhatImDoing: boolean;
  author?: string;
  session?: string;
  last?: number;
  since?: string;
  stripProgress?: boolean;
  /**
   * Strip `thinking` content blocks that carry a `signature` field.
   * Default true — an unstripped signature is tied to the origin API
   * key + model and causes a 400 on the next API turn after resume.
   * Turn off when the recipient shares your API key/model and wants
   * full thinking context preserved.
   */
  keepSignatures?: boolean;
  /**
   * Export the project's auto-memory (`~/.claude/projects/<key>/memory/`)
   * alongside sessions. Off by default — memory files often contain
   * personal observations the user hasn't explicitly decided to share.
   */
  includeMemory?: boolean;
}

interface ExportResult {
  exported: ManifestEntry[];
  totalRedactionHits: number;
  allHits: RedactionHit[];
  totalMalformed: number;
  totalRecovered: number;
  totalSkipped: number;
}

export async function exportCommand(projectRoot: string, options: ExportOptions): Promise<void> {
  // Safety check for --no-redact
  if (options.noRedact && !options.iKnowWhatImDoing) {
    throw new Error(
      '--no-redact requires --i-know-what-im-doing flag. ' +
        'Exporting without redaction may expose secrets.',
    );
  }

  const localHome = os.homedir();
  const storeDir = await findProjectStoreDir(projectRoot);
  const sharedDir = path.join(projectRoot, '.claude-shared');
  const sessionsDir = path.join(sharedDir, 'sessions');
  const localDir = path.join(projectRoot, '.claude-handoff');

  // Find session files
  let sessionFiles = await listProjectSessionFiles(projectRoot);
  if (sessionFiles.length === 0) {
    console.log('No Claude Code sessions found for this project.');
    console.log(
      `Looked in: ${storeDir ?? path.join(getClaudeProjectsDir(), '<no matching project store>')}`,
    );
    return;
  }

  // Apply filters
  if (options.session) {
    sessionFiles = sessionFiles.filter((f) => path.basename(f).startsWith(options.session!));
    if (sessionFiles.length === 0) {
      throw new Error(`No session matching "${options.session}" found.`);
    }
  }

  if (options.since) {
    const sinceMs = Date.parse(options.since);
    if (Number.isNaN(sinceMs)) {
      throw new Error(
        `Invalid --since value: "${options.since}". Use ISO date (e.g., 2026-04-01 or 2026-04-01T12:00:00Z).`,
      );
    }
    const filtered: string[] = [];
    for (const f of sessionFiles) {
      const meta = await extractSessionMeta(f);
      const firstMs = meta.firstTimestamp ? Date.parse(meta.firstTimestamp) : NaN;
      if (!Number.isNaN(firstMs) && firstMs >= sinceMs) {
        filtered.push(f);
      }
    }
    sessionFiles = filtered;
    if (sessionFiles.length === 0) {
      console.log(`No sessions modified since ${options.since}.`);
      return;
    }
  }

  if (options.last) {
    sessionFiles = sessionFiles.slice(0, options.last);
  }

  // Get author name
  const author = options.author ?? (await getGitUserName()) ?? os.userInfo().username;

  // Dry-run mode
  if (options.dryRun) {
    console.log(`Would export ${sessionFiles.length} session(s) as "${author}":\n`);
    for (const f of sessionFiles) {
      const meta = await extractSessionMeta(f);
      const sidecars = await collectSessionArtifacts(f);
      const title = meta.customTitle ?? meta.lastPrompt ?? '(untitled)';
      const sidecarNote = sidecars.length > 0 ? ` + ${sidecars.length} sidecar(s)` : '';
      console.log(`  ${path.basename(f)} — ${title} (${meta.recordCount} records${sidecarNote})`);
    }
    console.log('\nRun without --dry-run to export.');
    return;
  }

  // Ensure output directories exist
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(localDir, { recursive: true });

  // Load user-supplied redaction patterns from .claude-handoff-ignore, if any.
  // The file lives in the project root (not in .claude-handoff/) so a team can
  // optionally commit it; format is one regex per line, # for comments.
  const customPatterns = await loadCustomPatterns(projectRoot);
  if (customPatterns.length > 0) {
    console.log(
      `Loaded ${customPatterns.length} custom redaction pattern(s) from .claude-handoff-ignore`,
    );
  }

  // Read or create manifest. readManifest auto-migrates v1 → v2 on load
  // so older .claude-shared/ folders keep working.
  let manifest = await readManifest(sharedDir);
  if (!manifest) {
    manifest = createEmptyManifest('0.1.0');
  }

  const result: ExportResult = {
    exported: [],
    totalRedactionHits: 0,
    allHits: [],
    totalMalformed: 0,
    totalRecovered: 0,
    totalSkipped: 0,
  };

  // Pass the resolved store dir into the rewriter so session JSONL
  // references that point into ~/.claude/projects/<key>/... (memory
  // files, subagent sidecars, `writtenPaths` entries) survive the
  // Alice→Neo key change by round-tripping through {{CLAUDE_STORE}}.
  const rewriteString = (s: string) =>
    localToPortable(s, projectRoot, localHome, storeDir ?? undefined);

  for (const sessionFile of sessionFiles) {
    const meta = await extractSessionMeta(sessionFile);
    const sessionId = meta.sessionId;

    // Check if already exported
    const alreadyExported = manifest.sessions.some((s) => s.sessionId === sessionId);
    if (alreadyExported) {
      console.log(`  Skipping ${sessionId} (already exported)`);
      continue;
    }

    const bundleDir = path.join(sessionsDir, sessionId);
    await mkdir(bundleDir, { recursive: true });

    const sessionHits: RedactionHit[] = [];
    const artifacts: BundleArtifact[] = [];

    // --- Main transcript ---
    let strippedProgress = 0;
    const mainBundlePath = 'main.jsonl';
    const mainDest = path.join(bundleDir, mainBundlePath);
    const mainTransform = await transformSession(sessionFile, mainDest, (record) => {
      if (options.stripProgress && record.type === 'progress') {
        strippedProgress++;
        return null;
      }
      const sanitized = options.keepSignatures ? record : stripThinkingSignatures(record);
      let rewritten = deepRewrite(sanitized, rewriteString) as SessionRecord;
      if (!options.noRedact) {
        const { value, hits } = deepRedact(rewritten, customPatterns);
        rewritten = value as SessionRecord;
        sessionHits.push(...hits);
      }
      return rewritten;
    });

    const mainSize = await fileSize(mainDest);
    const mainRedactionHitsBefore = 0; // tracked via sessionHits above
    artifacts.push({
      kind: 'transcript',
      bundlePath: mainBundlePath,
      originalRelativePath: '',
      recordCount: mainTransform.count,
      redactionHits: sessionHits.length - mainRedactionHitsBefore,
      bytes: mainSize,
    });
    result.totalMalformed += mainTransform.stats.malformedLines;
    result.totalRecovered += mainTransform.stats.recoveredLines;
    result.totalSkipped += mainTransform.stats.skippedLines;

    // --- Sidecars (subagents, remote-agents, session-memory) ---
    const sidecarSources = await collectSessionArtifacts(sessionFile);
    for (const src of sidecarSources) {
      const bundlePath = src.relativePath;
      const dest = path.join(bundleDir, bundlePath);
      await mkdir(path.dirname(dest), { recursive: true });

      if (bundlePath.endsWith('.jsonl')) {
        const hitsBefore = sessionHits.length;
        const sideTransform = await transformSession(src.sourcePath, dest, (record) => {
          if (options.stripProgress && record.type === 'progress') {
            strippedProgress++;
            return null;
          }
          const sanitized = options.keepSignatures ? record : stripThinkingSignatures(record);
          let rewritten = deepRewrite(sanitized, rewriteString) as SessionRecord;
          if (!options.noRedact) {
            const { value, hits } = deepRedact(rewritten, customPatterns);
            rewritten = value as SessionRecord;
            sessionHits.push(...hits);
          }
          return rewritten;
        });
        artifacts.push({
          kind: src.kind === 'subagent' ? 'subagent' : 'remote-agent',
          bundlePath,
          originalRelativePath: src.relativePath,
          recordCount: sideTransform.count,
          redactionHits: sessionHits.length - hitsBefore,
          bytes: await fileSize(dest),
        });
        result.totalMalformed += sideTransform.stats.malformedLines;
        result.totalRecovered += sideTransform.stats.recoveredLines;
        result.totalSkipped += sideTransform.stats.skippedLines;
      } else if (bundlePath.endsWith('.json')) {
        const hitsBefore = sessionHits.length;
        await transformJsonFile(src.sourcePath, dest, {
          rewriteString,
          redact: !options.noRedact,
          customPatterns,
          onHits: (hits) => sessionHits.push(...hits),
        });
        artifacts.push({
          kind: 'subagent-meta',
          bundlePath,
          originalRelativePath: src.relativePath,
          redactionHits: sessionHits.length - hitsBefore,
          bytes: await fileSize(dest),
        });
      } else {
        // markdown or any other text file
        const hitsBefore = sessionHits.length;
        await transformTextFile(src.sourcePath, dest, {
          rewriteString,
          redact: !options.noRedact,
          customPatterns,
          onHits: (hits) => sessionHits.push(...hits),
        });
        artifacts.push({
          kind: 'session-memory',
          bundlePath,
          originalRelativePath: src.relativePath,
          redactionHits: sessionHits.length - hitsBefore,
          bytes: await fileSize(dest),
        });
      }
    }

    // --- Per-bundle metadata sidecar ---
    const title = meta.customTitle ?? meta.lastPrompt ?? '(untitled)';
    const metadataPayload = {
      sessionId,
      author,
      exportedAt: new Date().toISOString(),
      title,
      firstTimestamp: meta.firstTimestamp,
      lastTimestamp: meta.lastTimestamp,
      sourceProjectRoot: projectRoot,
      strippedProgress,
    };
    const metadataPath = path.join(bundleDir, 'metadata.json');
    await writeFile(metadataPath, JSON.stringify(metadataPayload, null, 2) + '\n', 'utf-8');

    // --- Manifest entry ---
    const entry: ManifestEntry = {
      sessionId,
      author,
      exportedAt: metadataPayload.exportedAt,
      sourceProjectRoot: projectRoot,
      title,
      firstTimestamp: meta.firstTimestamp,
      lastTimestamp: meta.lastTimestamp,
      totalRedactionHits: sessionHits.length,
      totalMalformed: mainTransform.stats.malformedLines,
      totalRecovered: mainTransform.stats.recoveredLines,
      totalSkipped: mainTransform.stats.skippedLines,
      artifacts,
    };

    manifest.sessions.push(entry);
    result.exported.push(entry);
    result.totalRedactionHits += sessionHits.length;
    result.allHits.push(...sessionHits);

    // --- Console line ---
    const sidecarCount = artifacts.length - 1;
    let suffix = '';
    if (mainTransform.stats.recoveredLines > 0 || mainTransform.stats.skippedLines > 0) {
      suffix = ` [recovered ${mainTransform.stats.recoveredLines}, skipped ${mainTransform.stats.skippedLines}]`;
    }
    if (strippedProgress > 0) {
      suffix += ` [stripped ${strippedProgress} progress]`;
    }
    const sidecarNote = sidecarCount > 0 ? ` + ${sidecarCount} sidecar(s)` : '';
    console.log(
      `  Exported: ${sessionId}/ — ${title} (${mainTransform.count} records${sidecarNote})${suffix}`,
    );
  }

  // --- Project memory (opt-in via --memory) ---
  if (options.includeMemory) {
    const memoryBundle = await exportMemory({
      projectRoot,
      sharedDir,
      rewriteString,
      redact: !options.noRedact,
      customPatterns,
      onHits: (hits) => result.allHits.push(...hits),
    });
    if (memoryBundle) {
      manifest.memory = memoryBundle;
      result.totalRedactionHits = result.allHits.length;
      const redactedCount = memoryBundle.files.reduce((n, f) => n + (f.redactionHits ?? 0), 0);
      console.log(
        `  Exported ${memoryBundle.files.length} memory file(s) (${redactedCount} redaction marker(s))`,
      );
    } else {
      console.log('  No memory directory found for this project — nothing to export.');
    }
  }

  // Write manifest
  manifest.lastExportAt = new Date().toISOString();
  await writeManifest(sharedDir, manifest);

  // Write redaction log (local only), grouped by pattern for easier review.
  if (result.allHits.length > 0) {
    const logPath = path.join(localDir, 'redaction-log.json');
    const byPattern = groupHits(result.allHits);
    await writeFile(
      logPath,
      JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          uniqueSecrets: countUniqueHits(result.allHits),
          totalMarkers: result.allHits.length,
          byPattern,
        },
        null,
        2,
      ) + '\n',
      'utf-8',
    );
  }

  // Summary
  console.log(`\nExported ${result.exported.length} session(s) to .claude-shared/`);
  if (result.totalRedactionHits > 0) {
    const uniqueCount = countUniqueHits(result.allHits);
    const byPattern = groupByPattern(result.allHits);
    console.log(
      `Redacted: ${uniqueCount} unique secret(s), ${result.totalRedactionHits} marker(s) written across fields`,
    );
    const breakdown = Object.entries(byPattern)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => `${name}=${count}`)
      .join(', ');
    console.log(`  by pattern: ${breakdown}`);
    console.log(`Review: .claude-handoff/redaction-log.json`);
  }
  if (result.totalMalformed > 0) {
    console.log(
      `Malformed lines: ${result.totalMalformed} ` +
        `(recovered ${result.totalRecovered}, skipped ${result.totalSkipped})`,
    );
  }
  console.log('Before committing, run: git diff .claude-shared/');
}

// --- Artifact transform helpers (buffered — for small text files) ---

interface TransformCtx {
  rewriteString: (s: string) => string;
  redact: boolean;
  customPatterns: RedactionPattern[];
  onHits: (hits: RedactionHit[]) => void;
}

/**
 * Read a JSON file, walk every string value through path rewriting +
 * redaction, write the result back out. Used for `<sid>/subagents/*.meta.json`.
 */
async function transformJsonFile(src: string, dst: string, ctx: TransformCtx): Promise<void> {
  const raw = await readFile(src, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;
  let rewritten = deepRewrite(parsed, ctx.rewriteString);
  if (ctx.redact) {
    const { value, hits } = deepRedact(rewritten, ctx.customPatterns);
    rewritten = value;
    ctx.onHits(hits);
  }
  await writeFile(dst, JSON.stringify(rewritten, null, 2) + '\n', 'utf-8');
}

/**
 * Read a text file (markdown, plain text), rewrite paths + redact, write.
 * Used for session-memory/*.md.
 */
async function transformTextFile(src: string, dst: string, ctx: TransformCtx): Promise<void> {
  let content = await readFile(src, 'utf-8');
  content = ctx.rewriteString(content);
  if (ctx.redact) {
    const { text, hits } = redactText(content, ctx.customPatterns);
    content = text;
    ctx.onHits(hits);
  }
  await writeFile(dst, content, 'utf-8');
}

/**
 * Export the project's memory/ tree into `.claude-shared/memory/`,
 * excluding `MEMORY.md` (which is LLM-regenerated). Returns a
 * MemoryBundle manifest section or null when there's nothing to export.
 */
async function exportMemory(args: {
  projectRoot: string;
  sharedDir: string;
  rewriteString: (s: string) => string;
  redact: boolean;
  customPatterns: RedactionPattern[];
  onHits: (hits: RedactionHit[]) => void;
}): Promise<{ exportedAt: string; sourceGitRoot?: string; files: MemoryArtifact[] } | null> {
  const memSource = await findExistingMemoryDir(args.projectRoot);
  if (!memSource) return null;

  const sourceGitRoot = await findCanonicalGitRoot(args.projectRoot);

  const entries = await listMemoryFiles(args.projectRoot);
  if (entries.length === 0) return null;

  const memOut = path.join(args.sharedDir, 'memory');
  await mkdir(memOut, { recursive: true });

  const files: MemoryArtifact[] = [];
  for (const entry of entries) {
    const dest = path.join(memOut, entry.relativePath);
    await mkdir(path.dirname(dest), { recursive: true });
    const hitsBefore = 0;
    const sink: RedactionHit[] = [];
    await transformTextFile(entry.absolutePath, dest, {
      rewriteString: args.rewriteString,
      redact: args.redact,
      customPatterns: args.customPatterns,
      onHits: (hits) => sink.push(...hits),
    });
    args.onHits(sink);
    files.push({
      bundlePath: entry.relativePath,
      bytes: await fileSize(dest),
      redactionHits: sink.length - hitsBefore,
    });
  }

  return {
    exportedAt: new Date().toISOString(),
    sourceGitRoot,
    files,
  };
}

async function fileSize(p: string): Promise<number> {
  try {
    const s = await stat(p);
    return s.size;
  } catch {
    return 0;
  }
}

/**
 * Count distinct (pattern, context) pairs. The same secret serialized in
 * multiple JSONL fields produces one marker per field but counts as one
 * unique secret — this number is what a human reviewer actually cares about.
 */
function countUniqueHits(hits: RedactionHit[]): number {
  const seen = new Set<string>();
  for (const h of hits) {
    seen.add(`${h.pattern}\0${h.context}`);
  }
  return seen.size;
}

function groupByPattern(hits: RedactionHit[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const h of hits) {
    counts[h.pattern] = (counts[h.pattern] ?? 0) + 1;
  }
  return counts;
}

/**
 * Group hits by pattern and deduplicate contexts within each group, so the
 * log reads as: pattern → list of distinct matches → occurrence count.
 */
function groupHits(
  hits: RedactionHit[],
): Record<string, { unique: number; markers: number; contexts: string[] }> {
  const groups: Record<string, { contexts: Map<string, number> }> = {};
  for (const h of hits) {
    const g = (groups[h.pattern] ??= { contexts: new Map() });
    g.contexts.set(h.context, (g.contexts.get(h.context) ?? 0) + 1);
  }
  const out: Record<string, { unique: number; markers: number; contexts: string[] }> = {};
  for (const [pattern, g] of Object.entries(groups)) {
    let markers = 0;
    for (const n of g.contexts.values()) markers += n;
    out[pattern] = {
      unique: g.contexts.size,
      markers,
      contexts: Array.from(g.contexts.keys()),
    };
  }
  return out;
}

async function loadCustomPatterns(projectRoot: string): Promise<RedactionPattern[]> {
  const ignorePath = path.join(projectRoot, '.claude-handoff-ignore');
  try {
    const content = await readFile(ignorePath, 'utf-8');
    return parseCustomPatterns(content);
  } catch {
    return [];
  }
}

async function getGitUserName(): Promise<string | undefined> {
  try {
    const { execSync } = await import('node:child_process');
    return execSync('git config user.name', { encoding: 'utf-8' }).trim() || undefined;
  } catch {
    return undefined;
  }
}
