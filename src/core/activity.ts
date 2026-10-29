/**
 * What a session actually did, read from its transcript rather than from
 * anything the model wrote about itself: the files it edited, the shell
 * commands it ran and how many failed, and what the user last asked.
 *
 * Tool names and input fields as recorded by Claude Code 2.1.x:
 * `Edit` / `Write` / `MultiEdit` carry `input.file_path`, `NotebookEdit`
 * carries `input.notebook_path`, `Bash` carries `input.command`; a
 * failed tool call comes back as a `tool_result` block with
 * `is_error: true`.
 */

import type { SessionRecord } from './session.js';
import { titleFromRecord } from './title.js';

export interface SessionActivity {
  /** Absolute paths, in the order first edited. */
  editedFiles: string[];
  /** Shell commands run. */
  commands: number;
  /** Of those, how many came back as errors. */
  failedCommands: number;
  /** The last few commands, oldest first. */
  lastCommands: string[];
  /** Real user turns (not tool results or injected context). */
  userTurns: number;
  /** First line of the last thing the user asked. */
  lastAsk?: string;
}

const FILE_TOOLS: Record<string, string> = {
  Edit: 'file_path',
  Write: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
};
const SHELL_TOOLS = new Set(['Bash']);
const LAST_COMMANDS = 5;

interface Block {
  type?: unknown;
  id?: unknown;
  name?: unknown;
  input?: Record<string, unknown>;
  tool_use_id?: unknown;
  is_error?: unknown;
}

/** Accumulates activity one record at a time, so it can ride along a streaming read. */
export class ActivityCollector {
  private readonly edited = new Set<string>();
  private readonly shellCalls = new Set<string>();
  private commands = 0;
  private failedCommands = 0;
  private lastCommands: string[] = [];
  private userTurns = 0;
  private lastAsk: string | undefined;

  add(record: SessionRecord): void {
    const content = (record as { message?: { content?: unknown } }).message?.content;
    const blocks = Array.isArray(content) ? (content as Block[]) : [];

    if (record.type === 'assistant') {
      for (const block of blocks) {
        if (block?.type !== 'tool_use' || typeof block.name !== 'string') continue;
        const field = FILE_TOOLS[block.name];
        const filePath = field ? block.input?.[field] : undefined;
        if (typeof filePath === 'string' && filePath.length > 0) this.edited.add(filePath);
        if (SHELL_TOOLS.has(block.name) && typeof block.input?.command === 'string') {
          this.commands++;
          if (typeof block.id === 'string') this.shellCalls.add(block.id);
          this.lastCommands.push(block.input.command.trim());
          if (this.lastCommands.length > LAST_COMMANDS) this.lastCommands.shift();
        }
      }
      return;
    }

    if (record.type !== 'user') return;
    for (const block of blocks) {
      if (
        block?.type === 'tool_result' &&
        block.is_error === true &&
        typeof block.tool_use_id === 'string' &&
        this.shellCalls.has(block.tool_use_id)
      ) {
        this.failedCommands++;
      }
    }
    const ask = titleFromRecord(record);
    if (ask !== undefined) {
      this.userTurns++;
      this.lastAsk = ask;
    }
  }

  result(): SessionActivity {
    return {
      editedFiles: [...this.edited],
      commands: this.commands,
      failedCommands: this.failedCommands,
      lastCommands: [...this.lastCommands],
      userTurns: this.userTurns,
      lastAsk: this.lastAsk,
    };
  }
}
