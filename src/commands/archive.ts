/**
 * Archive variants of export and import: the same bundle, carried as one
 * file instead of through `.claude-shared/` in a repo.
 *
 * Both stage the bundle tree in a private temp directory that is removed
 * afterwards, so the project's own `.claude-shared/` is never touched.
 */

import { access, mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { packArchive, unpackArchive } from '../core/archive.js';
import { TOOL_VERSION } from '../core/version.js';
import { exportCommand } from './export.js';
import type { ExportOptions } from './export.js';
import { importCommand } from './import.js';
import type { ImportOptions } from './import.js';

export async function exportArchiveCommand(
  projectRoot: string,
  archivePath: string,
  options: ExportOptions,
): Promise<void> {
  const target = path.resolve(projectRoot, archivePath);
  if (await exists(target)) {
    throw new Error(`${archivePath} already exists. Remove it or choose another name.`);
  }

  if (options.dryRun) {
    await exportCommand(projectRoot, options);
    console.log(`Would write the archive to ${target}`);
    return;
  }

  const staging = await mkdtemp(path.join(os.tmpdir(), 'claude-handoff-export-'));
  try {
    const exported = await exportCommand(projectRoot, { ...options, sharedDir: staging });
    if (exported === 0) {
      console.log('Nothing was exported, so no archive was written.');
      return;
    }
    await packArchive(staging, target, TOOL_VERSION);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }

  const size = (await stat(target)).size;
  console.log(`Wrote ${target} (${formatSize(size)})`);
  console.log(
    options.noRedact
      ? 'It holds the session WITHOUT redaction. Treat it like the raw conversation.'
      : 'It holds the redacted session. Redaction lowers the risk, it does not remove it — ' +
          'send it only to people you would show the conversation to.',
  );
  const inProject = path.relative(projectRoot, target);
  if (!inProject.startsWith('..') && !path.isAbsolute(inProject)) {
    console.log('Note: the archive is inside the project directory. Keep it out of git.');
  }
  console.log(`They import it with: claude-handoff import ${path.basename(target)}`);
}

export async function importArchiveCommand(
  projectRoot: string,
  archivePath: string,
  options: ImportOptions,
): Promise<void> {
  const source = path.resolve(projectRoot, archivePath);
  const staging = await mkdtemp(path.join(os.tmpdir(), 'claude-handoff-import-'));
  try {
    const index = await unpackArchive(source, staging);
    console.log(
      `Archive verified: ${Object.keys(index.files).length} file(s), ` +
        `written by claude-handoff ${index.toolVersion}`,
    );
    await importCommand(projectRoot, { ...options, sharedDir: staging });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
