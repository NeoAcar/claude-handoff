#!/usr/bin/env node

/**
 * claude-handoff CLI entry point.
 */

import { Command, Option } from 'commander';
import { resolve } from 'node:path';
import { initCommand } from './commands/init.js';
import { exportCommand } from './commands/export.js';
import { importCommand } from './commands/import.js';
import { statusCommand } from './commands/status.js';
import { doctorCommand } from './commands/doctor.js';
import { exportArchiveCommand, importArchiveCommand } from './commands/archive.js';
import { skillInstallCommand, skillPrintCommand } from './commands/skill.js';
import { canPickInteractively, pickInteractively } from './commands/picker.js';
import { TOOL_VERSION } from './core/version.js';

const program = new Command();

program
  .name('claude-handoff')
  .description('Make Claude Code session context portable between machines via git')
  .version(TOOL_VERSION);

program
  .command('export [session]')
  .description(
    'Export sessions for a handoff. [session] is words from a title or an ID prefix; ' +
      'with nothing chosen, shows the sessions to pick from.',
  )
  .option('-n, --last <n>', 'Export the N most recent sessions', parseInt)
  .option('--all', 'Export every session of this project', false)
  .option(
    '-o, --archive [file]',
    'Write one file to send directly, instead of .claude-shared/ (named after the session if no name is given)',
  )
  .option('--memory', "Also export the project's auto-memory files", false)
  .option('--dry-run', 'Show what would be exported, write nothing', false)
  .addOption(new Option('--session <id|title>').hideHelp())
  .addOption(new Option('--since <date>').hideHelp())
  .addOption(new Option('--author <name>').hideHelp())
  .addOption(new Option('--no-redact').hideHelp())
  .addOption(new Option('--i-know-what-im-doing').default(false).hideHelp())
  .addOption(new Option('--no-env-scan').hideHelp())
  .addOption(new Option('--strip-progress').default(false).hideHelp())
  .addOption(new Option('--keep-signatures').default(false).hideHelp())
  .addOption(new Option('--force').default(false).hideHelp())
  .addHelpText(
    'after',
    [
      '',
      'Less common options (details in the README):',
      '  --since <date>       only sessions started on or after an ISO date',
      '  --author <name>      name recorded in the bundle (default: git user.name)',
      '  --strip-progress     drop streaming progress records to shrink the bundle',
      '  --keep-signatures    keep signed thinking blocks (receiver must share your API key)',
      '  --force              export even if the shared bundle looks newer than your copy',
      '  --no-env-scan        do not scrub values found in .env files and the environment',
      '  --no-redact --i-know-what-im-doing   turn redaction off entirely',
    ].join('\n'),
  )
  .action(async (session: string | undefined, opts) => {
    await run(async () => {
      const options = {
        dryRun: opts.dryRun,
        noRedact: !opts.redact,
        iKnowWhatImDoing: opts.iKnowWhatImDoing,
        author: opts.author,
        session: session ?? opts.session,
        last: opts.last,
        since: opts.since,
        all: opts.all,
        requireSelection: true,
        stripProgress: opts.stripProgress,
        keepSignatures: opts.keepSignatures,
        includeMemory: opts.memory,
        force: opts.force,
        envScan: opts.envScan,
        // On a terminal a bare export offers a picker; scripts and agents
        // get the plain listing.
        pick: canPickInteractively()
          ? (labels: string[]) => pickInteractively('Pick a session to export:', labels)
          : undefined,
      };
      if (opts.archive !== undefined) {
        const file = typeof opts.archive === 'string' ? opts.archive : undefined;
        await exportArchiveCommand(getProjectRoot(), file, options);
      } else {
        await exportCommand(getProjectRoot(), options);
      }
    });
  });

program
  .command('import [file]')
  .description(
    'Import shared sessions so `claude --resume` finds them. ' +
      'With [file], reads an archive written by `export -o`; otherwise reads .claude-shared/.',
  )
  .option('--overwrite', 'Replace local sessions that have work the bundle lacks', false)
  .option('--dry-run', 'Show what would be imported, write nothing', false)
  .addOption(new Option('--session <id|title>').hideHelp())
  .addOption(new Option('--archive <file>').hideHelp())
  .action(async (file: string | undefined, opts) => {
    await run(async () => {
      const options = {
        dryRun: opts.dryRun,
        session: opts.session,
        all: true,
        overwrite: opts.overwrite,
      };
      const archive = file ?? opts.archive;
      if (archive) await importArchiveCommand(getProjectRoot(), archive, options);
      else await importCommand(getProjectRoot(), options);
    });
  });

program
  .command('status')
  .description('Show local sessions, shared sessions, and what is not exported yet')
  .option(
    '-v, --verbose',
    'Also show who exported each shared session, when, and redactions',
    false,
  )
  .action(async (opts) => {
    await run(() => statusCommand(getProjectRoot(), { verbose: opts.verbose }));
  });

program
  .command('init', { hidden: true })
  .description('Optional: set up .claude-shared/ and .gitignore ahead of the first export')
  .action(async () => {
    await run(() => initCommand(getProjectRoot()));
  });

// Default action when no subcommand is given: run `status` and hint at next steps.
program.action(async () => {
  await run(async () => {
    await statusCommand(getProjectRoot());
    console.log(
      '\nNext: `claude-handoff export` to pick a session to share, or `claude-handoff --help`.',
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
