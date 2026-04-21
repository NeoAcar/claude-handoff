/**
 * claude-handoff status — show local sessions, shared sessions, and diff.
 */

import path from 'node:path';
import { stat } from 'node:fs/promises';
import {
  findProjectStoreDir,
  getOrComputeStoreDir,
  listProjectSessionFiles,
} from '../core/store.js';
import { listSessionFiles, extractSessionMeta } from '../core/session.js';
import { readManifest } from '../core/manifest.js';

export async function statusCommand(projectRoot: string): Promise<void> {
  // Resolve the Claude store dir for display; fall back to the computed
  // target when nothing is found so the "looked in X" message is still
  // useful.
  const storeDir =
    (await findProjectStoreDir(projectRoot)) ?? (await getOrComputeStoreDir(projectRoot));
  const sharedDir = path.join(projectRoot, '.claude-shared');
  const sessionsDir = path.join(sharedDir, 'sessions');

  // Load manifest up front so the local listing can flag sessions modified
  // since the last export (freshness indicator).
  const manifest = await readManifest(sharedDir);
  const lastExportMs = manifest?.lastExportAt
    ? new Date(manifest.lastExportAt).getTime()
    : undefined;

  // Local sessions
  const localFiles = await listProjectSessionFiles(projectRoot);
  console.log(`Local sessions (${storeDir}):`);
  if (localFiles.length === 0) {
    console.log('  (none)');
  } else {
    for (const f of localFiles) {
      const [meta, fileStat] = await Promise.all([extractSessionMeta(f), stat(f)]);
      const title = meta.customTitle ?? meta.lastPrompt ?? '(untitled)';
      const size = humanSize(fileStat.size);
      const age = humanAge(fileStat.mtimeMs);
      const fresh = lastExportMs !== undefined && fileStat.mtimeMs > lastExportMs ? ' *' : '';
      let suffix = '';
      if (meta.stats.malformedLines > 0) {
        suffix = ` [malformed ${meta.stats.malformedLines}: recovered ${meta.stats.recoveredLines}, skipped ${meta.stats.skippedLines}]`;
      }
      console.log(
        `  ${meta.sessionId}${fresh} — ${title} (${meta.recordCount} records, ${size}, ${age})${suffix}`,
      );
    }
    if (lastExportMs !== undefined) {
      console.log('  (* = modified since last export)');
    }
  }

  console.log();

  // Shared sessions
  const sharedFiles = await listSessionFiles(sessionsDir);
  console.log(`Shared sessions (.claude-shared/sessions/):`);
  if (sharedFiles.length === 0) {
    console.log('  (none)');
  } else {
    for (const f of sharedFiles) {
      const [meta, fileStat] = await Promise.all([extractSessionMeta(f), stat(f)]);
      const title = meta.customTitle ?? meta.lastPrompt ?? '(untitled)';
      console.log(
        `  ${path.basename(f)} — ${title} (${meta.recordCount} records, ${humanSize(fileStat.size)})`,
      );
    }
  }

  if (manifest) {
    console.log(`\nLast export: ${manifest.lastExportAt}`);
    console.log(`Total exported: ${manifest.sessions.length} session(s)`);
  }

  // Diff: local sessions not yet exported
  if (localFiles.length > 0 && manifest) {
    const exportedIds = new Set(manifest.sessions.map((s) => s.sessionId));
    const unexported = [];
    for (const f of localFiles) {
      const meta = await extractSessionMeta(f);
      if (!exportedIds.has(meta.sessionId)) {
        unexported.push(meta);
      }
    }
    if (unexported.length > 0) {
      console.log(`\nNot yet exported (${unexported.length}):`);
      for (const meta of unexported) {
        const title = meta.customTitle ?? meta.lastPrompt ?? '(untitled)';
        console.log(`  ${meta.sessionId} — ${title}`);
      }
    }
  }
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function humanAge(mtimeMs: number): string {
  const deltaSec = Math.max(0, (Date.now() - mtimeMs) / 1000);
  if (deltaSec < 60) return `${Math.round(deltaSec)}s ago`;
  if (deltaSec < 3600) return `${Math.round(deltaSec / 60)}m ago`;
  if (deltaSec < 86400) return `${Math.round(deltaSec / 3600)}h ago`;
  return `${Math.round(deltaSec / 86400)}d ago`;
}
