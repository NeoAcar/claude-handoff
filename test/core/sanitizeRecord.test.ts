import { describe, it, expect } from 'vitest';
import {
  extractAccountIdentity,
  identityRedactionPatterns,
  ORG_UUID_PLACEHOLDER,
  stripThinkingSignatures,
} from '../../src/core/sanitizeRecord.js';
import { redactText } from '../../src/core/redactor.js';
import type { SessionRecord } from '../../src/core/session.js';

function assistant(content: unknown[]): SessionRecord {
  return {
    type: 'assistant',
    sessionId: 'test-sid',
    message: { role: 'assistant', content },
  } as SessionRecord;
}

describe('stripThinkingSignatures', () => {
  it('drops a signed thinking block', () => {
    const record = assistant([
      { type: 'thinking', thinking: 'reasoning...', signature: 'EuUBCk...' },
      { type: 'text', text: 'visible answer' },
    ]);
    const out = stripThinkingSignatures(record);
    const content = (out as { message: { content: unknown[] } }).message.content;
    expect(content).toHaveLength(1);
    expect((content[0] as { type: string }).type).toBe('text');
  });

  it('keeps thinking blocks without a signature', () => {
    const record = assistant([
      { type: 'thinking', thinking: 'reasoning...' },
      { type: 'text', text: 'visible' },
    ]);
    const out = stripThinkingSignatures(record);
    const content = (out as { message: { content: unknown[] } }).message.content;
    expect(content).toHaveLength(2);
  });

  it('keeps thinking blocks with an empty-string signature', () => {
    const record = assistant([{ type: 'thinking', thinking: 'x', signature: '' }]);
    const out = stripThinkingSignatures(record);
    const content = (out as { message: { content: unknown[] } }).message.content;
    expect(content).toHaveLength(1);
  });

  it('returns the same object reference when nothing changes', () => {
    const record = assistant([{ type: 'text', text: 'hi' }]);
    expect(stripThinkingSignatures(record)).toBe(record);
  });

  it('leaves non-assistant records alone', () => {
    const user = {
      type: 'user',
      sessionId: 'test-sid',
      message: {
        role: 'user',
        content: [{ type: 'thinking', thinking: 'x', signature: 'nope' }],
      },
    } as SessionRecord;
    expect(stripThinkingSignatures(user)).toBe(user);
  });

  it('handles malformed message gracefully', () => {
    const record = { type: 'assistant', sessionId: 'x' } as SessionRecord;
    expect(stripThinkingSignatures(record)).toBe(record);
  });

  it('strips multiple signed blocks in one record', () => {
    const record = assistant([
      { type: 'thinking', signature: 'a' },
      { type: 'text', text: 'one' },
      { type: 'thinking', signature: 'b' },
      { type: 'tool_use', id: 'tu_1', name: 'Read' },
    ]);
    const out = stripThinkingSignatures(record);
    const content = (out as { message: { content: unknown[] } }).message.content;
    expect(content.map((c) => (c as { type: string }).type)).toEqual(['text', 'tool_use']);
  });
});

describe('extractAccountIdentity', () => {
  const attachment = (a: unknown): SessionRecord =>
    ({ type: 'attachment', sessionId: 'test-sid', attachment: a }) as SessionRecord;

  it('reads the email out of a session_context attachment', () => {
    const record = attachment({
      type: 'session_context',
      context: {
        userEmail: "The user's email address is dev.one+x@mail.example.org. Use it only…",
      },
    });
    expect(extractAccountIdentity(record)).toEqual({
      emails: ['dev.one+x@mail.example.org'],
      orgUuids: [],
    });
  });

  it('reads the org UUID out of a credential_org attachment', () => {
    const record = attachment({ type: 'credential_org', organizationUuid: 'abc-123' });
    expect(extractAccountIdentity(record)).toEqual({ emails: [], orgUuids: ['abc-123'] });
  });

  it('ignores an already-scrubbed org UUID', () => {
    const record = attachment({ type: 'credential_org', organizationUuid: ORG_UUID_PLACEHOLDER });
    expect(extractAccountIdentity(record).orgUuids).toEqual([]);
  });

  it('ignores other attachments, other record types, and malformed shapes', () => {
    const empty = { emails: [], orgUuids: [] };
    expect(extractAccountIdentity(attachment({ type: 'date', date: 'a@b.co' }))).toEqual(empty);
    expect(extractAccountIdentity(attachment(null))).toEqual(empty);
    expect(extractAccountIdentity(attachment({ type: 'session_context' }))).toEqual(empty);
    expect(
      extractAccountIdentity({ type: 'user', message: { content: 'a@b.co' } } as SessionRecord),
    ).toEqual(empty);
  });
});

describe('identityRedactionPatterns', () => {
  it('scrubs the exact email and org UUID, and nothing that merely looks similar', () => {
    const patterns = identityRedactionPatterns({
      emails: ['a.b@example.com'],
      orgUuids: ['1111-2222'],
    });
    const { text, hits } = redactText(
      'mail a.b@example.com / A.B@Example.com / aXb@example.com / org 1111-2222',
      patterns,
    );
    expect(text).toBe(
      `mail [REDACTED:account-email] / [REDACTED:account-email] / aXb@example.com / org ${ORG_UUID_PLACEHOLDER}`,
    );
    expect(hits.map((h) => h.pattern)).toEqual(['account-email', 'account-email', 'account-org']);
  });

  it('returns no patterns for an empty identity', () => {
    expect(identityRedactionPatterns({ emails: [], orgUuids: [] })).toEqual([]);
  });
});
