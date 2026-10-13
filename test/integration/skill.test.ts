import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  getSkillPath,
  SKILL_CONTENT,
  SKILL_NAME,
  skillInstallCommand,
} from '../../src/commands/skill.js';

let home: string;
let originalHome: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'claude-handoff-skill-'));
  originalHome = process.env.HOME;
  process.env.HOME = home;
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await rm(home, { recursive: true, force: true });
});

describe('skill install', () => {
  it('writes the skill under the user Claude home and is idempotent', async () => {
    const target = join(home, '.claude', 'skills', SKILL_NAME, 'SKILL.md');
    expect(getSkillPath()).toBe(target);

    await skillInstallCommand({ force: false });
    expect(await readFile(target, 'utf-8')).toBe(SKILL_CONTENT);

    await skillInstallCommand({ force: false }); // no error, no change
    expect(await readFile(target, 'utf-8')).toBe(SKILL_CONTENT);
  });

  it('refuses to clobber an edited skill unless forced', async () => {
    await skillInstallCommand({ force: false });
    const target = getSkillPath();
    await writeFile(target, SKILL_CONTENT + '\nmy own notes\n', 'utf-8');

    await expect(skillInstallCommand({ force: false })).rejects.toThrow(/--force/);
    expect(await readFile(target, 'utf-8')).toContain('my own notes');

    await skillInstallCommand({ force: true });
    expect(await readFile(target, 'utf-8')).toBe(SKILL_CONTENT);
  });
});

describe('skill content', () => {
  it('has the frontmatter Claude Code needs', () => {
    expect(SKILL_CONTENT.startsWith(`---\nname: ${SKILL_NAME}\ndescription: `)).toBe(true);
    expect(SKILL_CONTENT.split('\n---\n').length).toBeGreaterThanOrEqual(2);
  });

  it('keeps the human in charge of git and of turning redaction off', () => {
    expect(SKILL_CONTENT).toContain('Never run `git add`, `git commit` or `git push`');
    expect(SKILL_CONTENT).toContain('Never pass `--no-redact`');
  });

  it('only mentions flags the CLI really has', async () => {
    const cli = await readFile(join(import.meta.dirname, '..', '..', 'src', 'cli.ts'), 'utf-8');
    const flags = new Set(SKILL_CONTENT.match(/--[a-z][a-z-]+/g));
    flags.delete('--resume'); // claude's own flag
    for (const flag of flags) {
      expect(cli, flag).toContain(`'${flag}`);
    }
  });
});
