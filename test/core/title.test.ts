import { describe, it, expect } from 'vitest';
import {
  stripLeadingControlBlocks,
  titleFromRecord,
  titleFromUserText,
  TITLE_MAX_LENGTH,
  truncateTitle,
} from '../../src/core/title.js';
import { sessionTitle } from '../../src/core/session.js';
import type { SessionRecord } from '../../src/core/session.js';

const user = (content: unknown, extra: Record<string, unknown> = {}): SessionRecord =>
  ({ type: 'user', sessionId: 's', message: { role: 'user', content }, ...extra }) as SessionRecord;

describe('stripLeadingControlBlocks', () => {
  it('peels off a run of leading control blocks', () => {
    const text =
      '<local-command-caveat>ignore this</local-command-caveat>\n' +
      '<command-name>/model</command-name>\n<command-args></command-args>\n  fix the upload bug';
    expect(stripLeadingControlBlocks(text)).toBe('fix the upload bug');
  });

  it('leaves ordinary text and unknown or unclosed tags alone', () => {
    expect(stripLeadingControlBlocks('why does <div> overflow?')).toBe('why does <div> overflow?');
    expect(stripLeadingControlBlocks('<notes>keep</notes> me')).toBe('<notes>keep</notes> me');
    expect(stripLeadingControlBlocks('<system-reminder>never closed')).toBe(
      '<system-reminder>never closed',
    );
  });
});

describe('titleFromUserText', () => {
  it('takes the first non-empty line', () => {
    expect(titleFromUserText('\n\n  Add retries to the uploader  \nand tests')).toBe(
      'Add retries to the uploader',
    );
  });

  it('returns the line whole; truncateTitle shortens it for display', () => {
    const line = 'word '.repeat(40).trim();
    expect(titleFromUserText(line)).toBe(line);
    const short = truncateTitle(line);
    expect(short.length).toBeLessThanOrEqual(TITLE_MAX_LENGTH);
    expect(short.endsWith('…')).toBe(true);
    expect(truncateTitle('short')).toBe('short');
  });

  it('returns undefined when only control blocks are present', () => {
    expect(titleFromUserText('<command-name>/clear</command-name>')).toBeUndefined();
    expect(titleFromUserText('   ')).toBeUndefined();
  });
});

describe('titleFromRecord', () => {
  it('reads string content and text blocks', () => {
    expect(titleFromRecord(user('hello there'))).toBe('hello there');
    expect(
      titleFromRecord(user([{ type: 'image' }, { type: 'text', text: 'describe this image' }])),
    ).toBe('describe this image');
  });

  it('ignores tool results, meta records, sidechains and other record types', () => {
    expect(
      titleFromRecord(user([{ type: 'tool_result', tool_use_id: 't', content: 'output' }])),
    ).toBeUndefined();
    expect(titleFromRecord(user('caveat text', { isMeta: true }))).toBeUndefined();
    expect(titleFromRecord(user('subagent prompt', { isSidechain: true }))).toBeUndefined();
    expect(
      titleFromRecord({ type: 'assistant', message: { content: 'hi' } } as SessionRecord),
    ).toBeUndefined();
    expect(titleFromRecord({ type: 'user' } as SessionRecord)).toBeUndefined();
  });
});

describe('sessionTitle precedence', () => {
  it('prefers custom, then AI, then first prompt, then last prompt', () => {
    const all = { customTitle: 'custom', aiTitle: 'ai', firstPrompt: 'first', lastPrompt: 'last' };
    expect(sessionTitle(all)).toBe('custom');
    expect(sessionTitle({ ...all, customTitle: undefined })).toBe('ai');
    expect(sessionTitle({ firstPrompt: 'first', lastPrompt: 'last' })).toBe('first');
    expect(sessionTitle({ lastPrompt: 'last' })).toBe('last');
    expect(sessionTitle({})).toBeUndefined();
  });
});
