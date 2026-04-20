/**
 * JSONL session file read/write with streaming.
 *
 * Never reads entire files into memory — processes line by line.
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';

// --- Types ---

/** A single record from a session JSONL file. */
export interface SessionRecord {
  type: string;
  sessionId?: string;
  cwd?: string;
  timestamp?: string;
  [key: string]: unknown;
}

/** Metadata extracted from a session file by scanning its records. */
export interface SessionMeta {
  sessionId: string;
  filePath: string;
  customTitle?: string;
  lastPrompt?: string;
  firstTimestamp?: string;
  lastTimestamp?: string;
  recordCount: number;
  stats: StreamStats;
}

/**
 * Parse-recovery statistics returned from a streaming read.
 * malformedLines = recoveredLines + skippedLines.
 */
export interface StreamStats {
  malformedLines: number;
  recoveredLines: number;
  skippedLines: number;
}

function emptyStats(): StreamStats {
  return { malformedLines: 0, recoveredLines: 0, skippedLines: 0 };
}

/**
 * Attempt to recover a malformed line by splitting on `}{` boundaries.
 * Returns the recovered records or null if recovery fails.
 *
 * Real-world case: Claude Code sometimes emits two JSON records
 * concatenated without a newline (observed in FinanceAi sessions).
 */
function trySplitConcatenated(line: string): SessionRecord[] | null {
  if (!line.includes('}{')) return null;

  const parts = line.split('}{');
  const rebuilt = parts.map((p, i) => {
    if (parts.length === 1) return p;
    if (i === 0) return p + '}';
    if (i === parts.length - 1) return '{' + p;
    return '{' + p + '}';
  });

  const records: SessionRecord[] = [];
  for (const chunk of rebuilt) {
    try {
      records.push(JSON.parse(chunk) as SessionRecord);
    } catch {
      return null;
    }
  }
  return records;
}

// --- Streaming read ---

/**
 * Stream records from a JSONL file, calling `onRecord` for each line.
 *
 * Malformed lines are handled gracefully:
 *   1. Try recovery by splitting on `}{` (two records concatenated).
 *   2. If that fails, warn and skip the line, continuing with the rest.
 *
 * Returns parse-recovery statistics so callers can surface corruption
 * counts to the user.
 */
export async function streamRecords(
  filePath: string,
  onRecord: (record: SessionRecord, lineNumber: number) => void,
): Promise<StreamStats> {
  const stream = createReadStream(filePath, { encoding: 'utf-8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  const stats = emptyStats();
  let lineNumber = 0;
  for await (const line of rl) {
    lineNumber++;
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    try {
      const record = JSON.parse(trimmed) as SessionRecord;
      onRecord(record, lineNumber);
      continue;
    } catch {
      // fall through to recovery
    }

    stats.malformedLines++;
    const recovered = trySplitConcatenated(trimmed);
    if (recovered) {
      console.warn(
        `Warning: recovered ${recovered.length} concatenated records at ${filePath}:${lineNumber}`,
      );
      stats.recoveredLines++;
      for (const r of recovered) {
        onRecord(r, lineNumber);
      }
    } else {
      console.warn(`Warning: skipping malformed line at ${filePath}:${lineNumber}`);
      stats.skippedLines++;
    }
  }

  return stats;
}

/**
 * Read all records from a JSONL file into an array.
 * Use only for small files or test fixtures — prefer streamRecords for production.
 */
export async function readAllRecords(filePath: string): Promise<SessionRecord[]> {
  const records: SessionRecord[] = [];
  await streamRecords(filePath, (record) => records.push(record));
  return records;
}

/**
 * Extract metadata from a session file by scanning key record types.
 * Does not load the entire file — streams and picks out metadata records.
 */
export async function extractSessionMeta(filePath: string): Promise<SessionMeta> {
  let sessionId: string | undefined;
  let customTitle: string | undefined;
  let lastPrompt: string | undefined;
  let firstTimestamp: string | undefined;
  let lastTimestamp: string | undefined;
  let recordCount = 0;

  const stats = await streamRecords(filePath, (record) => {
    recordCount++;

    if (record.sessionId && !sessionId) {
      sessionId = record.sessionId;
    }

    if (record.timestamp) {
      if (!firstTimestamp) firstTimestamp = record.timestamp;
      lastTimestamp = record.timestamp;
    }

    if (record.type === 'custom-title') {
      customTitle = (record as Record<string, unknown>).customTitle as string | undefined;
    }

    if (record.type === 'last-prompt') {
      lastPrompt = (record as Record<string, unknown>).lastPrompt as string | undefined;
    }
  });

  if (!sessionId) {
    throw new Error(`No sessionId found in ${filePath}`);
  }

  return {
    sessionId,
    filePath,
    customTitle,
    lastPrompt,
    firstTimestamp,
    lastTimestamp,
    recordCount,
    stats,
  };
}

// --- Streaming write ---

/**
 * Write records to a JSONL file, one JSON object per line.
 * Overwrites if file exists.
 */
export async function writeRecords(
  filePath: string,
  records: AsyncIterable<SessionRecord> | Iterable<SessionRecord>,
): Promise<number> {
  const ws = createWriteStream(filePath, { encoding: 'utf-8' });
  let count = 0;

  try {
    for await (const record of records) {
      const line = JSON.stringify(record) + '\n';
      const canContinue = ws.write(line);
      if (!canContinue) {
        await new Promise<void>((resolve) => ws.once('drain', resolve));
      }
      count++;
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      ws.end((err: Error | null | undefined) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  return count;
}

/**
 * Transform a session file: read each record, apply a transform, write to output.
 * This is the core pipeline for export and import.
 */
export async function transformSession(
  inputPath: string,
  outputPath: string,
  transform: (record: SessionRecord) => SessionRecord,
): Promise<{ count: number; stats: StreamStats }> {
  const stats = emptyStats();

  async function* generateTransformed(): AsyncGenerator<SessionRecord> {
    const stream = createReadStream(inputPath, { encoding: 'utf-8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    let lineNumber = 0;
    for await (const line of rl) {
      lineNumber++;
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;

      try {
        const record = JSON.parse(trimmed) as SessionRecord;
        yield transform(record);
        continue;
      } catch {
        // fall through to recovery
      }

      stats.malformedLines++;
      const recovered = trySplitConcatenated(trimmed);
      if (recovered) {
        console.warn(
          `Warning: recovered ${recovered.length} concatenated records at ${inputPath}:${lineNumber}`,
        );
        stats.recoveredLines++;
        for (const r of recovered) {
          yield transform(r);
        }
      } else {
        console.warn(`Warning: skipping malformed line at ${inputPath}:${lineNumber}`);
        stats.skippedLines++;
      }
    }
  }

  const count = await writeRecords(outputPath, generateTransformed());
  return { count, stats };
}

// --- Session discovery ---

/**
 * List all session JSONL files in a slug directory.
 * Returns file paths sorted by modification time (newest first).
 */
export async function listSessionFiles(slugDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(slugDir);
  } catch {
    return [];
  }

  const jsonlFiles = entries.filter((e) => e.endsWith('.jsonl'));
  const withStats = await Promise.all(
    jsonlFiles.map(async (name) => {
      const fullPath = path.join(slugDir, name);
      const s = await stat(fullPath);
      return { path: fullPath, mtime: s.mtimeMs };
    }),
  );

  withStats.sort((a, b) => b.mtime - a.mtime);
  return withStats.map((f) => f.path);
}
