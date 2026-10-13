/**
 * claude-handoff skill — install a Claude Code skill that teaches the
 * agent the handoff workflow, so "hand this session off" in a
 * conversation runs the right commands.
 *
 * The skill only ever runs export / import. Committing and pushing stay
 * with the human, same as when the CLI is used by hand.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const SKILL_NAME = 'claude-handoff';

export const SKILL_CONTENT = `---
name: ${SKILL_NAME}
description: Hand a Claude Code session to a teammate or another machine with the claude-handoff CLI, or pick up one that was handed over. Use when the user asks to hand off, share, export, send or transfer this session or conversation, or to import or resume a session someone shared.
---

# Handing off a Claude Code session

\`claude-handoff\` packages a session so it can be resumed elsewhere with \`claude --resume\`. It rewrites absolute paths and redacts secrets on the way out. Run it from the project root.

If the command is missing, tell the user to install it with \`npm install -g @neoacar/claude-handoff\` and stop.

## Sending

1. Ask which route the user wants if they haven't said:
   - **Through the repo** (teammates who share it): writes \`.claude-shared/\`, which the user commits.
   - **As one file** (no shared repo): writes an archive the user sends however they like.
2. Preview first: \`claude-handoff export --dry-run --session "<words from the title>"\`. Without \`--session\` every session of the project is exported; \`--last 1\` takes the most recent. Show the user the list.
3. Export for real:
   - repo: \`claude-handoff export --session "<title words>"\`
   - file: \`claude-handoff export --session "<title words>" --archive <name>.handoff.tgz\`
4. Report what the command printed: which sessions, how many redactions and of which kinds.
5. For the repo route, tell the user to review \`git diff .claude-shared/\` and commit it themselves.

## Receiving

- From the repo, after \`git pull\`: \`claude-handoff import\`
- From a file: \`claude-handoff import --archive <file>\`

Then give the user the \`claude --resume <id>\` line the command printed.

## Rules

- Never run \`git add\`, \`git commit\` or \`git push\` for the handoff. The user reviews and commits.
- Never pass \`--no-redact\`, \`--no-env-scan\` or \`--i-know-what-im-doing\`. If the user wants redaction off, they run that themselves.
- Redaction lowers the risk of leaking secrets; it does not guarantee it. Say so when you report the result, and do not describe the export as safe to publish.
- If something looks wrong (no sessions found, resume fails), run \`claude-handoff doctor\` and show its output.
`;

export function getSkillPath(home: string = os.homedir()): string {
  return path.join(home, '.claude', 'skills', SKILL_NAME, 'SKILL.md');
}

export async function skillInstallCommand(options: { force: boolean }): Promise<void> {
  const target = getSkillPath();

  let existing: string | undefined;
  try {
    existing = await readFile(target, 'utf-8');
  } catch {
    // not installed yet
  }

  if (existing === SKILL_CONTENT) {
    console.log(`Already up to date: ${target}`);
    return;
  }
  if (existing !== undefined && !options.force) {
    throw new Error(
      `${target} exists and differs from the bundled skill. ` +
        'Rerun with --force to replace it (your edits will be lost).',
    );
  }

  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, SKILL_CONTENT, 'utf-8');
  console.log(`${existing === undefined ? 'Installed' : 'Replaced'}: ${target}`);
  console.log(
    'New Claude Code sessions will pick it up. Try: "hand this session off to a teammate".',
  );
}

export function skillPrintCommand(): void {
  process.stdout.write(SKILL_CONTENT);
}
