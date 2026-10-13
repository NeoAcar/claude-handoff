/**
 * Alice → one file → Neo, with no shared repo involved.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { exportArchiveCommand, importArchiveCommand } from '../../src/commands/archive.js';
import { sanitizeProjectKey } from '../../src/core/store.js';

const SESSION_ID = 'archive-1111-2222-3333-444444444444';

let scratch: string;
let originalHome: string | undefined;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'claude-handoff-archive-rt-'));
  originalHome = process.env.HOME;
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await rm(scratch, { recursive: true, force: true });
});

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

async function seedAlice(): Promise<{ home: string; project: string }> {
  const home = join(scratch, 'alice-home');
  const project = join(home, 'code', 'app');
  const store = join(home, '.claude', 'projects', sanitizeProjectKey(project));
  await mkdir(join(store, SESSION_ID, 'tool-results'), { recursive: true });
  await mkdir(project, { recursive: true });
  const records = [
    {
      type: 'user',
      sessionId: SESSION_ID,
      cwd: project,
      uuid: 'u1',
      parentUuid: null,
      timestamp: '2026-10-10T09:00:00.000Z',
      message: {
        role: 'user',
        content: `open ${project}/src/main.ts and use AKIAIOSFODNN7EXAMPLE`,
      },
    },
    { type: 'ai-title', aiTitle: 'Archive handoff', sessionId: SESSION_ID },
  ];
  await writeFile(
    join(store, `${SESSION_ID}.jsonl`),
    records.map((r) => JSON.stringify(r)).join('\n') + '\n',
  );
  await writeFile(join(store, SESSION_ID, 'tool-results', 'out.txt'), `listing of ${project}\n`);
  return { home, project };
}

const exportOptions = { dryRun: false, noRedact: false, iKnowWhatImDoing: false };
const importOptions = { dryRun: false, all: true, overwrite: false };

describe('archive round-trip', () => {
  it('carries a redacted session in one file and resumes it under different paths', async () => {
    const alice = await seedAlice();
    process.env.HOME = alice.home;
    const archive = join(scratch, 'handoff.tgz');

    await exportArchiveCommand(alice.project, archive, exportOptions);

    expect(await exists(archive)).toBe(true);
    // The sender's paths appear nowhere in what gets sent, metadata included.
    const sent = execFileSync('tar', ['xzOf', archive], { encoding: 'utf-8' });
    expect(sent).not.toContain(alice.home);
    // Nothing was left in Alice's project: no .claude-shared/, and no staging.
    expect(await exists(join(alice.project, '.claude-shared'))).toBe(false);

    const neoHome = join(scratch, 'neo-home');
    const neoProject = join(neoHome, 'dev', 'app');
    await mkdir(neoProject, { recursive: true });
    process.env.HOME = neoHome;

    await importArchiveCommand(neoProject, archive, importOptions);

    const neoStore = join(neoHome, '.claude', 'projects', sanitizeProjectKey(neoProject));
    const main = await readFile(join(neoStore, `${SESSION_ID}.jsonl`), 'utf-8');
    expect(main).toContain(`open ${neoProject}/src/main.ts`);
    expect(main).toContain('[REDACTED:aws-key]');
    expect(main).not.toContain(alice.project);
    expect(await readFile(join(neoStore, SESSION_ID, 'tool-results', 'out.txt'), 'utf-8')).toBe(
      `listing of ${neoProject}\n`,
    );
    expect(await exists(join(neoProject, '.claude-shared'))).toBe(false);
  });

  it('refuses to overwrite an existing archive', async () => {
    const alice = await seedAlice();
    process.env.HOME = alice.home;
    const archive = join(scratch, 'handoff.tgz');
    await writeFile(archive, 'precious');
    await expect(exportArchiveCommand(alice.project, archive, exportOptions)).rejects.toThrow(
      /already exists/,
    );
    expect(await readFile(archive, 'utf-8')).toBe('precious');
  });

  it('writes nothing on a dry run', async () => {
    const alice = await seedAlice();
    process.env.HOME = alice.home;
    const archive = join(scratch, 'handoff.tgz');
    await exportArchiveCommand(alice.project, archive, { ...exportOptions, dryRun: true });
    expect(await exists(archive)).toBe(false);
  });

  it('writes no archive when no session matches', async () => {
    const alice = await seedAlice();
    process.env.HOME = alice.home;
    const archive = join(scratch, 'handoff.tgz');
    await expect(
      exportArchiveCommand(alice.project, archive, { ...exportOptions, session: 'no-such-title' }),
    ).rejects.toThrow(/No session matching/);
    expect(await exists(archive)).toBe(false);
  });

  it('imports nothing from a damaged archive', async () => {
    const alice = await seedAlice();
    process.env.HOME = alice.home;
    const archive = join(scratch, 'handoff.tgz');
    await exportArchiveCommand(alice.project, archive, exportOptions);
    const bytes = await readFile(archive);
    await writeFile(archive, bytes.subarray(0, bytes.length - 40));

    const neoHome = join(scratch, 'neo-home');
    const neoProject = join(neoHome, 'dev', 'app');
    await mkdir(neoProject, { recursive: true });
    process.env.HOME = neoHome;

    await expect(importArchiveCommand(neoProject, archive, importOptions)).rejects.toThrow(
      /not a usable claude-handoff archive/,
    );
    expect(await exists(join(neoHome, '.claude'))).toBe(false);
  });
});
