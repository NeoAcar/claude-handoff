/**
 * The facts a receiver needs before resuming someone else's session:
 * which commit it was exported at, which files it edited, and which of
 * those edits were still uncommitted — that is, which changes the
 * session talks about but the receiver's checkout won't have.
 *
 * Everything comes from the transcript and from read-only git queries on
 * the sender's side; nothing is written by the model.
 */

import type { SessionActivity } from './activity.js';
import type { GitState } from './git.js';
import { relativeInside } from './git.js';

export interface HandoffContext {
  /** HEAD on the sender's machine at export time. */
  commit?: string;
  branch?: string;
  /** Files the session edited, relative to the repository (or rewritten when outside it). */
  editedFiles: string[];
  /** The edited files that still had uncommitted changes when the session was exported. */
  uncommittedEdits: string[];
  commands: number;
  failedCommands: number;
  lastCommands: string[];
  userTurns: number;
  lastAsk?: string;
}

/**
 * Build the context for one session. `clean` turns transcript text into
 * something safe to ship (path rewriting plus redaction); it is applied
 * to every free-text field.
 */
export function buildHandoffContext(
  activity: SessionActivity,
  git: GitState | undefined,
  clean: (text: string) => string,
): HandoffContext {
  const dirty = new Set(git?.dirty ?? []);
  const editedFiles: string[] = [];
  const uncommittedEdits: string[] = [];
  for (const file of activity.editedFiles) {
    const inRepo = git ? relativeInside(git.root, file) : undefined;
    editedFiles.push(inRepo ?? clean(file));
    if (inRepo !== undefined && dirty.has(inRepo)) uncommittedEdits.push(inRepo);
  }
  return {
    commit: git?.commit,
    branch: git?.branch,
    editedFiles,
    uncommittedEdits,
    commands: activity.commands,
    failedCommands: activity.failedCommands,
    lastCommands: activity.lastCommands.map(clean),
    userTurns: activity.userTurns,
    lastAsk: activity.lastAsk === undefined ? undefined : clean(activity.lastAsk),
  };
}

const MAX_LISTED_FILES = 30;

/** The human-readable HANDOFF.md written next to each exported session. */
export function renderHandoffMarkdown(args: {
  title: string;
  author: string;
  exportedAt: string;
  context: HandoffContext;
}): string {
  const { title, author, exportedAt, context: c } = args;
  const lines: string[] = [`# ${title}`, ''];

  const where =
    c.commit !== undefined
      ? ` from ${c.branch ? `branch \`${c.branch}\`` : 'a detached HEAD'} at commit \`${c.commit.slice(0, 12)}\``
      : '';
  lines.push(`Exported by ${author} on ${exportedAt.slice(0, 10)}${where}.`, '');

  if (c.uncommittedEdits.length > 0) {
    lines.push(
      '## Not in that commit',
      '',
      'The session edited these files, and they still had uncommitted changes when it was',
      'exported. Unless they were committed and pushed separately, a fresh checkout does not',
      'have the changes the conversation talks about:',
      '',
      ...listFiles(c.uncommittedEdits),
      '',
    );
  }

  lines.push('## What the session did', '');
  lines.push(`- ${c.userTurns} request(s) from the user.`);
  if (c.lastAsk) lines.push(`- Last request: ${quote(c.lastAsk)}`);
  if (c.editedFiles.length > 0) {
    lines.push(`- Edited ${c.editedFiles.length} file(s):`, ...listFiles(c.editedFiles, '  '));
  } else {
    lines.push('- Edited no files.');
  }
  if (c.commands > 0) {
    const failed = c.failedCommands > 0 ? `, ${c.failedCommands} failed` : '';
    lines.push(`- Ran ${c.commands} shell command(s)${failed}. Last ones:`);
    for (const command of c.lastCommands) lines.push(`  - \`${oneLine(command)}\``);
  }
  lines.push(
    '',
    '_Written by claude-handoff from the transcript itself, not by the model. Paths and text are redacted like the rest of the bundle._',
    '',
  );
  return lines.join('\n');
}

function listFiles(files: string[], indent = ''): string[] {
  const shown = files.slice(0, MAX_LISTED_FILES).map((f) => `${indent}- \`${f}\``);
  if (files.length > MAX_LISTED_FILES) {
    shown.push(`${indent}- … and ${files.length - MAX_LISTED_FILES} more`);
  }
  return shown;
}

function oneLine(text: string): string {
  const single = text.replace(/\s*\n\s*/g, ' ⏎ ').replace(/`/g, "'");
  return single.length > 160 ? single.slice(0, 159) + '…' : single;
}

function quote(text: string): string {
  return `“${oneLine(text)}”`;
}

/** Transcripts above this size get a note that resuming re-reads all of it. */
export const LARGE_TRANSCRIPT_BYTES = 1.5 * 1024 * 1024;

/**
 * Warnings for the person importing a session: code the conversation
 * refers to that their checkout lacks, and the cost of resuming a big
 * transcript. `receiverHasCommit` is undefined when it couldn't be
 * checked (no repository on the receiving side).
 */
export function receiverWarnings(args: {
  context: HandoffContext | undefined;
  receiverHasCommit: boolean | undefined;
  transcriptBytes: number | undefined;
}): string[] {
  const { context, receiverHasCommit, transcriptBytes } = args;
  const warnings: string[] = [];
  if (context?.commit && receiverHasCommit === false) {
    warnings.push(
      `It was exported at commit ${context.commit.slice(0, 12)}, which your checkout doesn't have. ` +
        "Pull first, or the session may refer to code you can't see.",
    );
  }
  if (context && context.uncommittedEdits.length > 0) {
    const shown = context.uncommittedEdits.slice(0, 5).join(', ');
    const more =
      context.uncommittedEdits.length > 5 ? `, +${context.uncommittedEdits.length - 5} more` : '';
    warnings.push(
      `On the sender's machine, ${context.uncommittedEdits.length} file(s) the session edited were ` +
        `not committed (${shown}${more}). Your copies probably lack those changes; ask for them, ` +
        'or tell Claude when you resume.',
    );
  }
  if (transcriptBytes !== undefined && transcriptBytes > LARGE_TRANSCRIPT_BYTES) {
    const mb = (transcriptBytes / (1024 * 1024)).toFixed(1);
    warnings.push(
      `The transcript is ${mb} MB. Resuming it re-reads the whole conversation, which costs ` +
        'tokens; if you only need where it ended, run /compact after resuming.',
    );
  }
  return warnings;
}
