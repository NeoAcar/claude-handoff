/**
 * Single-file archives of a `.claude-shared/` tree.
 *
 * For handoffs that don't go through a shared repo: the same bundle
 * export writes, packed into one gzip-compressed tar file that can be
 * sent any way the user likes. Plain `tar tzf` can list it.
 *
 * The first entry is an index with the SHA-256 of every file, checked on
 * unpack, so a truncated download or a damaged file is refused instead
 * of half-imported. This is an integrity check, not a signature.
 *
 * Both directions stream; nothing is held in memory whole.
 */

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';

export const ARCHIVE_FORMAT = 'claude-handoff-archive';
export const ARCHIVE_VERSION = 1;
export const ARCHIVE_INDEX_NAME = 'handoff-archive.json';

const BLOCK = 512;
/** The index is read into memory whole, so its declared size is capped. */
const MAX_INDEX_BYTES = 16 * 1024 * 1024;

export interface ArchiveIndex {
  format: typeof ARCHIVE_FORMAT;
  version: number;
  toolVersion: string;
  createdAt: string;
  files: Record<string, { sha256: string; size: number }>;
}

// --- Packing ---

/**
 * Pack every file under `sourceDir` into `archivePath`. Returns the index
 * that was written. Fails if the directory is empty.
 */
export async function packArchive(
  sourceDir: string,
  archivePath: string,
  toolVersion: string,
): Promise<ArchiveIndex> {
  const relativePaths = await listFiles(sourceDir);
  if (relativePaths.length === 0) {
    throw new Error('Nothing to archive.');
  }

  const index: ArchiveIndex = {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    toolVersion,
    createdAt: new Date().toISOString(),
    files: {},
  };
  for (const rel of relativePaths) {
    const abs = path.join(sourceDir, ...rel.split('/'));
    index.files[rel] = { sha256: await sha256File(abs), size: (await stat(abs)).size };
  }

  const mtime = Math.floor(Date.now() / 1000);
  async function* tarStream(): AsyncGenerator<Buffer> {
    const indexBody = Buffer.from(JSON.stringify(index, null, 2) + '\n', 'utf-8');
    yield tarHeader(ARCHIVE_INDEX_NAME, indexBody.length, mtime);
    yield indexBody;
    yield padding(indexBody.length);

    for (const rel of relativePaths) {
      const { size } = index.files[rel];
      yield tarHeader(rel, size, mtime);
      let written = 0;
      for await (const chunk of createReadStream(path.join(sourceDir, ...rel.split('/')))) {
        written += (chunk as Buffer).length;
        yield chunk as Buffer;
      }
      if (written !== size) {
        throw new Error(`${rel} changed while it was being archived.`);
      }
      yield padding(size);
    }
    yield Buffer.alloc(BLOCK * 2);
  }

  try {
    // Owner-only: the archive holds conversation content.
    await pipeline(
      Readable.from(tarStream()),
      createGzip(),
      createWriteStream(archivePath, { mode: 0o600 }),
    );
  } catch (err) {
    // Don't leave half an archive behind to be mistaken for a whole one.
    await rm(archivePath, { force: true });
    throw err;
  }
  return index;
}

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel);
      else if (entry.isFile()) out.push(rel);
    }
  }
  await walk(root, '');
  return out.sort();
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function padding(size: number): Buffer {
  return Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);
}

/** Build one ustar header block for a regular file. */
function tarHeader(name: string, size: number, mtime: number): Buffer {
  const { base, prefix } = splitTarName(name);
  const header = Buffer.alloc(BLOCK);
  header.write(base, 0, 100, 'utf-8');
  header.write('0000644\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  header.write(mtime.toString(8).padStart(11, '0') + '\0', 136, 12, 'ascii');
  header.write('        ', 148, 8, 'ascii'); // checksum counted as spaces
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  header.write(prefix, 345, 155, 'utf-8');

  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return header;
}

/** ustar stores a path as name (≤100 bytes) plus an optional prefix (≤155 bytes). */
function splitTarName(name: string): { base: string; prefix: string } {
  if (Buffer.byteLength(name) <= 100) return { base: name, prefix: '' };
  for (let slash = name.indexOf('/'); slash >= 0; slash = name.indexOf('/', slash + 1)) {
    const prefix = name.slice(0, slash);
    const base = name.slice(slash + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(base) <= 100) return { base, prefix };
  }
  throw new Error(`Path is too long to archive: ${name}`);
}

// --- Unpacking ---

/**
 * Unpack `archivePath` into `destDir` and verify every file against the
 * index. Throws — after which the caller should discard `destDir` — if
 * the file isn't one of our archives, is damaged or truncated, or
 * contains anything the index doesn't list.
 */
export async function unpackArchive(archivePath: string, destDir: string): Promise<ArchiveIndex> {
  const file = createReadStream(archivePath);
  const source = createGunzip();
  // pipe() doesn't forward errors; a missing or unreadable file must
  // surface through the stream we iterate.
  file.on('error', (err) => source.destroy(err));
  file.pipe(source);
  const reader = new BlockReader(source);
  let index: ArchiveIndex | undefined;
  const hashes = new Map<string, string>();

  try {
    for (;;) {
      const header = await reader.read(BLOCK);
      if (header === null || header.every((b) => b === 0)) break;
      if (header.length < BLOCK) throw new Error('truncated header');

      const { name, size } = parseTarHeader(header);
      if (index === undefined) {
        if (name !== ARCHIVE_INDEX_NAME) throw new Error('missing index');
        if (size > MAX_INDEX_BYTES) throw new Error('index too large');
        const body = await reader.read(size);
        if (body === null || body.length < size) throw new Error('truncated index');
        index = parseIndex(body.toString('utf-8'));
      } else {
        if (!Object.hasOwn(index.files, name)) throw new Error(`unexpected file ${name}`);
        const target = safeArchivePath(destDir, name);
        await mkdir(path.dirname(target), { recursive: true });
        const hash = createHash('sha256');
        const handle = await open(target, 'w');
        try {
          let remaining = size;
          while (remaining > 0) {
            const chunk = await reader.read(Math.min(remaining, 64 * 1024));
            if (chunk === null || chunk.length === 0) throw new Error(`truncated file ${name}`);
            hash.update(chunk);
            await handle.write(chunk);
            remaining -= chunk.length;
          }
        } finally {
          await handle.close();
        }
        hashes.set(name, hash.digest('hex'));
      }
      await reader.read((BLOCK - (size % BLOCK)) % BLOCK);
    }
  } catch (err) {
    file.destroy();
    source.destroy();
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${path.basename(archivePath)} is not a usable claude-handoff archive (${reason}).`,
    );
  }

  if (index === undefined) {
    throw new Error(
      `${path.basename(archivePath)} is not a usable claude-handoff archive (empty).`,
    );
  }
  for (const [name, expected] of Object.entries(index.files)) {
    const actual = hashes.get(name);
    if (actual === undefined) {
      throw new Error(`Archive is incomplete: ${name} is missing. Ask for it to be sent again.`);
    }
    if (actual !== expected.sha256) {
      throw new Error(
        `Archive is damaged: ${name} does not match its checksum. Ask for it to be sent again.`,
      );
    }
  }
  return index;
}

function parseIndex(text: string): ArchiveIndex {
  const parsed = JSON.parse(text) as Partial<ArchiveIndex>;
  if (
    parsed.format !== ARCHIVE_FORMAT ||
    typeof parsed.files !== 'object' ||
    parsed.files === null
  ) {
    throw new Error('unrecognised index');
  }
  if (typeof parsed.version !== 'number' || parsed.version > ARCHIVE_VERSION) {
    throw new Error(
      `archive format ${String(parsed.version)} is newer than this claude-handoff understands; upgrade and retry`,
    );
  }
  return parsed as ArchiveIndex;
}

function parseTarHeader(header: Buffer): { name: string; size: number } {
  const stored = parseInt(cString(header, 148, 8).trim(), 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i];
  if (Number.isNaN(stored) || stored !== sum) throw new Error('bad header checksum');

  const type = String.fromCharCode(header[156]);
  if (type !== '0' && type !== '\0') throw new Error('unsupported entry type');

  const base = cString(header, 0, 100);
  const prefix = cString(header, 345, 155);
  const size = parseInt(cString(header, 124, 12).trim(), 8);
  if (Number.isNaN(size) || size < 0) throw new Error('bad size');
  return { name: prefix ? `${prefix}/${base}` : base, size };
}

function cString(buf: Buffer, start: number, length: number): string {
  const slice = buf.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end < 0 ? length : end).toString('utf-8');
}

/**
 * Is this a plain relative path with forward slashes that stays inside
 * whatever directory it is joined to? Used for archive member names and
 * for paths read out of a manifest — both come from another machine.
 */
export function isSafeRelativePath(name: string): boolean {
  return !(
    name.length === 0 ||
    name.startsWith('/') ||
    name.includes('\\') ||
    name.includes('\0') ||
    /^[A-Za-z]:/.test(name) ||
    name.split('/').some((s) => s === '' || s === '.' || s === '..')
  );
}

/**
 * Resolve an archive member name inside `destDir`, refusing anything
 * that could land outside it.
 */
export function safeArchivePath(destDir: string, name: string): string {
  if (!isSafeRelativePath(name)) {
    throw new Error(`unsafe path ${JSON.stringify(name)}`);
  }
  return path.join(destDir, ...name.split('/'));
}

/** Pull exact byte counts out of a chunked stream. */
class BlockReader {
  private readonly iterator: AsyncIterator<Buffer>;
  private buffered: Buffer[] = [];
  private bufferedLength = 0;
  private ended = false;

  constructor(source: AsyncIterable<Buffer>) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  /** Up to `n` bytes; fewer only at end of stream, `null` when nothing is left. */
  async read(n: number): Promise<Buffer | null> {
    if (n === 0) return Buffer.alloc(0);
    while (this.bufferedLength < n && !this.ended) {
      const next = await this.iterator.next();
      if (next.done) {
        this.ended = true;
      } else {
        this.buffered.push(next.value);
        this.bufferedLength += next.value.length;
      }
    }
    if (this.bufferedLength === 0) return null;

    const all = this.buffered.length === 1 ? this.buffered[0] : Buffer.concat(this.buffered);
    const out = all.subarray(0, Math.min(n, all.length));
    const rest = all.subarray(out.length);
    this.buffered = rest.length > 0 ? [rest] : [];
    this.bufferedLength = rest.length;
    return out;
  }
}
