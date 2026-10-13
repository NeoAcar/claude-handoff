import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runDoctor } from '../../src/commands/doctor.js';
import type { DoctorCheck } from '../../src/commands/doctor.js';
import { exportCommand } from '../../src/commands/export.js';
import { readManifest, writeManifest } from '../../src/core/manifest.js';
import { sanitizeProjectKey } from '../../src/core/store.js';
import { LAST_VERIFIED_CLAUDE_CODE } from '../../src/core/version.js';

const SESSION_ID = 'doctor-1111-2222-3333-444444444444';
const RUNTIME = { nodeVersion: '22.1.0', platform: 'linux' };

let scratch: string;
let home: string;
let project: string;
let originalHome: string | undefined;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'claude-handoff-doctor-'));
  home = join(scratch, 'home');
  project = join(home, 'work', 'proj');
  await mkdir(project, { recursive: true });
  originalHome = process.env.HOME;
  process.env.HOME = home;
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await rm(scratch, { recursive: true, force: true });
});

async function seedSession(claudeCodeVersion: string): Promise<void> {
  const store = join(home, '.claude', 'projects', sanitizeProjectKey(project));
  await mkdir(store, { recursive: true });
  const records = [
    {
      type: 'user',
      sessionId: SESSION_ID,
      cwd: project,
      version: claudeCodeVersion,
      uuid: 'u1',
      parentUuid: null,
      timestamp: '2026-10-01T00:00:00Z',
      message: { role: 'user', content: 'hello' },
    },
    {
      type: 'attachment',
      sessionId: SESSION_ID,
      cwd: project,
      version: claudeCodeVersion,
      uuid: 'u2',
      parentUuid: 'u1',
      timestamp: '2026-10-01T00:00:01Z',
      attachment: { type: 'credential_org', organizationUuid: 'aaaa-bbbb' },
    },
  ];
  await writeFile(
    join(store, `${SESSION_ID}.jsonl`),
    records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf-8',
  );
}

const find = (checks: DoctorCheck[], label: string) => checks.find((c) => c.label === label);

describe('doctor', () => {
  it('flags a project with no sessions and no .gitignore entry', async () => {
    const checks = await runDoctor(project, RUNTIME);
    expect(find(checks, 'Local sessions')?.status).toBe('warn');
    expect(find(checks, '.gitignore')?.status).toBe('warn');
    expect(find(checks, 'Shared bundles')?.status).toBe('info');
    expect(find(checks, 'Claude Code')).toBeUndefined();
  });

  it('accepts sessions written by the verified Claude Code version', async () => {
    await seedSession(LAST_VERIFIED_CLAUDE_CODE);
    await writeFile(join(project, '.gitignore'), '.claude-handoff/\n', 'utf-8');
    const checks = await runDoctor(project, RUNTIME);
    expect(find(checks, 'Local sessions')).toMatchObject({ status: 'ok' });
    expect(find(checks, 'Claude Code')).toMatchObject({ status: 'ok' });
    expect(find(checks, '.gitignore')).toMatchObject({ status: 'ok' });
    expect(find(checks, 'Account identity')).toMatchObject({ status: 'ok' });
  });

  it('warns when the sessions come from a newer Claude Code', async () => {
    await seedSession('99.0.0');
    const claudeCode = find(await runDoctor(project, RUNTIME), 'Claude Code');
    expect(claudeCode?.status).toBe('warn');
    expect(claudeCode?.detail).toContain('99.0.0');
  });

  it('warns on old Node and on Windows', async () => {
    const checks = await runDoctor(project, { nodeVersion: '18.19.0', platform: 'win32' });
    expect(find(checks, 'Node.js')?.status).toBe('warn');
    expect(find(checks, 'Platform')?.status).toBe('warn');
  });

  it('reports bundles written by an older version, and env values it would scrub', async () => {
    await seedSession(LAST_VERIFIED_CLAUDE_CODE);
    await writeFile(join(project, '.env'), 'SERVICE_TOKEN=kiwi-Lantern-48-marble\n', 'utf-8');
    await exportCommand(project, { dryRun: false, noRedact: false, iKnowWhatImDoing: false });

    let checks = await runDoctor(project, RUNTIME);
    expect(find(checks, 'Shared bundles')).toMatchObject({ status: 'ok' });
    expect(find(checks, 'Known secret values')?.detail).toContain('.env');

    const sharedDir = join(project, '.claude-shared');
    const manifest = (await readManifest(sharedDir))!;
    delete manifest.sessions[0].exportedWith;
    await writeManifest(sharedDir, manifest);

    checks = await runDoctor(project, RUNTIME);
    expect(find(checks, 'Shared bundles')?.status).toBe('warn');
  });
});
