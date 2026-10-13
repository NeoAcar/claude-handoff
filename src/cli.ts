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
import { doctorCommand } from './commands/doctor.js';
import { exportArchiveCommand, importArchiveCommand } from './commands/archive.js';
import { skillInstallCommand, skillPrintCommand } from './commands/skill.js';
import { TOOL_VERSION } from './core/version.js';

const program = new Command();

program
  .name('claude-handoff')
  .description('Make Claude Code session context portable between machines via git')
  .version(TOOL_VERSION);

program
  .command('init')
  .description('One-time setup: create .claude-shared/, update .gitignore')
  .action(async () => {
    await run(() => initCommand(getProjectRoot()));
  });

program
  .command('export')
  .description("Export local Claude Code sessions to .claude-shared/ (Alice's command)")
  .option('--session <id|title>', 'Export sessions matching an ID prefix or title text')
  .option('--last <n>', 'Export the last N sessions', parseInt)
  .option('--since <date>', 'Export sessions modified since date')
  .option('--author <name>', 'Tag exported sessions with author name')
  .option('--dry-run', 'Show what would happen, write nothing', false)
  .option('--no-redact', 'Skip secret redaction')
  .option('--i-know-what-im-doing', 'Required with --no-redact', false)
  .option(
    '--no-env-scan',
    "Don't scrub values found in the project's .env files and secret-named environment variables",
  )
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
  .option(
    '--force',
    'Export even when the local session looks behind the shared bundle (bypasses fork detection)',
    false,
  )
  .option(
    '--archive <file>',
    'Write one archive file to send directly, instead of .claude-shared/ in the repo',
  )
  .action(async (opts) => {
    await run(async () => {
      const options = {
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
        force: opts.force,
        envScan: opts.envScan,
      };
      if (opts.archive) await exportArchiveCommand(getProjectRoot(), opts.archive, options);
      else await exportCommand(getProjectRoot(), options);
    });
  });

program
  .command('import')
  .description("Import shared sessions from .claude-shared/ (Neo's command)")
  .option('--session <id|title>', 'Import sessions matching an ID prefix or title text')
  .option('--all', 'Import everything (default)', true)
  .option('--dry-run', 'Preview path rewrites and destination', false)
  .option('--overwrite', 'Replace existing local sessions with same ID', false)
  .option('--archive <file>', 'Import from an archive file written by `export --archive`')
  .action(async (opts) => {
    await run(async () => {
      const options = {
        dryRun: opts.dryRun,
        session: opts.session,
        all: opts.all,
        overwrite: opts.overwrite,
      };
      if (opts.archive) await importArchiveCommand(getProjectRoot(), opts.archive, options);
      else await importCommand(getProjectRoot(), options);
    });
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

program
  .command('doctor')
  .description('Check the local setup: sessions, Claude Code version, bundles, redaction inputs')
  .action(async () => {
    await run(() => doctorCommand(getProjectRoot()));
  });

const skill = program
  .command('skill')
  .description('Claude Code skill that lets the agent run handoffs when asked');

skill
  .command('install')
  .description('Write the skill to ~/.claude/skills/claude-handoff/')
  .option('--force', 'Replace an existing skill file that was edited', false)
  .action(async (opts) => {
    await run(() => skillInstallCommand({ force: opts.force }));
  });

skill
  .command('print')
  .description('Print the skill file instead of installing it')
  .action(() => {
    skillPrintCommand();
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
