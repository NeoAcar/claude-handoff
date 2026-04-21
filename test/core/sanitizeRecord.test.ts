import { describe, it, expect } from 'vitest';
import { stripThinkingSignatures } from '../../src/core/sanitizeRecord.js';
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
