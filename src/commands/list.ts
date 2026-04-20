/**
 * claude-handoff list — list sessions in .claude-shared/.
 */

import path from 'node:path';
import { listSessionFiles, extractSessionMeta } from '../core/session.js';

export async function listCommand(projectRoot: string): Promise<void> {
  const sessionsDir = path.join(projectRoot, '.claude-shared', 'sessions');

  const files = await listSessionFiles(sessionsDir);
  if (files.length === 0) {
    console.log('No shared sessions found in .claude-shared/sessions/');
    return;
  }

  console.log(`Shared sessions (${files.length}):\n`);
  for (const f of files) {
    const meta = await extractSessionMeta(f);
    const title = meta.customTitle ?? meta.lastPrompt ?? '(untitled)';
    const ts = meta.firstTimestamp ? meta.firstTimestamp.slice(0, 10) : '?';
    console.log(`  ${ts}  ${path.basename(f)}`);
    console.log(`         ${title} (${meta.recordCount} records)`);
    console.log();
  }
}
