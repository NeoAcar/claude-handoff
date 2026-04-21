/**
 * Iterative handoff: the same session ID ping-ponging between Alice
 * and Neo. The first export-import is the simple case Phase 3
 * already covered; this test locks in the behaviors that make round
 * 2+ work:
 *
 *   - Export refuses to re-export when nothing changed (zero churn,
 *     no spurious commits).
 *   - Export archives prior rounds into `previousExports` so the
 *     manifest shows a visible history instead of overwriting author
 *     identity.
 *   - Import auto-catches-up when the bundle is ahead of local
 *     (no --overwrite needed).
 *   - Fork suspicion (local has fewer records than the shared
 *     bundle) is refused without `--force`.
 *
 * All session files live under fake HOMEs in an os.tmpdir scratch
 * so the real ~/.claude/ is never touched.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  appendFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { exportCommand } from '../../src/commands/export.js';
import { importCommand } from '../../src/commands/import.js';
import { readManifest } from '../../src/core/manifest.js';
import { sanitizeProjectKey } from '../../src/core/store.js';

const SESSION_ID = 'iter-aaaa-bbbb-cccc-ddddeeeeffff';

let scratch: string;
let originalHome: string | undefined;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'claude-handoff-iter-'));
  originalHome = process.env.HOME;
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await rm(scratch, { recursive: true, force: true });
});

async function makeProject(
  label: string,
): Promise<{ home: string; project: string; storeDir: string }> {
  const home = join(scratch, `${label}-home`);
  const project = join(home, 'proj');
  await mkdir(project, { recursive: true });
  const storeDir = join(home, '.claude', 'projects', sanitizeProjectKey(project));
  await mkdir(storeDir, { recursive: true });
  return { home, project, storeDir };
}

/** Write a session transcript with N simple records. */
async function seedSession(
  storeDir: string,
  project: string,
  recordCount: number,
): Promise<string> {
  const lines: string[] = [];
  for (let i = 0; i < recordCount; i++) {
    lines.push(
      JSON.stringify({
        type: 'user',
        sessionId: SESSION_ID,
        cwd: project,
        message: { role: 'user', content: `turn ${i}` },
      }),
    );
  }
  const path = join(storeDir, `${SESSION_ID}.jsonl`);
  await writeFile(path, lines.join('\n') + '\n', 'utf-8');
  return path;
}

/** Simulate `claude --resume` appending N more records to a session file. */
async function appendTurns(
  sessionPath: string,
  newRecordCount: number,
  project: string,
): Promise<void> {
  const lines: string[] = [];
  for (let i = 0; i < newRecordCount; i++) {
    lines.push(
      JSON.stringify({
        type: 'user',
        sessionId: SESSION_ID,
        cwd: project,
        message: { role: 'user', content: `appended ${i}` },
      }),
    );
  }
  await appendFile(sessionPath, lines.join('\n') + '\n', 'utf-8');
  // Ensure mtime actually advances past any cached prior value.
  await utimes(sessionPath, new Date(), new Date(Date.now() + 5));
}

describe('iterative handoff', () => {
  it('supports Alice → Neo → Alice on one session ID', async () => {
    // Round 1 — Alice exports a fresh session.
    const alice = await makeProject('alice');
    const aliceSessionPath = await seedSession(alice.storeDir, alice.project, 3);
    process.env.HOME = alice.home;
    await exportCommand(alice.project, {
      dryRun: false,
      noRedact: true,
      iKnowWhatImDoing: true,
    });

    // Round 2 — Neo pulls + imports, resumes, appends turns, re-exports.
    const neo = await makeProject('neo');
    await cp(join(alice.project, '.claude-shared'), join(neo.project, '.claude-shared'), {
      recursive: true,
    });
    process.env.HOME = neo.home;
    await importCommand(neo.project, {
      dryRun: false,
      all: true,
      overwrite: false,
    });
    const neoSessionPath = join(neo.storeDir, `${SESSION_ID}.jsonl`);
    await appendTurns(neoSessionPath, 4, neo.project); // 3 → 7 records

    await exportCommand(neo.project, {
      dryRun: false,
      noRedact: true,
      iKnowWhatImDoing: true,
    });

    const neoManifest = await readManifest(join(neo.project, '.claude-shared'));
    expect(neoManifest?.sessions).toHaveLength(1);
    const neoEntry = neoManifest!.sessions[0];
    expect(neoEntry.author).toBe('neo');
    expect(neoEntry.sourceRecordCount).toBe(7);
    expect(neoEntry.previousExports).toHaveLength(1);
    expect(neoEntry.previousExports?.[0].author).toBe(process.env.USER ?? 'alice');

    // Round 3 — Alice pulls Neo's update; import should auto-catch-up.
    await cp(join(neo.project, '.claude-shared'), join(alice.project, '.claude-shared'), {
      recursive: true,
      force: true,
    });
    process.env.HOME = alice.home;
    await importCommand(alice.project, {
      dryRun: false,
      all: true,
      overwrite: false, // crucial — we should NOT need --overwrite
    });
    const aliceAfterImport = await readFile(aliceSessionPath, 'utf-8');
    expect(aliceAfterImport.split('\n').filter((l) => l.trim().length > 0)).toHaveLength(7);

    // Round 4 — Alice resumes, appends, re-exports.
    await appendTurns(aliceSessionPath, 2, alice.project); // 7 → 9 records
    await exportCommand(alice.project, {
      dryRun: false,
      noRedact: true,
      iKnowWhatImDoing: true,
    });

    const aliceManifest = await readManifest(join(alice.project, '.claude-shared'));
    const aliceEntry = aliceManifest!.sessions[0];
    expect(aliceEntry.sourceRecordCount).toBe(9);
    // Two prior rounds preserved: Alice's original + Neo's.
    expect(aliceEntry.previousExports).toHaveLength(2);
  });

  it("skips re-export when the local session hasn't changed since last export", async () => {
    const alice = await makeProject('alice-skip');
    await seedSession(alice.storeDir, alice.project, 5);
    process.env.HOME = alice.home;
    await exportCommand(alice.project, {
      dryRun: false,
      noRedact: true,
      iKnowWhatImDoing: true,
    });

    const bundleMtime1 = (
      await stat(join(alice.project, '.claude-shared', 'sessions', SESSION_ID, 'main.jsonl'))
    ).mtimeMs;
    const firstManifest = await readManifest(join(alice.project, '.claude-shared'));
    const firstExportedAt = firstManifest!.sessions[0].exportedAt;

    // Nothing changed locally. Re-running export should leave both the
    // bundle file and the manifest entry untouched (no new round, no
    // previousExports growth).
    await new Promise((r) => setTimeout(r, 10));
    await exportCommand(alice.project, {
      dryRun: false,
      noRedact: true,
      iKnowWhatImDoing: true,
    });
    const bundleMtime2 = (
      await stat(join(alice.project, '.claude-shared', 'sessions', SESSION_ID, 'main.jsonl'))
    ).mtimeMs;
    const secondManifest = await readManifest(join(alice.project, '.claude-shared'));
    const entry = secondManifest!.sessions[0];
    expect(entry.exportedAt).toBe(firstExportedAt);
    expect(entry.previousExports ?? []).toHaveLength(0);
    expect(bundleMtime2).toBe(bundleMtime1);
  });

  it('refuses to re-export when local has fewer records than the shared bundle (fork suspicion)', async () => {
    // Alice exports a 7-record session. Then we simulate "teammate's
    // bundle" by replacing Alice's shared folder with one recording
    // a higher source count, and Alice's local shrinks (or stays
    // small) — mimicking the case where she pulled teammate work but
    // didn't import.
    const alice = await makeProject('alice-fork');
    const aliceSessionPath = await seedSession(alice.storeDir, alice.project, 4);
    process.env.HOME = alice.home;
    await exportCommand(alice.project, {
      dryRun: false,
      noRedact: true,
      iKnowWhatImDoing: true,
    });

    // Forge a manifest entry that claims a larger sourceRecordCount
    // than the local file, which is what would happen after pulling
    // a teammate's newer bundle without running import.
    const manifestPath = join(alice.project, '.claude-shared', '.manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf-8'));
    manifest.sessions[0].sourceRecordCount = 99; // pretend teammate added many
    manifest.sessions[0].sourceMtimeMs = Date.now() + 100000;
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

    // Alice runs export. Should refuse (local 4 < manifest 99).
    const logs: string[] = [];
    const origWarn = console.warn;
    console.warn = (...a) => {
      logs.push(a.join(' '));
    };
    try {
      await exportCommand(alice.project, {
        dryRun: false,
        noRedact: true,
        iKnowWhatImDoing: true,
      });
    } finally {
      console.warn = origWarn;
    }
    const forkWarning = logs.find((l) => l.includes('Refusing to export'));
    expect(forkWarning).toBeDefined();

    const afterRefuse = JSON.parse(await readFile(manifestPath, 'utf-8'));
    // Manifest's teammate-counts should still be there (we didn't overwrite).
    expect(afterRefuse.sessions[0].sourceRecordCount).toBe(99);

    // With --force, export goes through and replaces the entry.
    await exportCommand(alice.project, {
      dryRun: false,
      noRedact: true,
      iKnowWhatImDoing: true,
      force: true,
    });
    const afterForce = JSON.parse(await readFile(manifestPath, 'utf-8'));
    expect(afterForce.sessions[0].sourceRecordCount).toBe(4);
    expect(afterForce.sessions[0].previousExports).toHaveLength(1);

    // use aliceSessionPath to make sure the session actually still exists
    expect(await pathExists(aliceSessionPath)).toBe(true);
  });
});

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
