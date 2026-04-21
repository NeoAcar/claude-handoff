import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  streamRecords,
  readAllRecords,
  extractSessionMeta,
  writeRecords,
  transformSession,
  listSessionFiles,
} from '../../src/core/session.js';
import type { SessionRecord } from '../../src/core/session.js';

const fixtureDir = join(import.meta.dirname, '..', 'fixtures', 'sessions');
const sampleSession = join(fixtureDir, 'sample-session.jsonl');
const corruptedSession = join(fixtureDir, 'corrupted-session.jsonl');

describe('streamRecords', () => {
  it('streams all records from fixture', async () => {
    const records: SessionRecord[] = [];
    await streamRecords(sampleSession, (r) => records.push(r));
    expect(records.length).toBe(20);
  });

  it('passes correct line numbers', async () => {
    const lineNumbers: number[] = [];
    await streamRecords(sampleSession, (_, n) => lineNumbers.push(n));
    expect(lineNumbers[0]).toBe(1);
    expect(lineNumbers[lineNumbers.length - 1]).toBe(20);
  });

  it('parses each record as valid JSON with a type field', async () => {
    await streamRecords(sampleSession, (record) => {
      expect(record).toHaveProperty('type');
      expect(typeof record.type).toBe('string');
    });
  });
});

describe('readAllRecords', () => {
  it('returns all 20 records', async () => {
    const records = await readAllRecords(sampleSession);
    expect(records.length).toBe(20);
  });

  it('contains expected record types', async () => {
    const records = await readAllRecords(sampleSession);
    const types = new Set(records.map((r) => r.type));
    expect(types).toContain('user');
    expect(types).toContain('assistant');
    expect(types).toContain('file-history-snapshot');
    expect(types).toContain('queue-operation');
    expect(types).toContain('system');
    expect(types).toContain('last-prompt');
  });
});

describe('extractSessionMeta', () => {
  it('extracts sessionId from fixture', async () => {
    const meta = await extractSessionMeta(sampleSession);
    expect(meta.sessionId).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
  });

  it('extracts lastPrompt', async () => {
    const meta = await extractSessionMeta(sampleSession);
    expect(meta.lastPrompt).toBe('thanks');
  });

  it('counts records', async () => {
    const meta = await extractSessionMeta(sampleSession);
    expect(meta.recordCount).toBe(20);
  });

  it('extracts timestamps', async () => {
    const meta = await extractSessionMeta(sampleSession);
    expect(meta.firstTimestamp).toBeDefined();
    expect(meta.lastTimestamp).toBeDefined();
    // First timestamp should be <= last
    expect(meta.firstTimestamp! <= meta.lastTimestamp!).toBe(true);
  });

  it('sets filePath', async () => {
    const meta = await extractSessionMeta(sampleSession);
    expect(meta.filePath).toBe(sampleSession);
  });
});

describe('writeRecords', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'session-test-'));
  });

  it('writes records to JSONL file', async () => {
    const records: SessionRecord[] = [
      { type: 'user', sessionId: 'test-1', cwd: '/tmp' },
      { type: 'assistant', sessionId: 'test-1', cwd: '/tmp' },
    ];
    const outPath = join(tmpDir, 'write-test.jsonl');
    const count = await writeRecords(outPath, records);
    expect(count).toBe(2);

    const content = await readFile(outPath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).type).toBe('user');
    expect(JSON.parse(lines[1]).type).toBe('assistant');
  });

  it('supports async iterables', async () => {
    async function* gen(): AsyncGenerator<SessionRecord> {
      yield { type: 'user', sessionId: 'async-1' };
      yield { type: 'assistant', sessionId: 'async-1' };
      yield { type: 'last-prompt', sessionId: 'async-1' };
    }
    const outPath = join(tmpDir, 'async-write-test.jsonl');
    const count = await writeRecords(outPath, gen());
    expect(count).toBe(3);
  });

  // Cleanup handled by OS tmp directory
});

describe('transformSession', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'session-transform-'));
  });

  it('transforms all records through a function', async () => {
    const outPath = join(tmpDir, 'transformed.jsonl');
    const { count } = await transformSession(sampleSession, outPath, (record) => ({
      ...record,
      _transformed: true,
    }));
    expect(count).toBe(20);

    const records = await readAllRecords(outPath);
    for (const r of records) {
      expect(r).toHaveProperty('_transformed', true);
    }
  });

  it('preserves record types through identity transform', async () => {
    const outPath = join(tmpDir, 'identity.jsonl');
    await transformSession(sampleSession, outPath, (r) => r);

    const original = await readAllRecords(sampleSession);
    const transformed = await readAllRecords(outPath);
    expect(transformed.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(transformed[i].type).toBe(original[i].type);
    }
  });
});

describe('parse recovery (corrupted session)', () => {
  // Silence the Warning: ... console output in tests
  const origWarn = console.warn;
  beforeAll(() => {
    console.warn = () => {};
  });

  it('does not throw on malformed lines', async () => {
    const records: SessionRecord[] = [];
    await expect(streamRecords(corruptedSession, (r) => records.push(r))).resolves.toBeDefined();
  });

  it('returns stats: 1 recovered line (concatenated), 1 skipped (pure junk)', async () => {
    const stats = await streamRecords(corruptedSession, () => {});
    expect(stats.malformedLines).toBe(2);
    expect(stats.recoveredLines).toBe(1);
    expect(stats.skippedLines).toBe(1);
  });

  it('recovers concatenated records as 2 distinct records', async () => {
    const records: SessionRecord[] = [];
    await streamRecords(corruptedSession, (r) => records.push(r));
    // 3 valid lines (user, assistant, last-prompt) + 2 recovered = 5 records; junk line skipped
    expect(records.length).toBe(5);
    // Find the concatenated pair
    const ns = records.filter((r) => typeof r.n === 'number').map((r) => r.n);
    expect(ns).toEqual([1, 2]);
  });

  it('extractSessionMeta surfaces stats', async () => {
    const meta = await extractSessionMeta(corruptedSession);
    expect(meta.stats.malformedLines).toBe(2);
    expect(meta.stats.recoveredLines).toBe(1);
    expect(meta.stats.skippedLines).toBe(1);
    expect(meta.sessionId).toBe('corrupt-1');
  });

  it('transformSession returns stats alongside count', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'recovery-'));
    const outPath = join(dir, 'out.jsonl');
    const { count, stats } = await transformSession(corruptedSession, outPath, (r) => r);
    expect(count).toBe(5);
    expect(stats.malformedLines).toBe(2);
    expect(stats.recoveredLines).toBe(1);
    expect(stats.skippedLines).toBe(1);
  });

  afterAll(() => {
    console.warn = origWarn;
  });
});

describe('listSessionFiles', () => {
  it('lists JSONL files in fixture directory', async () => {
    const files = await listSessionFiles(fixtureDir);
    expect(files.length).toBeGreaterThanOrEqual(1);
    expect(files.every((f) => f.endsWith('.jsonl'))).toBe(true);
  });

  it('returns empty array for nonexistent directory', async () => {
    const files = await listSessionFiles('/nonexistent/directory');
    expect(files).toEqual([]);
  });
});
