/**
 * Read-only git queries, for telling the receiver whether their checkout
 * has the code a session talks about. Nothing here changes a repository:
 * the tool never stages, commits or pushes.
 */

import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GitState {
  /** Absolute path of the repository root. */
  root: string;
  /** Full hash of HEAD. */
  commit: string;
  /** Current branch, absent when HEAD is detached. */
  branch?: string;
  /** Paths with uncommitted changes (staged, unstaged or untracked), relative to `root`. */
  dirty: string[];
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    timeout: 15_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

/** HEAD, branch and dirty paths for the repository containing `dir`; undefined outside one. */
export async function readGitState(dir: string): Promise<GitState | undefined> {
  try {
    const root = (await git(dir, ['rev-parse', '--show-toplevel'])).trim();
    const commit = (await git(dir, ['rev-parse', 'HEAD'])).trim();
    const branch = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    const status = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    return {
      root,
      commit,
      branch: branch === 'HEAD' ? undefined : branch,
      dirty: parsePorcelainZ(status),
    };
  } catch {
    return undefined; // not a repository, no commits yet, or git missing
  }
}

/**
 * Paths from `git status --porcelain=v1 -z`. Each entry is `XY path`;
 * renames and copies are followed by an extra NUL-terminated original
 * path, which is skipped.
 */
export function parsePorcelainZ(output: string): string[] {
  const parts = output.split('\0');
  const paths: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    if (entry[0] === 'R' || entry[0] === 'C') i++;
  }
  return paths;
}

/**
 * Does the repository at `dir` contain `commit` in HEAD's history?
 * `false` also covers a commit that isn't in the repository at all.
 * Undefined when it can't be determined (not a repository, git missing).
 */
export async function hasCommit(dir: string, commit: string): Promise<boolean | undefined> {
  if (!/^[0-9a-f]{7,64}$/i.test(commit)) return false;
  try {
    await git(dir, ['rev-parse', '--show-toplevel']);
  } catch {
    return undefined;
  }
  try {
    await git(dir, ['merge-base', '--is-ancestor', commit, 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

/** `filePath` relative to `root` with forward slashes, or undefined when it lies outside. */
export function relativeInside(root: string, filePath: string): string | undefined {
  const rel = path.relative(root, filePath);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  return rel.split(path.sep).join('/');
}
