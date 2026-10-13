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
import { readManifest } from '../core/manifest.js';
import { TOOL_VERSION } from '../core/version.js';
import { exportCommand } from './export.js';
import type { ExportOptions } from './export.js';
import { importCommand } from './import.js';
import { ARCHIVE_EXTENSION } from './init.js';
import type { ImportOptions } from './import.js';

/**
 * Export to one archive file. With no `archivePath`, the file is named
 * after the exported session and written to the current directory.
 */
export async function exportArchiveCommand(
  projectRoot: string,
  archivePath: string | undefined,
  options: ExportOptions,
): Promise<void> {
  const explicit =
    archivePath === undefined ? undefined : resolveArchiveName(projectRoot, archivePath);
  if (explicit !== undefined && (await exists(explicit))) {
    throw new Error(`${archivePath} already exists. Remove it or choose another name.`);
  }

  if (options.dryRun) {
    await exportCommand(projectRoot, options);
    console.log(
      explicit !== undefined
        ? `Would write the archive to ${explicit}`
        : 'Would write one archive file here, named after the session.',
    );
    return;
  }

  let target: string;
  const staging = await mkdtemp(path.join(os.tmpdir(), 'claude-handoff-export-'));
  try {
    const exported = await exportCommand(projectRoot, { ...options, sharedDir: staging });
    if (exported === 0) {
      console.log('Nothing was exported, so no archive was written.');
      return;
    }
    target = explicit ?? (await autoArchivePath(projectRoot, staging));
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
  console.log(`They import it with: claude-handoff import ${path.basename(target)}`);
}

/** A name given without an extension gets the default one. */
function resolveArchiveName(projectRoot: string, name: string): string {
  const resolved = path.resolve(projectRoot, name);
  return path.extname(resolved) === '' ? resolved + ARCHIVE_EXTENSION : resolved;
}

/**
 * Turn a session title into a file name stem: lowercase words joined by
 * dashes. Redaction markers and anything else non-alphanumeric drop out.
 */
export function archiveStem(title: string | undefined): string {
  const stem = (title ?? '')
    .replace(/\[REDACTED:[^\]]*\]/g, ' ')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '') // accents: ş → s, é → e
    .replace(/ı/g, 'i')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 40)
    .replace(/-+$/, '');
  return stem.length > 0 ? stem : 'session';
}

/**
 * Pick a free file name in the project directory from what was just
 * exported: the session's title, or a count when there are several. The
 * title comes from the staged manifest, so it is already redacted.
 */
async function autoArchivePath(projectRoot: string, staging: string): Promise<string> {
  const manifest = await readManifest(staging);
  const sessions = manifest?.sessions ?? [];
  const stem =
    sessions.length === 1 ? archiveStem(sessions[0].title) : `handoff-${sessions.length}-sessions`;
  for (let n = 1; ; n++) {
    const candidate = path.join(
      projectRoot,
      `${stem}${n === 1 ? '' : `-${n}`}${ARCHIVE_EXTENSION}`,
    );
    if (!(await exists(candidate))) return candidate;
  }
}

export async function importArchiveCommand(
  projectRoot: string,
  archivePath: string,
  options: ImportOptions,
): Promise<void> {
  // Accept the name with or without the default extension.
  let source = path.resolve(projectRoot, archivePath);
  if (!(await exists(source)) && (await exists(source + ARCHIVE_EXTENSION))) {
    source += ARCHIVE_EXTENSION;
  }
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
