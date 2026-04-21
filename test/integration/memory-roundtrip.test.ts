/**
 * Memory round-trip: Alice exports with --memory, Neo imports, the
 * memory files land under Neo's canonical-git-root-keyed memory dir
 * with paths rewritten so in-file references translate across
 * machines. MEMORY.md is intentionally never bundled — it's LLM-
 * regenerated from the siblings, and shipping a stale one would stamp
 * over the receiver's.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile, cp, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { exportCommand } from '../../src/commands/export.js';
import { importCommand } from '../../src/commands/import.js';
import { readManifest } from '../../src/core/manifest.js';
import { findCanonicalGitRoot, sanitizeProjectKey } from '../../src/core/store.js';

const execFileAsync = promisify(execFile);

let scratch: string;
let originalHome: string | undefined;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'claude-handoff-mem-rt-'));
  originalHome = process.env.HOME;
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await rm(scratch, { recursive: true, force: true });
});

async function seedAlice(): Promise<{ home: string; project: string; gitRoot: string }> {
  const home = join(scratch, 'alice-home');
  const project = join(home, 'projects', 'myapp');
  await mkdir(project, { recursive: true });
  // Make it a real git repo so findCanonicalGitRoot returns something
  // deterministic rather than falling back to the cwd.
  await execFileAsync('git', ['init', '--quiet'], { cwd: project });
  await writeFile(join(project, 'README.md'), '# myapp\n');
  await execFileAsync('git', ['add', '.'], { cwd: project });
  await execFileAsync(
    'git',
    ['-c', 'user.email=a@a', '-c', 'user.name=a', 'commit', '--quiet', '-m', 'init'],
    { cwd: project },
  );

  // Claude store dir keyed by canonical git root (which == project here).
  const gitRoot = project;
  const storeKey = sanitizeProjectKey(gitRoot);
  const storeDir = join(home, '.claude', 'projects', storeKey);
  await mkdir(storeDir, { recursive: true });

  // Seed one session so export has something to do.
  const SESSION_ID = 'mem-rt-1111-2222-3333-444444444444';
  await writeFile(
    join(storeDir, `${SESSION_ID}.jsonl`),
    JSON.stringify({
      type: 'user',
      sessionId: SESSION_ID,
      cwd: project,
      message: { role: 'user', content: 'hi' },
    }) + '\n',
    'utf-8',
  );

  // Seed memory tree: one topic file referencing the store path, one
  // nested log file, plus a MEMORY.md we expect NOT to be exported.
  const memDir = join(storeDir, 'memory');
  await mkdir(join(memDir, 'logs', '2026'), { recursive: true });
  await writeFile(
    join(memDir, 'project_conventions.md'),
    `# Conventions\n\nSee ${storeDir}/memory/logs/2026/details.md for more.\n` +
      `Project root is ${project}.\n`,
  );
  await writeFile(
    join(memDir, 'logs', '2026', 'details.md'),
    `Log entry. Ran ${project}/scripts/test.sh successfully.\n`,
  );
  await writeFile(
    join(memDir, 'MEMORY.md'),
    '# Index\n\n- [Conventions](project_conventions.md)\n',
  );

  return { home, project, gitRoot };
}

describe('memory round-trip', () => {
  it('exports memory with --memory and imports into the recipient git-root-keyed dir', async () => {
    const alice = await seedAlice();
    process.env.HOME = alice.home;

    await exportCommand(alice.project, {
      dryRun: false,
      noRedact: true,
      iKnowWhatImDoing: true,
      stripProgress: false,
      includeMemory: true,
    });

    // Manifest should now include a memory section with 2 files (the
    // topic file and the nested log), MEMORY.md excluded.
    const manifest = await readManifest(join(alice.project, '.claude-shared'));
    expect(manifest?.memory).toBeTruthy();
    expect(manifest!.memory!.files.map((f) => f.bundlePath).sort()).toEqual([
      'logs/2026/details.md',
      'project_conventions.md',
    ]);

    // On-disk bundle must not contain MEMORY.md, and must be fully
    // scrubbed of Alice-specific absolute paths. The store-keyed path
    // becomes {{CLAUDE_STORE}}; anything left is covered by {{HOME}}
    // (a reference followed by `.` at a sentence boundary doesn't
    // match {{PROJECT_ROOT}}'s component-boundary check by design, so
    // it falls through to HOME, which still round-trips correctly).
    const memBundleDir = join(alice.project, '.claude-shared', 'memory');
    const conventions = await readFile(join(memBundleDir, 'project_conventions.md'), 'utf-8');
    expect(conventions).not.toContain(alice.project);
    expect(conventions).toContain('{{CLAUDE_STORE}}/memory/logs/2026/details.md');

    const memoryIndexExists = await access(join(memBundleDir, 'MEMORY.md'))
      .then(() => true)
      .catch(() => false);
    expect(memoryIndexExists).toBe(false);

    // --- Move .claude-shared/ to a Neo side with a different git root ---
    const neoHome = join(scratch, 'neo-home');
    const neoProject = join(neoHome, 'projects', 'myapp');
    await mkdir(neoProject, { recursive: true });
    await execFileAsync('git', ['init', '--quiet'], { cwd: neoProject });
    await writeFile(join(neoProject, 'README.md'), '# myapp\n');
    await execFileAsync('git', ['add', '.'], { cwd: neoProject });
    await execFileAsync(
      'git',
      ['-c', 'user.email=n@n', '-c', 'user.name=n', 'commit', '--quiet', '-m', 'init'],
      { cwd: neoProject },
    );
    await cp(join(alice.project, '.claude-shared'), join(neoProject, '.claude-shared'), {
      recursive: true,
    });

    process.env.HOME = neoHome;
    const neoGitRoot = await findCanonicalGitRoot(neoProject);
    const neoMemDest = join(
      neoHome,
      '.claude',
      'projects',
      sanitizeProjectKey(neoGitRoot),
      'memory',
    );

    await importCommand(neoProject, {
      dryRun: false,
      all: true,
      overwrite: false,
    });

    // Memory files landed under Neo's store, keyed by Neo's git root.
    const neoConventions = await readFile(join(neoMemDest, 'project_conventions.md'), 'utf-8');
    expect(neoConventions).not.toContain('{{CLAUDE_STORE}}');
    expect(neoConventions).not.toContain(alice.project);
    expect(neoConventions).toContain(neoProject);
    // The in-file reference to another memory path should now point at
    // Neo's store, not Alice's.
    expect(neoConventions).toContain(`${neoMemDest}/logs/2026/details.md`);

    const neoLog = await readFile(join(neoMemDest, 'logs', '2026', 'details.md'), 'utf-8');
    expect(neoLog).toContain(neoProject);
    expect(neoLog).not.toContain(alice.project);

    // MEMORY.md stays absent — Claude Code will rebuild it.
    const memoryIndexOnNeo = await access(join(neoMemDest, 'MEMORY.md'))
      .then(() => true)
      .catch(() => false);
    expect(memoryIndexOnNeo).toBe(false);
  });

  it('omits the memory section when --memory is not set', async () => {
    const alice = await seedAlice();
    process.env.HOME = alice.home;

    await exportCommand(alice.project, {
      dryRun: false,
      noRedact: true,
      iKnowWhatImDoing: true,
      stripProgress: false,
      includeMemory: false,
    });

    const manifest = await readManifest(join(alice.project, '.claude-shared'));
    expect(manifest?.memory).toBeUndefined();

    const memBundleExists = await access(join(alice.project, '.claude-shared', 'memory'))
      .then(() => true)
      .catch(() => false);
    expect(memBundleExists).toBe(false);
  });
});
