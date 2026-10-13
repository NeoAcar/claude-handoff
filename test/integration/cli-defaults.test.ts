/**
 * The behaviours the CLI layers on top of exportCommand: a bare export
 * lists instead of writing, and the first real export sets the project up.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { exportCommand } from '../../src/commands/export.js';
import { ensureLocalDirIgnored } from '../../src/commands/init.js';
import { sanitizeProjectKey } from '../../src/core/store.js';

let scratch: string;
let home: string;
let project: string;
let originalHome: string | undefined;

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'claude-handoff-cli-'));
  home = join(scratch, 'home');
  project = join(home, 'code', 'app');
  const store = join(home, '.claude', 'projects', sanitizeProjectKey(project));
  await mkdir(store, { recursive: true });
  await mkdir(project, { recursive: true });
  for (const [id, title] of [
    ['aaaa1111-0000-0000-0000-000000000001', 'Fix upload timeout'],
    ['bbbb2222-0000-0000-0000-000000000002', 'Refactor billing'],
  ]) {
    const records = [
      {
        type: 'user',
        sessionId: id,
        cwd: project,
        uuid: 'u1',
        parentUuid: null,
        timestamp: '2026-10-10T09:00:00.000Z',
        message: { role: 'user', content: 'hello' },
      },
      { type: 'ai-title', aiTitle: title, sessionId: id },
    ];
    await writeFile(
      join(store, `${id}.jsonl`),
      records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    );
  }
  originalHome = process.env.HOME;
  process.env.HOME = home;
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  vi.restoreAllMocks();
  await rm(scratch, { recursive: true, force: true });
});

const base = { dryRun: false, noRedact: false, iKnowWhatImDoing: false, requireSelection: true };

describe('export with nothing chosen', () => {
  it('lists the sessions, says how to choose, and writes nothing', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exported = await exportCommand(project, base);
    const output = log.mock.calls.map((c) => String(c[0])).join('\n');

    expect(exported).toBe(0);
    expect(output).toContain('Fix upload timeout');
    expect(output).toContain('Refactor billing');
    expect(output).toContain('Nothing written');
    expect(output).toContain('claude-handoff export --all');
    expect(await exists(join(project, '.claude-shared'))).toBe(false);
    expect(await exists(join(project, '.claude-handoff'))).toBe(false);
  });

  it('exports once something is chosen: a title, a count, or --all', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await exportCommand(project, { ...base, session: 'billing' })).toBe(1);
    await rm(join(project, '.claude-shared'), { recursive: true });
    expect(await exportCommand(project, { ...base, last: 1 })).toBe(1);
    await rm(join(project, '.claude-shared'), { recursive: true });
    expect(await exportCommand(project, { ...base, all: true })).toBe(2);
  });
});

describe('first-export setup', () => {
  it('ignores the local directory in a git repository and writes the shared README', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await mkdir(join(project, '.git'));
    await writeFile(join(project, '.gitignore'), 'node_modules/');

    await exportCommand(project, { ...base, all: true });

    expect(await readFile(join(project, '.gitignore'), 'utf-8')).toBe(
      'node_modules/\n\n# claude-handoff local state\n.claude-handoff/\n*.handoff\n',
    );
    expect(await exists(join(project, '.claude-shared', 'README.md'))).toBe(true);
  });

  it('is idempotent and leaves a non-git directory without a .gitignore', async () => {
    expect(await ensureLocalDirIgnored(project)).toEqual([]);
    expect(await exists(join(project, '.gitignore'))).toBe(false);

    await mkdir(join(project, '.git'));
    expect(await ensureLocalDirIgnored(project)).toHaveLength(1);
    expect(await ensureLocalDirIgnored(project)).toEqual([]);
    expect(await readFile(join(project, '.gitignore'), 'utf-8')).toBe(
      '\n# claude-handoff local state\n.claude-handoff/\n*.handoff\n',
    );
  });

  it('adds only what an older setup is missing', async () => {
    await mkdir(join(project, '.git'));
    await writeFile(
      join(project, '.gitignore'),
      '# claude-handoff local state\n.claude-handoff/\n',
    );
    expect(await ensureLocalDirIgnored(project)).toHaveLength(1);
    expect(await readFile(join(project, '.gitignore'), 'utf-8')).toBe(
      '# claude-handoff local state\n.claude-handoff/\n*.handoff\n',
    );
  });
});

describe('picking interactively', () => {
  it('exports what the picker returns and nothing on cancel', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const seen: string[][] = [];
    const pickSecond = async (labels: string[]) => {
      seen.push(labels);
      return [labels.findIndex((l) => l.startsWith('Refactor billing'))];
    };

    expect(await exportCommand(project, { ...base, pick: pickSecond })).toBe(1);
    expect(seen[0]).toHaveLength(2);
    expect(seen[0].every((l) => /\(\d+ records, .+ ago\)$/.test(l))).toBe(true);
    const manifest = JSON.parse(
      await readFile(join(project, '.claude-shared', '.manifest.json'), 'utf-8'),
    );
    expect(manifest.sessions.map((s: { title: string }) => s.title)).toEqual(['Refactor billing']);

    await rm(join(project, '.claude-shared'), { recursive: true });
    expect(await exportCommand(project, { ...base, pick: async () => null })).toBe(0);
    expect(await exists(join(project, '.claude-shared'))).toBe(false);
  });

  it('is skipped when something was chosen on the command line, and on a dry run', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const pick = vi.fn(async () => [0]);
    await exportCommand(project, { ...base, session: 'billing', pick });
    await exportCommand(project, { ...base, dryRun: true, pick });
    expect(pick).not.toHaveBeenCalled();
  });
});
