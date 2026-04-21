#!/usr/bin/env node

/**
 * claude-handoff CLI entry point.
 */

import { Command } from 'commander';
import { resolve } from 'node:path';
import { initCommand } from './commands/init.js';
import { exportCommand } from './commands/export.js';
import { importCommand } from './commands/import.js';
import { statusCommand } from './commands/status.js';
import { listCommand } from './commands/list.js';

const program = new Command();

program
  .name('claude-handoff')
  .description('Make Claude Code session context portable between machines via git')
  .version('0.1.0');

program
  .command('init')
  .description('One-time setup: create .claude-shared/, update .gitignore')
  .action(async () => {
    await run(() => initCommand(getProjectRoot()));
  });

program
  .command('export')
  .description("Export local Claude Code sessions to .claude-shared/ (Alice's command)")
  .option('--session <id>', 'Export one specific session')
  .option('--last <n>', 'Export the last N sessions', parseInt)
  .option('--since <date>', 'Export sessions modified since date')
  .option('--author <name>', 'Tag exported sessions with author name')
  .option('--dry-run', 'Show what would happen, write nothing', false)
  .option('--no-redact', 'Skip secret redaction')
  .option('--i-know-what-im-doing', 'Required with --no-redact', false)
  .option('--strip-progress', 'Drop streaming progress records (smaller files)', false)
  .option(
    '--keep-signatures',
    'Keep thinking.signature fields (default: strip to avoid API 400s after cross-machine resume)',
    false,
  )
  .option(
    '--memory',
    "Also export the project's auto-memory files (~/.claude/projects/<key>/memory/ except MEMORY.md)",
    false,
  )
  .action(async (opts) => {
    await run(() =>
      exportCommand(getProjectRoot(), {
        dryRun: opts.dryRun,
        noRedact: !opts.redact,
        iKnowWhatImDoing: opts.iKnowWhatImDoing,
        author: opts.author,
        session: opts.session,
        last: opts.last,
        since: opts.since,
        stripProgress: opts.stripProgress,
        keepSignatures: opts.keepSignatures,
        includeMemory: opts.memory,
      }),
    );
  });

program
  .command('import')
  .description("Import shared sessions from .claude-shared/ (Neo's command)")
  .option('--session <id>', 'Import one specific session')
  .option('--all', 'Import everything (default)', true)
  .option('--dry-run', 'Preview path rewrites and destination', false)
  .option('--overwrite', 'Replace existing local sessions with same ID', false)
  .action(async (opts) => {
    await run(() =>
      importCommand(getProjectRoot(), {
        dryRun: opts.dryRun,
        session: opts.session,
        all: opts.all,
        overwrite: opts.overwrite,
      }),
    );
  });

program
  .command('status')
  .description('Show local sessions, shared sessions, and diff')
  .action(async () => {
    await run(() => statusCommand(getProjectRoot()));
  });

program
  .command('list')
  .description('List sessions in .claude-shared/')
  .option('-v, --verbose', 'Show author, export time, and redaction markers per session', false)
  .action(async (opts) => {
    await run(() => listCommand(getProjectRoot(), { verbose: opts.verbose }));
  });

// Default action when no subcommand is given: run `status` and hint at next steps.
program.action(async () => {
  await run(async () => {
    await statusCommand(getProjectRoot());
    console.log(
      '\nNext: `claude-handoff export` to share, or `claude-handoff --help` for all commands.',
    );
  });
});

function getProjectRoot(): string {
  return resolve(process.cwd());
}

async function run(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  }
}

program.parse();
