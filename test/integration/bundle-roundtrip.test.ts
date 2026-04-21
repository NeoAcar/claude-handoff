/**
 * End-to-end bundle round-trip: Alice exports a session that has a
 * subagent + subagent-meta + session-memory, the bundle lands on disk,
 * Neo imports it into a different project root, and the reconstructed
 * local store matches the expected layout with Neo's paths.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { exportCommand } from '../../src/commands/export.js';
import { importCommand } from '../../src/commands/import.js';
import { readManifest } from '../../src/core/manifest.js';
import { sanitizeProjectKey } from '../../src/core/store.js';

const SESSION_ID = 'bundle-1111-2222-3333-444444444444';
const FIXTURE_DIR = join(import.meta.dirname, '..', 'fixtures', 'bundled');

let scratch: string;
let originalHome: string | undefined;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'claude-handoff-bundle-rt-'));
  originalHome = process.env.HOME;
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await rm(scratch, { recursive: true, force: true });
});

/**
 * Seed ~/.claude/projects/<key>/ on the "Alice" side with our fixture
 * session: one main transcript, one subagent, its meta sidecar, and a
 * session-memory markdown. Returns the absolute project-root path on
 * this fake HOME; `cwd` fields in the fixture reference this path.
 */
async function seedAlice(): Promise<{ home: string; project: string }> {
  const home = join(scratch, 'alice-home');
  const project = join(scratch, 'alice-home', 'projects', 'fake-project');
  await mkdir(project, { recursive: true });

  // Rewrite fixture cwds to point at this hermetic project path. We do
  // that by reading each fixture file and string-replacing the
  // `/fake/user/fake-project` prefix with the real project path.
  const FIXTURE_PROJECT_PREFIX = '/fake/user/fake-project';
  const rewrite = (s: string) => s.split(FIXTURE_PROJECT_PREFIX).join(project);

  const storeKey = sanitizeProjectKey(project);
  const storeDir = join(home, '.claude', 'projects', storeKey);
  const sidecarDir = join(storeDir, SESSION_ID);
  await mkdir(sidecarDir, { recursive: true });

  const mainRaw = await readFile(join(FIXTURE_DIR, 'main.jsonl'), 'utf-8');
  await writeFileAt(join(storeDir, `${SESSION_ID}.jsonl`), rewrite(mainRaw));

  const subRaw = await readFile(
    join(FIXTURE_DIR, 'sidecars', 'subagents', 'agent-explore-abc.jsonl'),
    'utf-8',
  );
  await mkdir(join(sidecarDir, 'subagents'), { recursive: true });
  await writeFileAt(join(sidecarDir, 'subagents', 'agent-explore-abc.jsonl'), rewrite(subRaw));

  const metaRaw = await readFile(
    join(FIXTURE_DIR, 'sidecars', 'subagents', 'agent-explore-abc.meta.json'),
    'utf-8',
  );
  await writeFileAt(join(sidecarDir, 'subagents', 'agent-explore-abc.meta.json'), rewrite(metaRaw));

  const memRaw = await readFile(
    join(FIXTURE_DIR, 'sidecars', 'session-memory', 'summary.md'),
    'utf-8',
  );
  await mkdir(join(sidecarDir, 'session-memory'), { recursive: true });
  await writeFileAt(join(sidecarDir, 'session-memory', 'summary.md'), rewrite(memRaw));

  return { home, project };
}

async function writeFileAt(p: string, content: string): Promise<void> {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(p, content, 'utf-8');
}

describe('bundle round-trip', () => {
  it('exports a session-with-sidecars as a bundle and imports it into a different machine', async () => {
    // --- Alice side: seed + export ---
    const alice = await seedAlice();
    process.env.HOME = alice.home;

    await exportCommand(alice.project, {
      dryRun: false,
      noRedact: true,
      iKnowWhatImDoing: true,
      stripProgress: false,
    });

    // Sanity-check the bundle that was written.
    const bundleDir = join(alice.project, '.claude-shared', 'sessions', SESSION_ID);
    const mainBundle = await readFile(join(bundleDir, 'main.jsonl'), 'utf-8');
    expect(mainBundle).toContain('{{PROJECT_ROOT}}/README.md');
    expect(mainBundle).not.toContain(alice.project);

    const subBundle = await readFile(
      join(bundleDir, 'subagents', 'agent-explore-abc.jsonl'),
      'utf-8',
    );
    expect(subBundle).toContain('{{PROJECT_ROOT}}/README.md');
    expect(subBundle).not.toContain(alice.project);

    const metaBundle = await readFile(
      join(bundleDir, 'subagents', 'agent-explore-abc.meta.json'),
      'utf-8',
    );
    expect(metaBundle).toContain('{{PROJECT_ROOT}}');
    expect(metaBundle).not.toContain(alice.project);

    const memBundle = await readFile(join(bundleDir, 'session-memory', 'summary.md'), 'utf-8');
    expect(memBundle).toContain('{{PROJECT_ROOT}}');
    expect(memBundle).not.toContain(alice.project);

    // The metadata sidecar should be present too.
    const metadata = JSON.parse(await readFile(join(bundleDir, 'metadata.json'), 'utf-8')) as {
      sessionId: string;
      title?: string;
    };
    expect(metadata.sessionId).toBe(SESSION_ID);

    // --- Move .claude-shared/ to a fresh "Neo" side ---
    const neoHome = join(scratch, 'neo-home');
    const neoProject = join(neoHome, 'projects', 'fake-project');
    await mkdir(neoProject, { recursive: true });
    await cp(join(alice.project, '.claude-shared'), join(neoProject, '.claude-shared'), {
      recursive: true,
    });

    process.env.HOME = neoHome;

    // --- Neo side: import ---
    await importCommand(neoProject, {
      dryRun: false,
      all: true,
      overwrite: false,
    });

    const neoStore = join(neoHome, '.claude', 'projects', sanitizeProjectKey(neoProject));

    // Main transcript lives flat at <store>/<sid>.jsonl with Neo's paths.
    const neoMain = await readFile(join(neoStore, `${SESSION_ID}.jsonl`), 'utf-8');
    expect(neoMain).toContain(`${neoProject}/README.md`);
    expect(neoMain).not.toContain('{{PROJECT_ROOT}}');

    // Subagent transcript lives under <store>/<sid>/subagents/.
    const neoSub = await readFile(
      join(neoStore, SESSION_ID, 'subagents', 'agent-explore-abc.jsonl'),
      'utf-8',
    );
    expect(neoSub).toContain(`${neoProject}/README.md`);
    expect(neoSub).not.toContain('{{PROJECT_ROOT}}');

    // Subagent meta sidecar preserved and path-rewritten.
    const neoMeta = JSON.parse(
      await readFile(
        join(neoStore, SESSION_ID, 'subagents', 'agent-explore-abc.meta.json'),
        'utf-8',
      ),
    ) as { cwd: string; summary: string };
    expect(neoMeta.cwd).toBe(neoProject);
    expect(neoMeta.summary).toContain(neoProject);

    // Session-memory summary preserved and path-rewritten.
    const neoMem = await readFile(
      join(neoStore, SESSION_ID, 'session-memory', 'summary.md'),
      'utf-8',
    );
    expect(neoMem).toContain(neoProject);
    expect(neoMem).not.toContain('{{PROJECT_ROOT}}');
  });

  it('reports artifacts in the manifest after a bundle export', async () => {
    const alice = await seedAlice();
    process.env.HOME = alice.home;

    await exportCommand(alice.project, {
      dryRun: false,
      noRedact: true,
      iKnowWhatImDoing: true,
      stripProgress: false,
    });

    const manifest = await readManifest(join(alice.project, '.claude-shared'));
    expect(manifest).not.toBeNull();
    expect(manifest!.schemaVersion).toBe(2);
    expect(manifest!.sessions).toHaveLength(1);

    const entry = manifest!.sessions[0];
    expect(entry.sessionId).toBe(SESSION_ID);
    // Expect: main transcript + 2 subagent files (jsonl + meta.json) + 1 memory file.
    const kinds = entry.artifacts.map((a) => a.kind).sort();
    expect(kinds).toEqual(['session-memory', 'subagent', 'subagent-meta', 'transcript']);

    const transcriptArtifact = entry.artifacts.find((a) => a.kind === 'transcript');
    expect(transcriptArtifact?.bundlePath).toBe('main.jsonl');
    expect(transcriptArtifact?.recordCount).toBeGreaterThan(0);
  });
});
