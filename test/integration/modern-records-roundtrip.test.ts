/**
 * Round-trip for the record shapes newer Claude Code versions write
 * (observed on 2.1.288): `ai-title`, the `session_context` /
 * `credential_org` attachments that carry account identity, and the
 * `<sid>/tool-results/` sidecar the transcript references by path.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, cp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { exportCommand } from '../../src/commands/export.js';
import { importCommand } from '../../src/commands/import.js';
import { readManifest } from '../../src/core/manifest.js';
import { extractSessionMeta, sessionTitle } from '../../src/core/session.js';
import { sanitizeProjectKey } from '../../src/core/store.js';

const SESSION_ID = 'modern-1111-2222-3333-444444444444';
const LEGACY_SESSION_ID = 'legacy-1111-2222-3333-444444444444';
const EMAIL = 'alice.example@example.com';
const ORG_UUID = '9f8e7d6c-5b4a-4321-8765-0123456789ab';
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

let scratch: string;
let originalHome: string | undefined;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'claude-handoff-modern-rt-'));
  originalHome = process.env.HOME;
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await rm(scratch, { recursive: true, force: true });
});

async function seedAlice(): Promise<{ home: string; project: string; store: string }> {
  const home = join(scratch, 'alice-home');
  const project = join(home, 'projects', 'fake-project');
  await mkdir(project, { recursive: true });

  const store = join(home, '.claude', 'projects', sanitizeProjectKey(project));
  const toolResults = join(store, SESSION_ID, 'tool-results');
  await mkdir(toolResults, { recursive: true });

  const base = { sessionId: SESSION_ID, cwd: project, version: '2.1.288' };
  const emailSentence = `The user's email address is ${EMAIL}. Use it only to identify the user.`;
  const records = [
    { type: 'mode', mode: 'normal', sessionId: SESSION_ID },
    {
      ...base,
      type: 'attachment',
      uuid: 'u1',
      parentUuid: null,
      timestamp: '2026-10-03T09:00:00.000Z',
      attachment: { type: 'session_context', context: { userEmail: emailSentence } },
      rendered: [{ role: 'user', content: `<system-reminder>${emailSentence}</system-reminder>` }],
    },
    {
      ...base,
      type: 'attachment',
      uuid: 'u2',
      parentUuid: 'u1',
      timestamp: '2026-10-03T09:00:01.000Z',
      attachment: { type: 'credential_org', organizationUuid: ORG_UUID },
    },
    {
      ...base,
      type: 'user',
      uuid: 'u3',
      parentUuid: 'u2',
      timestamp: '2026-10-03T09:00:02.000Z',
      message: {
        role: 'user',
        content: `Output too large. Full output saved to: ${join(toolResults, 'abc123.txt')}`,
      },
    },
    { type: 'ai-title', aiTitle: `Modern record shapes for ${EMAIL}`, sessionId: SESSION_ID },
    { type: 'last-prompt', lastPrompt: 'do the thing', leafUuid: 'u3', sessionId: SESSION_ID },
  ];
  await writeFile(
    join(store, `${SESSION_ID}.jsonl`),
    records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf-8',
  );

  await writeFile(
    join(toolResults, 'abc123.txt'),
    `ls ${project}/src\nowner ${EMAIL}\nkey AKIAIOSFODNN7EXAMPLE\n`,
    'utf-8',
  );
  await writeFile(join(toolResults, 'image.bin'), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));

  // An older-style session with no identity records of its own, which
  // still mentions the account email (in a different case).
  const legacy = [
    {
      type: 'user',
      sessionId: LEGACY_SESSION_ID,
      cwd: project,
      uuid: 'l1',
      parentUuid: null,
      timestamp: '2026-04-20T09:00:00.000Z',
      message: { role: 'user', content: `commit as ${EMAIL.toUpperCase()}` },
    },
  ];
  await writeFile(
    join(store, `${LEGACY_SESSION_ID}.jsonl`),
    legacy.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf-8',
  );

  return { home, project, store };
}

describe('modern record shapes round-trip', () => {
  it('prefers ai-title over the last prompt', async () => {
    const alice = await seedAlice();
    const meta = await extractSessionMeta(join(alice.store, `${SESSION_ID}.jsonl`));
    expect(meta.aiTitle).toBe(`Modern record shapes for ${EMAIL}`);
    expect(sessionTitle(meta)).toBe(`Modern record shapes for ${EMAIL}`);
    expect(sessionTitle({ ...meta, customTitle: 'Mine' })).toBe('Mine');
    expect(meta.identity).toEqual({ emails: [EMAIL], orgUuids: [ORG_UUID] });
  });

  it('scrubs account identity and carries tool-results across machines', async () => {
    const alice = await seedAlice();
    process.env.HOME = alice.home;

    await exportCommand(alice.project, {
      dryRun: false,
      noRedact: false,
      iKnowWhatImDoing: false,
    });

    const sharedDir = join(alice.project, '.claude-shared');
    const bundleDir = join(sharedDir, 'sessions', SESSION_ID);

    // Identity is gone from the transcript, including the `rendered` copy.
    const mainBundle = await readFile(join(bundleDir, 'main.jsonl'), 'utf-8');
    expect(mainBundle).not.toContain(EMAIL);
    expect(mainBundle).not.toContain(ORG_UUID);
    expect(mainBundle).toContain('[REDACTED:account-email]');
    expect(mainBundle).toContain(NIL_UUID);
    expect(mainBundle).toContain(`{{CLAUDE_STORE}}/${SESSION_ID}/tool-results/abc123.txt`);

    // The tool result travels, path-rewritten and redacted like the transcript.
    const toolBundle = await readFile(join(bundleDir, 'tool-results', 'abc123.txt'), 'utf-8');
    expect(toolBundle).toContain('ls {{PROJECT_ROOT}}/src');
    expect(toolBundle).not.toContain(EMAIL);
    expect(toolBundle).toContain('[REDACTED:aws-key]');

    // A session without identity records is scrubbed with what the others revealed.
    const legacyBundle = await readFile(
      join(sharedDir, 'sessions', LEGACY_SESSION_ID, 'main.jsonl'),
      'utf-8',
    );
    expect(legacyBundle.toLowerCase()).not.toContain(EMAIL);
    expect(legacyBundle).toContain('commit as [REDACTED:account-email]');

    const manifest = await readManifest(sharedDir);
    const entry = manifest!.sessions.find((s) => s.sessionId === SESSION_ID)!;
    expect(entry.title).toBe('Modern record shapes for [REDACTED:account-email]');
    expect(await readFile(join(bundleDir, 'metadata.json'), 'utf-8')).not.toContain(EMAIL);
    const kinds = entry.artifacts.map((a) => `${a.kind}:${a.bundlePath}`);
    expect(kinds).toEqual(['transcript:main.jsonl', 'tool-result:tool-results/abc123.txt']);

    // --- Neo side ---
    const neoHome = join(scratch, 'neo-home');
    const neoProject = join(neoHome, 'work', 'fake-project');
    await mkdir(neoProject, { recursive: true });
    await cp(sharedDir, join(neoProject, '.claude-shared'), { recursive: true });
    process.env.HOME = neoHome;

    await importCommand(neoProject, { dryRun: false, all: true, overwrite: false });

    const neoStore = join(neoHome, '.claude', 'projects', sanitizeProjectKey(neoProject));
    const neoToolResult = join(neoStore, SESSION_ID, 'tool-results', 'abc123.txt');

    // The transcript's pointer and the file it points at agree on Neo's machine.
    const neoMain = await readFile(join(neoStore, `${SESSION_ID}.jsonl`), 'utf-8');
    expect(neoMain).toContain(`Full output saved to: ${neoToolResult}`);
    expect(neoMain).not.toContain('{{CLAUDE_STORE}}');
    expect(await readFile(neoToolResult, 'utf-8')).toContain(`ls ${neoProject}/src`);
  });

  it('keeps identity when redaction is explicitly disabled', async () => {
    const alice = await seedAlice();
    process.env.HOME = alice.home;

    await exportCommand(alice.project, {
      dryRun: false,
      noRedact: true,
      iKnowWhatImDoing: true,
    });

    const mainBundle = await readFile(
      join(alice.project, '.claude-shared', 'sessions', SESSION_ID, 'main.jsonl'),
      'utf-8',
    );
    expect(mainBundle).toContain(EMAIL);
    expect(mainBundle).toContain(ORG_UUID);
  });
});
