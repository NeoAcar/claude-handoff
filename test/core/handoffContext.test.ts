import { describe, it, expect } from 'vitest';
import {
  buildHandoffContext,
  LARGE_TRANSCRIPT_BYTES,
  receiverWarnings,
  renderHandoffMarkdown,
} from '../../src/core/handoffContext.js';
import type { SessionActivity } from '../../src/core/activity.js';

const activity: SessionActivity = {
  editedFiles: ['/repo/src/a.ts', '/repo/src/b.ts', '/home/me/notes.txt'],
  commands: 3,
  failedCommands: 1,
  lastCommands: ['npm test', 'cat /home/me/.netrc'],
  userTurns: 2,
  lastAsk: 'fix the login bug',
};
const git = {
  root: '/repo',
  commit: 'a1b2c3d4e5f6a7b8',
  branch: 'main',
  dirty: ['src/b.ts', 'other.ts'],
};
const clean = (text: string) => text.replace('/home/me', '{{HOME}}');

describe('buildHandoffContext', () => {
  it('relates edits to the repository and finds the uncommitted ones', () => {
    expect(buildHandoffContext(activity, git, clean)).toEqual({
      commit: 'a1b2c3d4e5f6a7b8',
      branch: 'main',
      editedFiles: ['src/a.ts', 'src/b.ts', '{{HOME}}/notes.txt'],
      uncommittedEdits: ['src/b.ts'],
      commands: 3,
      failedCommands: 1,
      lastCommands: ['npm test', 'cat {{HOME}}/.netrc'],
      userTurns: 2,
      lastAsk: 'fix the login bug',
    });
  });

  it('works without a repository', () => {
    const context = buildHandoffContext(activity, undefined, clean);
    expect(context.commit).toBeUndefined();
    expect(context.uncommittedEdits).toEqual([]);
    expect(context.editedFiles[0]).toBe('/repo/src/a.ts');
  });
});

describe('renderHandoffMarkdown', () => {
  it('leads with what the receiver may be missing', () => {
    const md = renderHandoffMarkdown({
      title: 'Fix login bug',
      author: 'Alice',
      exportedAt: '2026-10-29T10:00:00.000Z',
      context: buildHandoffContext(activity, git, clean),
    });
    expect(md).toContain('# Fix login bug');
    expect(md).toContain(
      'Exported by Alice on 2026-10-29 from branch `main` at commit `a1b2c3d4e5f6`.',
    );
    expect(md.indexOf('## Not in that commit')).toBeLessThan(md.indexOf('## What the session did'));
    expect(md).toContain('- `src/b.ts`');
    expect(md).toContain('Ran 3 shell command(s), 1 failed');
    expect(md).toContain('not by the model');
  });

  it('omits the warning section when everything was committed', () => {
    const md = renderHandoffMarkdown({
      title: 't',
      author: 'a',
      exportedAt: '2026-10-29',
      context: buildHandoffContext(activity, { ...git, dirty: [] }, clean),
    });
    expect(md).not.toContain('Not in that commit');
  });
});

describe('receiverWarnings', () => {
  const context = buildHandoffContext(activity, git, clean);

  it('warns about a missing commit, uncommitted edits, and a large transcript', () => {
    const warnings = receiverWarnings({
      context,
      receiverHasCommit: false,
      transcriptBytes: LARGE_TRANSCRIPT_BYTES + 1,
    });
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain('a1b2c3d4e5f6');
    expect(warnings[1]).toContain('src/b.ts');
    expect(warnings[2]).toContain('/compact');
  });

  it('stays quiet when the receiver has the commit and nothing was left uncommitted', () => {
    const clean = buildHandoffContext(activity, { ...git, dirty: [] }, (t) => t);
    expect(
      receiverWarnings({ context: clean, receiverHasCommit: true, transcriptBytes: 1000 }),
    ).toEqual([]);
  });

  it('says nothing about commits it could not check, or bundles from older versions', () => {
    expect(
      receiverWarnings({
        context: { ...context, uncommittedEdits: [] },
        receiverHasCommit: undefined,
        transcriptBytes: 10,
      }),
    ).toEqual([]);
    expect(
      receiverWarnings({ context: undefined, receiverHasCommit: undefined, transcriptBytes: 10 }),
    ).toEqual([]);
  });
});
