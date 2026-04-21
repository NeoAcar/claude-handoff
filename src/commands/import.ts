/**
 * claude-handoff import — Neo's command.
 *
 * Reads session bundles from .claude-shared/sessions/<sessionId>/ and
 * reconstructs them under ~/.claude/projects/<local-store>/, translating
 * portable placeholders back into Neo's real paths.
 *
 * Bundle layout (written by v0.2.0+ export):
 *   .claude-shared/sessions/<sid>/
 *     main.jsonl            → <localStore>/<sid>.jsonl
 *     metadata.json         → (not copied — consumed by this command)
 *     subagents/<x>.jsonl   → <localStore>/<sid>/subagents/<x>.jsonl
 *     subagents/<x>.meta.json → same
 *     remote-agents/<x>.jsonl → same
 *     session-memory/<x>.md → same
 *
 * Legacy v0.1.0 flat layout is auto-migrated on manifest read; main
 * transcripts that sit flat under .claude-shared/sessions/ are still
 * reconstructed correctly.
 */

import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { portableToLocal, deepRewrite } from '../core/paths.js';
import { getMemoryDir, getOrComputeStoreDir } from '../core/store.js';
import { listSessionFiles, extractSessionMeta, transformSession } from '../core/session.js';
import type { SessionRecord } from '../core/session.js';
import { readManifest } from '../core/manifest.js';
import type { BundleArtifact, ManifestEntry } from '../core/manifest.js';

export interface ImportOptions {
  dryRun: boolean;
  session?: string;
  all: boolean;
  overwrite: boolean;
}

export async function importCommand(projectRoot: string, options: ImportOptions): Promise<void> {
  const localHome = os.homedir();
  // Find the existing store dir; if nothing matches, compute a target from
  // the canonicalized project root. This covers Neo's first import on this
  // machine when the slug dir doesn't exist yet.
  const slugDir = await getOrComputeStoreDir(projectRoot);
  const sharedDir = path.join(projectRoot, '.claude-shared');
  const sessionsDir = path.join(sharedDir, 'sessions');

  // Read the manifest; readManifest auto-migrates v0.1.0 → v0.2.0 so we
  // can treat every entry as if it has a bundle + artifacts list.
  const manifest = await readManifest(sharedDir);

  // Build the list of sessions to import.
  let entries: ManifestEntry[];
  if (manifest && manifest.sessions.length > 0) {
    entries = manifest.sessions;
  } else {
    // Fallback: no manifest (or empty). Treat every top-level .jsonl under
    // .claude-shared/sessions/ as a flat legacy import.
    entries = await synthesizeEntriesFromDir(sessionsDir);
  }

  if (entries.length === 0) {
    console.log('No shared sessions found in .claude-shared/sessions/');
    console.log('Has someone run `claude-handoff export` and committed the result?');
    return;
  }

  // Apply --session filter (matches by sessionId prefix).
  if (options.session) {
    entries = entries.filter((e) => e.sessionId.startsWith(options.session!));
    if (entries.length === 0) {
      throw new Error(`No session matching "${options.session}" found.`);
    }
  }

  // Dry-run mode
  if (options.dryRun) {
    console.log(`Would import ${entries.length} session(s) into:\n  ${slugDir}\n`);
    for (const e of entries) {
      const sidecars = e.artifacts.filter((a) => a.kind !== 'transcript').length;
      const title = e.title ?? '(untitled)';
      const sidecarNote = sidecars > 0 ? ` + ${sidecars} sidecar(s)` : '';
      console.log(`  ${e.sessionId} — ${title}${sidecarNote}`);
    }
    console.log('\nRun without --dry-run to import.');
    return;
  }

  await mkdir(slugDir, { recursive: true });

  // Conflict policy: skip a session if its main transcript already exists
  // locally, unless --overwrite is set. `--force`-style merge is future work.
  let importedCount = 0;
  let skippedCount = 0;
  let overwrittenCount = 0;

  // Pass the destination store dir into the rewriter so any
  // {{CLAUDE_STORE}} placeholders in the exported JSONL land on Neo's
  // local Claude store path rather than Alice's.
  const rewriteString = (s: string) => portableToLocal(s, projectRoot, localHome, slugDir);

  for (const entry of entries) {
    const sessionId = entry.sessionId;
    const localMainPath = path.join(slugDir, `${sessionId}.jsonl`);

    const mainExists = await pathExists(localMainPath);
    if (mainExists && !options.overwrite) {
      console.log(
        `  Skipping ${sessionId} (already exists locally — rerun with --overwrite to replace)`,
      );
      skippedCount++;
      continue;
    }
    if (mainExists && options.overwrite) {
      overwrittenCount++;
    }

    // Resolve the per-artifact source base on the shared side. v1-migrated
    // entries have `legacyExportedFilename` set and sit flat under
    // sessionsDir; v2 bundles live under sessionsDir/<sessionId>/.
    const isLegacy = Boolean(entry.legacyExportedFilename);
    const sourceBase = isLegacy ? sessionsDir : path.join(sessionsDir, sessionId);

    let importedArtifacts = 0;
    let sidecarCount = 0;
    for (const artifact of entry.artifacts) {
      const src = path.join(sourceBase, artifact.bundlePath);
      if (!(await pathExists(src))) {
        console.warn(
          `  Warning: skipping missing artifact ${artifact.bundlePath} for ${sessionId}`,
        );
        continue;
      }

      const dst = importDestination(slugDir, sessionId, artifact);
      await mkdir(path.dirname(dst), { recursive: true });

      if (src.endsWith('.jsonl')) {
        await transformSession(src, dst, (record) => {
          return deepRewrite(record, rewriteString) as SessionRecord;
        });
      } else if (src.endsWith('.json')) {
        const raw = await readFile(src, 'utf-8');
        const parsed = JSON.parse(raw) as unknown;
        const rewritten = deepRewrite(parsed, rewriteString);
        await writeFile(dst, JSON.stringify(rewritten, null, 2) + '\n', 'utf-8');
      } else {
        const content = await readFile(src, 'utf-8');
        await writeFile(dst, rewriteString(content), 'utf-8');
      }

      importedArtifacts++;
      if (artifact.kind !== 'transcript') sidecarCount++;
    }

    const title = entry.title ?? '(untitled)';
    const sidecarNote = sidecarCount > 0 ? ` + ${sidecarCount} sidecar(s)` : '';
    console.log(
      `  Imported: ${sessionId}.jsonl — ${title} (${importedArtifacts} artifact(s)${sidecarNote})`,
    );
    importedCount++;
  }

  console.log(`\nImported ${importedCount} session(s)`);
  if (overwrittenCount > 0) {
    console.log(`  ${overwrittenCount} local session(s) replaced via --overwrite`);
  }
  if (skippedCount > 0) {
    console.log(
      `Skipped ${skippedCount} (already existed locally — rerun with --overwrite to replace)`,
    );
  }

  // --- Memory import ---
  if (manifest?.memory && manifest.memory.files.length > 0) {
    const memDest = await getMemoryDir(projectRoot);
    await mkdir(memDest, { recursive: true });
    let memImported = 0;
    let memSkipped = 0;
    for (const artifact of manifest.memory.files) {
      const src = path.join(sharedDir, 'memory', artifact.bundlePath);
      if (!(await pathExists(src))) continue;
      const dst = path.join(memDest, artifact.bundlePath);
      const exists = await pathExists(dst);
      if (exists && !options.overwrite) {
        memSkipped++;
        continue;
      }
      await mkdir(path.dirname(dst), { recursive: true });
      const content = await readFile(src, 'utf-8');
      await writeFile(dst, rewriteString(content), 'utf-8');
      memImported++;
    }
    console.log(`Imported ${memImported} memory file(s) into ${memDest}`);
    if (memSkipped > 0) {
      console.log(
        `  ${memSkipped} memory file(s) skipped (existed locally — use --overwrite to replace)`,
      );
    }
    console.log(
      '  (MEMORY.md is LLM-regenerated; it was not bundled. Claude Code will rebuild it on next use.)',
    );
  }

  console.log('Open Claude Code and use /resume to see imported sessions.');
}

/**
 * Map a bundle artifact to its absolute destination under the local
 * Claude store. The main transcript lives at <store>/<sid>.jsonl; every
 * sidecar preserves its original relative path under <store>/<sid>/.
 */
function importDestination(slugDir: string, sessionId: string, artifact: BundleArtifact): string {
  if (artifact.kind === 'transcript') {
    return path.join(slugDir, `${sessionId}.jsonl`);
  }
  // bundlePath for v2 sidecars == originalRelativePath (e.g. "subagents/foo.jsonl").
  // For v1-migrated transcripts we'd never reach this branch.
  return path.join(slugDir, sessionId, artifact.bundlePath);
}

/**
 * No manifest was found — synthesize minimal entries from whatever
 * top-level `.jsonl` files sit under .claude-shared/sessions/. Treats
 * each as a legacy flat transcript with no sidecars.
 */
async function synthesizeEntriesFromDir(sessionsDir: string): Promise<ManifestEntry[]> {
  const files = await listSessionFiles(sessionsDir);
  const entries: ManifestEntry[] = [];
  for (const file of files) {
    let sessionId: string;
    let title: string | undefined;
    try {
      const meta = await extractSessionMeta(file);
      sessionId = meta.sessionId;
      title = meta.customTitle ?? meta.lastPrompt;
    } catch {
      // File without a sessionId — skip it rather than corrupt the store.
      continue;
    }
    entries.push({
      sessionId,
      author: 'unknown',
      exportedAt: 'unknown',
      title,
      totalRedactionHits: 0,
      totalMalformed: 0,
      totalRecovered: 0,
      totalSkipped: 0,
      legacyExportedFilename: path.basename(file),
      artifacts: [
        {
          kind: 'transcript',
          bundlePath: path.basename(file),
          originalRelativePath: '',
        },
      ],
    });
  }
  return entries;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
