/**
 * claude-handoff doctor — read-only health check.
 *
 * Reports what the tool can see from this project directory: where the
 * Claude Code sessions are, whether the session format is one we have
 * verified, the state of `.claude-shared/`, and what redaction would
 * work with. Writes nothing.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { collectEnvSecrets } from '../core/envSecrets.js';
import { readManifest } from '../core/manifest.js';
import { parseCustomPatterns } from '../core/redactor.js';
import { extractSessionMeta } from '../core/session.js';
import {
  findProjectStoreDir,
  getClaudeProjectsDir,
  listProjectSessionFiles,
} from '../core/store.js';
import {
  isOlderVersion,
  LAST_VERIFIED_CLAUDE_CODE,
  REFRESH_BUNDLES_BEFORE,
  TOOL_VERSION,
} from '../core/version.js';

export type CheckStatus = 'ok' | 'warn' | 'info';

export interface DoctorCheck {
  status: CheckStatus;
  label: string;
  detail: string;
}

const MIN_NODE_MAJOR = 20;

export async function runDoctor(
  projectRoot: string,
  env: { nodeVersion: string; platform: string } = {
    nodeVersion: process.versions.node,
    platform: process.platform,
  },
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const add = (status: CheckStatus, label: string, detail: string) =>
    checks.push({ status, label, detail });

  // --- Runtime ---
  add('info', 'claude-handoff', TOOL_VERSION);
  const nodeMajor = parseInt(env.nodeVersion.split('.')[0], 10);
  add(
    nodeMajor >= MIN_NODE_MAJOR ? 'ok' : 'warn',
    'Node.js',
    nodeMajor >= MIN_NODE_MAJOR
      ? env.nodeVersion
      : `${env.nodeVersion} — needs ${MIN_NODE_MAJOR} or newer`,
  );
  if (env.platform === 'win32') {
    add('warn', 'Platform', 'Windows is untested; store lookup and path rewriting may be wrong');
  } else {
    add('ok', 'Platform', env.platform);
  }

  // --- Local sessions ---
  const storeDir = await findProjectStoreDir(projectRoot);
  const sessionFiles = await listProjectSessionFiles(projectRoot);
  let identityFound = false;
  if (!storeDir || sessionFiles.length === 0) {
    add(
      'warn',
      'Local sessions',
      `none found for this directory (looked under ${getClaudeProjectsDir()})`,
    );
  } else {
    add('ok', 'Local sessions', `${sessionFiles.length} in ${storeDir}`);

    // sessionFiles is newest-first; the newest readable one tells us
    // which Claude Code wrote the format we are about to parse.
    let newestVersion: string | undefined;
    for (const file of sessionFiles) {
      let meta;
      try {
        meta = await extractSessionMeta(file);
      } catch {
        continue;
      }
      newestVersion ??= meta.claudeCodeVersion;
      if (meta.identity.emails.length > 0 || meta.identity.orgUuids.length > 0) {
        identityFound = true;
      }
    }
    if (!newestVersion) {
      add('info', 'Claude Code', 'version not recorded in the local sessions');
    } else if (isOlderVersion(LAST_VERIFIED_CLAUDE_CODE, newestVersion)) {
      add(
        'warn',
        'Claude Code',
        `${newestVersion} is newer than the last verified version (${LAST_VERIFIED_CLAUDE_CODE}). ` +
          'It will probably work; if a resumed session misbehaves, please open an issue.',
      );
    } else {
      add('ok', 'Claude Code', `${newestVersion} (verified up to ${LAST_VERIFIED_CLAUDE_CODE})`);
    }
  }

  // --- Shared bundles ---
  const sharedDir = path.join(projectRoot, '.claude-shared');
  let manifest;
  let manifestError: string | undefined;
  try {
    manifest = await readManifest(sharedDir);
  } catch (err) {
    manifestError = err instanceof Error ? err.message : String(err);
  }
  if (manifestError) {
    add('warn', 'Shared bundles', `.claude-shared/.manifest.json is unreadable: ${manifestError}`);
  } else if (!manifest) {
    add('info', 'Shared bundles', 'none yet — run `claude-handoff export`');
  } else {
    const stale = manifest.sessions.filter((s) =>
      isOlderVersion(s.exportedWith, REFRESH_BUNDLES_BEFORE),
    ).length;
    add(
      stale > 0 ? 'warn' : 'ok',
      'Shared bundles',
      `${manifest.sessions.length} in .claude-shared/` +
        (stale > 0
          ? ` — ${stale} written by an older claude-handoff; \`export\` will rewrite them with current redaction`
          : ''),
    );
  }

  // --- .gitignore ---
  let gitignore = '';
  try {
    gitignore = await readFile(path.join(projectRoot, '.gitignore'), 'utf-8');
  } catch {
    // no .gitignore
  }
  if (gitignore.includes('.claude-handoff/')) {
    add('ok', '.gitignore', '.claude-handoff/ (local redaction log) is ignored');
  } else {
    add(
      'warn',
      '.gitignore',
      '.claude-handoff/ is not ignored yet — `export` adds it on first use (in a git repository)',
    );
  }

  // --- Redaction inputs ---
  let customCount = 0;
  let customError: string | undefined;
  try {
    const content = await readFile(path.join(projectRoot, '.claude-handoff-ignore'), 'utf-8');
    customCount = parseCustomPatterns(content).length;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      customError = err instanceof Error ? err.message : String(err);
    }
  }
  if (customError) {
    add('warn', 'Custom patterns', `.claude-handoff-ignore could not be used: ${customError}`);
  } else {
    add(
      'info',
      'Custom patterns',
      customCount > 0
        ? `${customCount} in .claude-handoff-ignore`
        : 'none (.claude-handoff-ignore)',
    );
  }

  const collected = await collectEnvSecrets(projectRoot);
  if (collected.secrets.length > 0) {
    const sources = [...collected.files, 'the environment'].join(', ');
    add('ok', 'Known secret values', `${collected.secrets.length} would be scrubbed (${sources})`);
  } else {
    add('info', 'Known secret values', 'none found in .env files or the environment');
  }

  if (identityFound) {
    add('ok', 'Account identity', 'email / organization ID found in sessions; export scrubs them');
  }

  return checks;
}

const MARKS: Record<CheckStatus, string> = { ok: '✓', warn: '!', info: '·' };

export async function doctorCommand(projectRoot: string): Promise<void> {
  const checks = await runDoctor(projectRoot);
  const width = Math.max(...checks.map((c) => c.label.length));
  for (const check of checks) {
    console.log(`${MARKS[check.status]} ${check.label.padEnd(width)}  ${check.detail}`);
  }
  const warnings = checks.filter((c) => c.status === 'warn').length;
  console.log(
    warnings === 0 ? '\nNo problems found.' : `\n${warnings} item(s) need attention (marked !).`,
  );
}
