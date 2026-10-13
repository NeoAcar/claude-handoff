/**
 * Fallback session titles.
 *
 * Claude Code writes `custom-title` / `ai-title` records for most
 * sessions, but not all (short ones, `claude -p` runs). For those the
 * best human label is the first thing the user actually asked — once
 * the control blocks Claude Code wraps around slash commands, shell
 * escapes and reminders are peeled off.
 */

import type { SessionRecord } from './session.js';

export const TITLE_MAX_LENGTH = 80;

/** Blocks Claude Code injects into user turns; never part of what the user typed. */
const CONTROL_TAGS = [
  'command-message',
  'command-name',
  'command-args',
  'local-command-caveat',
  'local-command-stdout',
  'local-command-stderr',
  'bash-input',
  'bash-stdout',
  'bash-stderr',
  'task-notification',
  'system-reminder',
  'user-prompt-submit-hook',
  'ide_opened_file',
  'ide_selection',
];

/** Remove any run of leading control blocks from a user message. */
export function stripLeadingControlBlocks(text: string): string {
  let rest = text.trimStart();
  for (;;) {
    const tag = CONTROL_TAGS.find((t) => rest.startsWith(`<${t}>`));
    if (!tag) return rest;
    const close = rest.indexOf(`</${tag}>`);
    if (close < 0) return rest;
    rest = rest.slice(close + tag.length + 3).trimStart();
  }
}

/**
 * First non-empty line of the user's own text; undefined if there is
 * none. Returned whole: shortening it here would cut a token in half
 * before redaction ever saw it. Callers shorten with `truncateTitle`
 * once the text is safe to show.
 */
export function titleFromUserText(text: string): string | undefined {
  return stripLeadingControlBlocks(text)
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
}

/** Shorten a title for display. */
export function truncateTitle(title: string): string {
  return title.length > TITLE_MAX_LENGTH
    ? title.slice(0, TITLE_MAX_LENGTH - 1).trimEnd() + '…'
    : title;
}

/**
 * Title candidate from one transcript record, if it is a real user turn:
 * type `user`, not meta, not a subagent sidechain, and carrying text
 * (tool results are `user` records too, with no text block).
 */
export function titleFromRecord(record: SessionRecord): string | undefined {
  if (record.type !== 'user') return undefined;
  const r = record as { isMeta?: unknown; isSidechain?: unknown; message?: { content?: unknown } };
  if (r.isMeta === true || r.isSidechain === true) return undefined;

  const content = r.message?.content;
  if (typeof content === 'string') return titleFromUserText(content);
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as { type?: unknown; text?: unknown };
    if (b.type === 'text' && typeof b.text === 'string') {
      const title = titleFromUserText(b.text);
      if (title) return title;
    }
  }
  return undefined;
}
