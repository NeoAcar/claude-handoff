/**
 * claude-handoff export — Alice's command.
 *
 * Copies session files from ~/.claude/projects/<slug>/ into .claude-shared/sessions/,
 * with paths rewritten to portable placeholders and secrets redacted.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  findSlugForPath,
  getClaudeProjectsDir,
  localToPortable,
  deepRewrite,
} from '../core/paths.js';
import { listSessionFiles, extractSessionMeta, transformSession } from '../core/session.js';
import type { SessionRecord } from '../core/session.js';
import { deepRedact } from '../core/redactor.js';
import type { RedactionHit } from '../core/redactor.js';
import { readManifest, writeManifest, createEmptyManifest } from '../core/manifest.js';
import type { ManifestEntry } from '../core/manifest.js';

export interface ExportOptions {
  dryRun: boolean;
  noRedact: boolean;
  iKnowWhatImDoing: boolean;
  author?: string;
  session?: string;
  last?: number;
  since?: string;
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
  const slug = await findSlugForPath(projectRoot);
  const slugDir = slug
    ? path.join(getClaudeProjectsDir(), slug)
    : path.join(getClaudeProjectsDir(), '<not-found>');
  const sharedDir = path.join(projectRoot, '.claude-shared');
  const sessionsDir = path.join(sharedDir, 'sessions');
  const localDir = path.join(projectRoot, '.claude-handoff');

  // Find session files
  let sessionFiles = await listSessionFiles(slugDir);
  if (sessionFiles.length === 0) {
    console.log('No Claude Code sessions found for this project.');
    console.log(`Looked in: ${slugDir}`);
    return;
  }

  // Apply filters
  if (options.session) {
    sessionFiles = sessionFiles.filter((f) => path.basename(f).startsWith(options.session!));
    if (sessionFiles.length === 0) {
      throw new Error(`No session matching "${options.session}" found.`);
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
      const title = meta.customTitle ?? meta.lastPrompt ?? '(untitled)';
      console.log(`  ${path.basename(f)} — ${title} (${meta.recordCount} records)`);
    }
    console.log('\nRun without --dry-run to export.');
    return;
  }

  // Ensure output directories exist
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(localDir, { recursive: true });

  // Read or create manifest
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

  for (const sessionFile of sessionFiles) {
    const meta = await extractSessionMeta(sessionFile);

    // Build export filename: timestamp_author_session-id.jsonl
    const ts = meta.firstTimestamp
      ? meta.firstTimestamp.replace(/[:.]/g, '-').slice(0, 19)
      : new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const exportFilename = `${ts}_${author}_${meta.sessionId}.jsonl`;
    const outputPath = path.join(sessionsDir, exportFilename);

    // Check if already exported
    const alreadyExported = manifest.sessions.some((s) => s.sessionId === meta.sessionId);
    if (alreadyExported) {
      console.log(`  Skipping ${meta.sessionId} (already exported)`);
      continue;
    }

    // Transform: path rewrite + optional redaction
    let sessionHits: RedactionHit[] = [];

    const { count, stats } = await transformSession(sessionFile, outputPath, (record) => {
      // Path rewrite
      let rewritten = deepRewrite(record, (s) =>
        localToPortable(s, projectRoot, localHome),
      ) as SessionRecord;

      // Redaction
      if (!options.noRedact) {
        const { value, hits } = deepRedact(rewritten);
        rewritten = value as SessionRecord;
        sessionHits.push(...hits);
      }

      return rewritten;
    });

    const entry: ManifestEntry = {
      sessionId: meta.sessionId,
      originalFilename: path.basename(sessionFile),
      exportedFilename: exportFilename,
      author,
      exportedAt: new Date().toISOString(),
      recordCount: count,
      redactionHits: sessionHits.length,
    };

    manifest.sessions.push(entry);
    result.exported.push(entry);
    result.totalRedactionHits += sessionHits.length;
    result.allHits.push(...sessionHits);
    result.totalMalformed += stats.malformedLines;
    result.totalRecovered += stats.recoveredLines;
    result.totalSkipped += stats.skippedLines;

    const title = meta.customTitle ?? meta.lastPrompt ?? '(untitled)';
    let suffix = '';
    if (stats.recoveredLines > 0 || stats.skippedLines > 0) {
      suffix = ` [recovered ${stats.recoveredLines}, skipped ${stats.skippedLines}]`;
    }
    console.log(`  Exported: ${exportFilename} — ${title} (${count} records)${suffix}`);
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

async function getGitUserName(): Promise<string | undefined> {
  try {
    const { execSync } = await import('node:child_process');
    return execSync('git config user.name', { encoding: 'utf-8' }).trim() || undefined;
  } catch {
    return undefined;
  }
}
