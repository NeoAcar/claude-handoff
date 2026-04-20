/**
 * claude-handoff import — Bob's command.
 *
 * Copies session files from .claude-shared/sessions/ into ~/.claude/projects/<slug>/,
 * with portable placeholders rewritten to Bob's local paths.
 */

import { mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  computeSlug,
  getClaudeProjectsDir,
  portableToLocal,
  deepRewrite,
} from '../core/paths.js';
import {
  listSessionFiles,
  extractSessionMeta,
  transformSession,
} from '../core/session.js';
import type { SessionRecord } from '../core/session.js';

export interface ImportOptions {
  dryRun: boolean;
  session?: string;
  all: boolean;
  overwrite: boolean;
}

export async function importCommand(
  projectRoot: string,
  options: ImportOptions,
): Promise<void> {
  const localHome = os.homedir();
  const slug = computeSlug(projectRoot);
  const slugDir = path.join(getClaudeProjectsDir(), slug);
  const sharedDir = path.join(projectRoot, '.claude-shared');
  const sessionsDir = path.join(sharedDir, 'sessions');

  // Find shared session files
  let sessionFiles = await listSessionFiles(sessionsDir);
  if (sessionFiles.length === 0) {
    console.log('No shared sessions found in .claude-shared/sessions/');
    console.log('Has someone run `claude-handoff export` and committed the result?');
    return;
  }

  // Apply filters
  if (options.session) {
    sessionFiles = sessionFiles.filter((f) => path.basename(f).includes(options.session!));
    if (sessionFiles.length === 0) {
      throw new Error(`No session matching "${options.session}" found.`);
    }
  }

  // Dry-run mode
  if (options.dryRun) {
    console.log(`Would import ${sessionFiles.length} session(s) into:\n  ${slugDir}\n`);
    for (const f of sessionFiles) {
      const meta = await extractSessionMeta(f);
      const title = meta.customTitle ?? meta.lastPrompt ?? '(untitled)';
      console.log(`  ${path.basename(f)} — ${title} (${meta.recordCount} records)`);
    }
    console.log('\nRun without --dry-run to import.');
    return;
  }

  // Ensure target directory exists
  await mkdir(slugDir, { recursive: true });

  let importedCount = 0;
  let skippedCount = 0;

  for (const sessionFile of sessionFiles) {
    const meta = await extractSessionMeta(sessionFile);
    const outputFilename = `${meta.sessionId}.jsonl`;
    const outputPath = path.join(slugDir, outputFilename);

    // Check if already exists locally
    const exists = await access(outputPath).then(() => true).catch(() => false);
    if (exists && !options.overwrite) {
      console.log(`  Skipping ${meta.sessionId} (already exists locally, use --overwrite to replace)`);
      skippedCount++;
      continue;
    }

    // Transform: portable placeholders → local paths
    const count = await transformSession(sessionFile, outputPath, (record) => {
      return deepRewrite(record, (s) =>
        portableToLocal(s, projectRoot, localHome),
      ) as SessionRecord;
    });

    const title = meta.customTitle ?? meta.lastPrompt ?? '(untitled)';
    console.log(`  Imported: ${outputFilename} — ${title} (${count} records)`);
    importedCount++;
  }

  console.log(`\nImported ${importedCount} session(s)`);
  if (skippedCount > 0) {
    console.log(`Skipped ${skippedCount} (already existed)`);
  }
  console.log('Open Claude Code and use /resume to see imported sessions.');
}
