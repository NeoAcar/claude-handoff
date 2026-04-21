/**
 * claude-handoff list — list sessions in .claude-shared/.
 */

import path from 'node:path';
import { stat } from 'node:fs/promises';
import { listSessionFiles, extractSessionMeta } from '../core/session.js';
import { readManifest } from '../core/manifest.js';

export interface ListOptions {
  verbose: boolean;
}

export async function listCommand(projectRoot: string, options: ListOptions): Promise<void> {
  const sharedDir = path.join(projectRoot, '.claude-shared');
  const sessionsDir = path.join(sharedDir, 'sessions');

  const files = await listSessionFiles(sessionsDir);
  if (files.length === 0) {
    console.log('No shared sessions found in .claude-shared/sessions/');
    return;
  }

  const manifest = await readManifest(sharedDir);
  const manifestBySessionId = new Map(manifest?.sessions.map((s) => [s.sessionId, s]) ?? []);

  console.log(`Shared sessions (${files.length}):\n`);
  for (const f of files) {
    const [meta, fileStat] = await Promise.all([extractSessionMeta(f), stat(f)]);
    const title = meta.customTitle ?? meta.lastPrompt ?? '(untitled)';
    const ts = meta.firstTimestamp ? meta.firstTimestamp.slice(0, 10) : '?';
    const size = humanSize(fileStat.size);
    console.log(`  ${ts}  ${path.basename(f)}`);
    console.log(`         ${title} (${meta.recordCount} records, ${size})`);
    if (options.verbose) {
      const entry = manifestBySessionId.get(meta.sessionId);
      if (entry) {
        console.log(`         author: ${entry.author}`);
        console.log(`         exported: ${entry.exportedAt}`);
        if (entry.totalRedactionHits > 0) {
          console.log(`         redaction markers: ${entry.totalRedactionHits}`);
        }
        if (entry.artifacts.length > 1) {
          const sidecarKinds = entry.artifacts.filter((a) => a.kind !== 'transcript');
          console.log(
            `         sidecars: ${sidecarKinds.length} (${sidecarKinds.map((a) => a.kind).join(', ')})`,
          );
        }
      }
      if (meta.firstTimestamp && meta.lastTimestamp) {
        console.log(`         timespan: ${meta.firstTimestamp} → ${meta.lastTimestamp}`);
      }
    }
    console.log();
  }
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
