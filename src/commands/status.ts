/**
 * claude-handoff status — show local sessions, shared sessions, and diff.
 */

import path from 'node:path';
import { findSlugForPath, computeSlug, getClaudeProjectsDir } from '../core/paths.js';
import { listSessionFiles, extractSessionMeta } from '../core/session.js';
import { readManifest } from '../core/manifest.js';

export async function statusCommand(projectRoot: string): Promise<void> {
  const slug = (await findSlugForPath(projectRoot)) ?? computeSlug(projectRoot);
  const slugDir = path.join(getClaudeProjectsDir(), slug);
  const sharedDir = path.join(projectRoot, '.claude-shared');
  const sessionsDir = path.join(sharedDir, 'sessions');

  // Local sessions
  const localFiles = await listSessionFiles(slugDir);
  console.log(`Local sessions (${slugDir}):`);
  if (localFiles.length === 0) {
    console.log('  (none)');
  } else {
    for (const f of localFiles) {
      const meta = await extractSessionMeta(f);
      const title = meta.customTitle ?? meta.lastPrompt ?? '(untitled)';
      let suffix = '';
      if (meta.stats.malformedLines > 0) {
        suffix = ` [malformed ${meta.stats.malformedLines}: recovered ${meta.stats.recoveredLines}, skipped ${meta.stats.skippedLines}]`;
      }
      console.log(`  ${meta.sessionId} — ${title} (${meta.recordCount} records)${suffix}`);
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
      const meta = await extractSessionMeta(f);
      const title = meta.customTitle ?? meta.lastPrompt ?? '(untitled)';
      console.log(`  ${path.basename(f)} — ${title} (${meta.recordCount} records)`);
    }
  }

  // Manifest info
  const manifest = await readManifest(sharedDir);
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
