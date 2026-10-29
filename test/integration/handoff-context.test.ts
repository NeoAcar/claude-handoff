/**
 * Alice's session edited a file she never committed. Neo imports it into
 * a checkout that also lacks her commit: he should be told both, and the
 * bundle should explain it to anyone reading it in a pull request.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { exportCommand } from '../../src/commands/export.js';
import { importCommand } from '../../src/commands/import.js';
import { readManifest } from '../../src/core/manifest.js';
import { sanitizeProjectKey } from '../../src/core/store.js';

const SESSION_ID = 'context-1111-2222-3333-444444444444';
let scratch: string;
let originalHome: string | undefined;

const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf-8',
  }).trim();

beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'claude-handoff-context-')));
  originalHome = process.env.HOME;
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  vi.restoreAllMocks();
  await rm(scratch, { recursive: true, force: true });
});

describe('handoff context', () => {
  it('records uncommitted edits on export and warns the receiver on import', async () => {
    // --- Alice: a repo with one commit, then a session that edits two files ---
    const aliceHome = join(scratch, 'alice');
    const aliceProject = join(aliceHome, 'app');
    await mkdir(join(aliceProject, 'src'), { recursive: true });
    await writeFile(join(aliceProject, 'src', 'a.ts'), 'old\n');
    await writeFile(join(aliceProject, 'src', 'done.ts'), 'old\n');
    gitIn(aliceProject, 'init', '-q', '-b', 'main');
    gitIn(aliceProject, 'add', '.');
    gitIn(aliceProject, 'commit', '-qm', 'init');
    await writeFile(join(aliceProject, 'src', 'done.ts'), 'new\n');
    gitIn(aliceProject, 'commit', '-qam', 'committed edit');
    const aliceHead = gitIn(aliceProject, 'rev-parse', 'HEAD');
    await writeFile(join(aliceProject, 'src', 'a.ts'), 'new but uncommitted\n');

    const store = join(aliceHome, '.claude', 'projects', sanitizeProjectKey(aliceProject));
    await mkdir(store, { recursive: true });
    const base = { sessionId: SESSION_ID, cwd: aliceProject, timestamp: '2026-10-29T10:00:00Z' };
    const edit = (id: string, file: string) => ({
      ...base,
      type: 'assistant',
      uuid: `a-${id}`,
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id, name: 'Edit', input: { file_path: join(aliceProject, file) } },
        ],
      },
    });
    const records = [
      {
        ...base,
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        message: { role: 'user', content: 'fix the login bug' },
      },
      edit('t1', 'src/a.ts'),
      edit('t2', 'src/done.ts'),
      {
        ...base,
        type: 'assistant',
        uuid: 'a-t3',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 't3',
              name: 'Bash',
              input: {
                command: `curl -H "x-api-key: ${'sk-ant-' + 'api03-Zx9Kq2Lm8Pw4'}" ${aliceHome}/x`,
              },
            },
          ],
        },
      },
      { type: 'ai-title', aiTitle: 'Fix login bug', sessionId: SESSION_ID },
    ];
    await writeFile(
      join(store, `${SESSION_ID}.jsonl`),
      records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    );

    process.env.HOME = aliceHome;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await exportCommand(aliceProject, { dryRun: false, noRedact: false, iKnowWhatImDoing: false });

    const sharedDir = join(aliceProject, '.claude-shared');
    const entry = (await readManifest(sharedDir))!.sessions[0];
    expect(entry.context).toMatchObject({
      commit: aliceHead,
      branch: 'main',
      editedFiles: ['src/a.ts', 'src/done.ts'],
      uncommittedEdits: ['src/a.ts'],
      userTurns: 1,
      lastAsk: 'fix the login bug',
    });
    const handoff = await readFile(join(sharedDir, 'sessions', SESSION_ID, 'HANDOFF.md'), 'utf-8');
    expect(handoff).toContain('## Not in that commit');
    expect(handoff).toContain('- `src/a.ts`');
    expect(handoff).not.toContain(aliceHome);
    // Commands quoted in the summary are redacted like everything else.
    expect(handoff).toContain('[REDACTED:anthropic-key]');
    expect(handoff + JSON.stringify(entry)).not.toContain('sk-ant-');

    // --- Neo: a different repository that has never seen Alice's commits ---
    const neoHome = join(scratch, 'neo');
    const neoProject = join(neoHome, 'app');
    await mkdir(neoProject, { recursive: true });
    gitIn(neoProject, 'init', '-q');
    gitIn(neoProject, 'commit', '-q', '--allow-empty', '-m', 'unrelated');
    await cp(sharedDir, join(neoProject, '.claude-shared'), { recursive: true });

    process.env.HOME = neoHome;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await importCommand(neoProject, { dryRun: false, all: true, overwrite: false });
    const output = log.mock.calls.map((c) => String(c[0])).join('\n');

    expect(output).toContain(
      `exported at commit ${aliceHead.slice(0, 12)}, which your checkout doesn't have`,
    );
    expect(output).toContain('1 file(s) the session edited were not committed (src/a.ts)');

    // Once Neo has Alice's history, only the uncommitted-edit warning remains.
    gitIn(neoProject, 'fetch', '-q', aliceProject, 'main');
    gitIn(neoProject, 'checkout', '-q', 'FETCH_HEAD');
    log.mockClear();
    const neoStore = join(neoHome, '.claude', 'projects', sanitizeProjectKey(neoProject));
    await rm(join(neoStore, `${SESSION_ID}.jsonl`)); // import it afresh
    await importCommand(neoProject, { dryRun: false, all: true, overwrite: false });
    const second = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(second).toContain('Imported:');
    expect(second).not.toContain("which your checkout doesn't have");
    expect(second).toContain('were not committed (src/a.ts)');
  });
});
