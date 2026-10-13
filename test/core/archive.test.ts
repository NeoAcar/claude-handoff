import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  ARCHIVE_INDEX_NAME,
  packArchive,
  safeArchivePath,
  unpackArchive,
} from '../../src/core/archive.js';

let scratch: string;
let source: string;
let archive: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'claude-handoff-archive-'));
  source = join(scratch, 'source');
  archive = join(scratch, 'out.handoff.tgz');
  await mkdir(join(source, 'sessions', 'abc', 'tool-results'), { recursive: true });
  await writeFile(join(source, '.manifest.json'), '{"schemaVersion":2}\n');
  await writeFile(join(source, 'sessions', 'abc', 'main.jsonl'), '{"type":"user"}\n'.repeat(5000));
  await writeFile(join(source, 'sessions', 'abc', 'tool-results', 'empty.txt'), '');
  await writeFile(join(source, 'sessions', 'abc', 'exactly-one-block.bin'), Buffer.alloc(512, 7));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function tree(dir: string, prefix = ''): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(out, await tree(join(dir, entry.name), rel));
    else out[rel] = (await readFile(join(dir, entry.name))).toString('base64');
  }
  return out;
}

describe('archive round-trip', () => {
  it('restores every file byte for byte', async () => {
    const index = await packArchive(source, archive, '9.9.9');
    expect(Object.keys(index.files).sort()).toEqual([
      '.manifest.json',
      'sessions/abc/exactly-one-block.bin',
      'sessions/abc/main.jsonl',
      'sessions/abc/tool-results/empty.txt',
    ]);
    expect((await stat(archive)).size).toBeLessThan(5000); // repetitive content compresses

    const dest = join(scratch, 'dest');
    const unpacked = await unpackArchive(archive, dest);
    expect(unpacked.toolVersion).toBe('9.9.9');
    expect(await tree(dest)).toEqual(await tree(source));
  });

  it('handles paths longer than a tar name field', async () => {
    const deep = join(source, 'sessions', 'a'.repeat(60), 'subagents', 'b'.repeat(70) + '.jsonl');
    await mkdir(join(deep, '..'), { recursive: true });
    await writeFile(deep, 'deep\n');
    await packArchive(source, archive, '1.0.0');
    const dest = join(scratch, 'dest');
    await unpackArchive(archive, dest);
    expect(await tree(dest)).toEqual(await tree(source));
  });

  it('writes a tar that standard tools can list', async () => {
    await packArchive(source, archive, '1.0.0');
    const listing = execFileSync('tar', ['tzf', archive], { encoding: 'utf-8' }).trim().split('\n');
    expect(listing[0]).toBe(ARCHIVE_INDEX_NAME);
    expect(listing).toContain('sessions/abc/main.jsonl');
  });

  it('refuses an empty directory', async () => {
    const empty = join(scratch, 'empty');
    await mkdir(empty);
    await expect(packArchive(empty, archive, '1.0.0')).rejects.toThrow('Nothing to archive');
  });
});

describe('damaged or foreign archives', () => {
  it('rejects a truncated archive', async () => {
    await packArchive(source, archive, '1.0.0');
    const bytes = await readFile(archive);
    await writeFile(archive, bytes.subarray(0, Math.floor(bytes.length / 2)));
    await expect(unpackArchive(archive, join(scratch, 'dest'))).rejects.toThrow(
      /not a usable claude-handoff archive/,
    );
  });

  it('rejects a file that is not gzip', async () => {
    await writeFile(archive, 'just some text, definitely not an archive');
    await expect(unpackArchive(archive, join(scratch, 'dest'))).rejects.toThrow(
      /not a usable claude-handoff archive/,
    );
  });

  it('rejects a tarball that is not ours', async () => {
    execFileSync('tar', ['czf', archive, '-C', source, '.manifest.json']);
    await expect(unpackArchive(archive, join(scratch, 'dest'))).rejects.toThrow(/missing index/);
  });

  it('rejects a missing file with a readable message', async () => {
    await expect(unpackArchive(join(scratch, 'nope.tgz'), join(scratch, 'dest'))).rejects.toThrow(
      /not a usable claude-handoff archive/,
    );
  });

  it('rejects content that no longer matches its checksum', async () => {
    // Re-pack by hand with one file altered after the index was computed.
    const index = await packArchive(source, archive, '1.0.0');
    const staging = join(scratch, 'staging');
    await unpackArchive(archive, staging);
    await writeFile(join(staging, '.manifest.json'), '{"schemaVersion":3}\n');
    await writeFile(join(staging, ARCHIVE_INDEX_NAME), JSON.stringify(index));
    const names = [ARCHIVE_INDEX_NAME, ...Object.keys(index.files)];
    execFileSync('tar', ['--format=ustar', '-czf', archive, '-C', staging, ...names]);
    await expect(unpackArchive(archive, join(scratch, 'dest'))).rejects.toThrow(
      /\.manifest\.json does not match its checksum/,
    );
  });
});

describe('safeArchivePath', () => {
  it('joins ordinary relative paths', () => {
    expect(safeArchivePath('/dest', 'sessions/abc/main.jsonl')).toBe(
      '/dest/sessions/abc/main.jsonl',
    );
  });

  it('refuses anything that could escape the destination', () => {
    for (const name of [
      '../evil',
      'a/../../evil',
      '/etc/passwd',
      'a//b',
      './a',
      'C:/x',
      'a\\b',
      '',
    ]) {
      expect(() => safeArchivePath('/dest', name), name).toThrow(/unsafe path/);
    }
  });
});
