import { describe, it, expect } from 'vitest';
import { ActivityCollector } from '../../src/core/activity.js';
import type { SessionRecord } from '../../src/core/session.js';

const assistant = (...blocks: unknown[]): SessionRecord =>
  ({ type: 'assistant', message: { role: 'assistant', content: blocks } }) as SessionRecord;
const user = (content: unknown, extra: Record<string, unknown> = {}): SessionRecord =>
  ({ type: 'user', message: { role: 'user', content }, ...extra }) as SessionRecord;
const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({
  type: 'tool_use',
  id,
  name,
  input,
});
const toolResult = (id: string, isError: boolean) => ({
  type: 'tool_result',
  tool_use_id: id,
  is_error: isError,
  content: 'x',
});

describe('ActivityCollector', () => {
  it('collects edited files from every file-editing tool, once each, in order', () => {
    const c = new ActivityCollector();
    c.add(assistant(toolUse('1', 'Edit', { file_path: '/p/src/a.ts', old_string: 'a' })));
    c.add(assistant(toolUse('2', 'Write', { file_path: '/p/src/b.ts', content: 'b' })));
    c.add(assistant(toolUse('3', 'MultiEdit', { file_path: '/p/src/a.ts', edits: [] })));
    c.add(assistant(toolUse('4', 'NotebookEdit', { notebook_path: '/p/n.ipynb' })));
    c.add(assistant(toolUse('5', 'Read', { file_path: '/p/README.md' })));
    expect(c.result().editedFiles).toEqual(['/p/src/a.ts', '/p/src/b.ts', '/p/n.ipynb']);
  });

  it('counts shell commands, keeps the last five, and counts failures by tool call id', () => {
    const c = new ActivityCollector();
    for (let i = 1; i <= 7; i++)
      c.add(assistant(toolUse(`b${i}`, 'Bash', { command: `cmd ${i}` })));
    c.add(user([toolResult('b6', true), toolResult('b7', false)]));
    c.add(user([toolResult('not-a-bash-call', true)]));
    const result = c.result();
    expect(result.commands).toBe(7);
    expect(result.failedCommands).toBe(1);
    expect(result.lastCommands).toEqual(['cmd 3', 'cmd 4', 'cmd 5', 'cmd 6', 'cmd 7']);
  });

  it('counts real user requests and remembers the last one', () => {
    const c = new ActivityCollector();
    c.add(user('first ask'));
    c.add(user('<command-name>/clear</command-name>'));
    c.add(user('injected', { isMeta: true }));
    c.add(user([toolResult('x', false)]));
    c.add(user('second ask\nwith detail'));
    expect(c.result()).toMatchObject({ userTurns: 2, lastAsk: 'second ask' });
  });

  it('ignores malformed content', () => {
    const c = new ActivityCollector();
    c.add({ type: 'assistant' } as SessionRecord);
    c.add({ type: 'assistant', message: { content: 'text' } } as SessionRecord);
    c.add(assistant(null, { type: 'tool_use', name: 'Edit', input: { file_path: 3 } }));
    expect(c.result()).toEqual({
      editedFiles: [],
      commands: 0,
      failedCommands: 0,
      lastCommands: [],
      userTurns: 0,
      lastAsk: undefined,
    });
  });
});
