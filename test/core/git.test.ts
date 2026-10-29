import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hasCommit, parsePorcelainZ, readGitState, relativeInside } from '../../src/core/git.js';

let dir: string;
const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd: dir,
    encoding: 'utf-8',
  }).trim();

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'claude-handoff-git-')));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('parsePorcelainZ', () => {
  it('reads paths, including names with spaces, and skips rename sources', () => {
    const output = [
      ' M src/a.ts',
      '?? new file.ts',
      'R  renamed.ts',
      'old-name.ts',
      'A  b.ts',
      '',
    ].join('\0');
    expect(parsePorcelainZ(output)).toEqual(['src/a.ts', 'new file.ts', 'renamed.ts', 'b.ts']);
    expect(parsePorcelainZ('')).toEqual([]);
  });
});

describe('relativeInside', () => {
  it('returns a forward-slash path inside the root and undefined outside it', () => {
    expect(relativeInside('/repo', '/repo/src/a.ts')).toBe('src/a.ts');
    expect(relativeInside('/repo', '/repo')).toBeUndefined();
    expect(relativeInside('/repo', '/elsewhere/a.ts')).toBeUndefined();
    expect(relativeInside('/repo', '/repository/a.ts')).toBeUndefined();
  });
});

describe('readGitState and hasCommit', () => {
  it('are undefined outside a repository', async () => {
    expect(await readGitState(dir)).toBeUndefined();
    expect(await hasCommit(dir, 'a'.repeat(40))).toBeUndefined();
  });

  it('report HEAD, branch and dirty paths, also from a subdirectory', async () => {
    git('init', '-q', '-b', 'main');
    await mkdir(join(dir, 'src'));
    await writeFile(join(dir, 'src', 'a.ts'), 'a');
    git('add', '.');
    git('commit', '-qm', 'init');
    const head = git('rev-parse', 'HEAD');
    await writeFile(join(dir, 'src', 'a.ts'), 'changed');
    await writeFile(join(dir, 'src', 'b.ts'), 'new');

    const state = await readGitState(join(dir, 'src'));
    expect(state).toEqual({
      root: dir,
      commit: head,
      branch: 'main',
      dirty: ['src/a.ts', 'src/b.ts'],
    });
  });

  it('tells whether a commit is in HEAD history', async () => {
    git('init', '-q');
    git('commit', '-q', '--allow-empty', '-m', 'one');
    const first = git('rev-parse', 'HEAD');
    git('commit', '-q', '--allow-empty', '-m', 'two');
    expect(await hasCommit(dir, first)).toBe(true);
    expect(await hasCommit(dir, 'f'.repeat(40))).toBe(false);
    expect(await hasCommit(dir, '--not-a-hash')).toBe(false);
  });
});
