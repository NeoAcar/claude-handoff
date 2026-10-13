/**
 * Alice → one file → Neo, with no shared repo involved.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { access, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  archiveStem,
  exportArchiveCommand,
  importArchiveCommand,
} from '../../src/commands/archive.js';
import { exportCommand } from '../../src/commands/export.js';
import { importCommand } from '../../src/commands/import.js';
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
    expect((await stat(archive)).mode & 0o077).toBe(0); // owner-only
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

describe('archive naming', () => {
  it('names the file after the session when no name is given', async () => {
    const alice = await seedAlice();
    process.env.HOME = alice.home;
    await exportArchiveCommand(alice.project, undefined, exportOptions);
    expect(await exists(join(alice.project, 'archive-handoff.handoff'))).toBe(true);

    // A second run picks a free name instead of overwriting.
    await exportArchiveCommand(alice.project, undefined, exportOptions);
    expect(await exists(join(alice.project, 'archive-handoff-2.handoff'))).toBe(true);
  });

  it('adds the default extension to a bare name, on export and on import', async () => {
    const alice = await seedAlice();
    process.env.HOME = alice.home;
    await exportArchiveCommand(alice.project, join(scratch, 'for-neo'), exportOptions);
    expect(await exists(join(scratch, 'for-neo.handoff'))).toBe(true);

    const neoHome = join(scratch, 'neo-home');
    const neoProject = join(neoHome, 'dev', 'app');
    await mkdir(neoProject, { recursive: true });
    process.env.HOME = neoHome;
    await importArchiveCommand(neoProject, join(scratch, 'for-neo'), importOptions);
    const neoStore = join(neoHome, '.claude', 'projects', sanitizeProjectKey(neoProject));
    expect(await exists(join(neoStore, `${SESSION_ID}.jsonl`))).toBe(true);
  });

  it('builds file names from titles without leaking markers or odd characters', () => {
    expect(archiveStem('Fix login bug')).toBe('fix-login-bug');
    expect(archiveStem('Use [REDACTED:github-token] for CI/CD — şifre!')).toBe(
      'use-for-ci-cd-sifre',
    );
    expect(archiveStem('   ')).toBe('session');
    expect(archiveStem(undefined)).toBe('session');
    expect(archiveStem('x'.repeat(100)).length).toBe(40);
  });
});

describe('untrusted manifests', () => {
  async function importWithManifest(
    mutate: (manifest: { sessions: Array<Record<string, unknown>> }) => void,
  ): Promise<{ run: Promise<void>; neoHome: string }> {
    const alice = await seedAlice();
    process.env.HOME = alice.home;
    await exportCommand(alice.project, exportOptions);

    const neoHome = join(scratch, 'neo-home');
    const neoProject = join(neoHome, 'dev', 'app');
    await mkdir(neoProject, { recursive: true });
    await cp(join(alice.project, '.claude-shared'), join(neoProject, '.claude-shared'), {
      recursive: true,
    });
    const manifestPath = join(neoProject, '.claude-shared', '.manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf-8'));
    mutate(manifest);
    await writeFile(manifestPath, JSON.stringify(manifest));

    process.env.HOME = neoHome;
    return { run: importCommand(neoProject, importOptions), neoHome };
  }

  it('refuses a session ID that would climb out of the store', async () => {
    const { run, neoHome } = await importWithManifest((m) => {
      m.sessions[0].sessionId = '../../../escaped';
    });
    await expect(run).rejects.toThrow(/not a valid session ID/);
    expect(await exists(join(neoHome, '.claude'))).toBe(false);
  });

  it('refuses an artifact path that would climb out of the bundle', async () => {
    const { run, neoHome } = await importWithManifest((m) => {
      (m.sessions[0].artifacts as Array<{ bundlePath: string }>)[0].bundlePath = '../../x.jsonl';
    });
    await expect(run).rejects.toThrow(/unsafe path/);
    expect(await exists(join(neoHome, '.claude'))).toBe(false);
  });
});
