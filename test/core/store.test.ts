import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  canonicalizeProjectRoot,
  findProjectStoreDir,
  getClaudeProjectsDir,
  getOrComputeStoreDir,
  listProjectSessionFiles,
  resolveMainSessionFile,
  sanitizeProjectKey,
} from '../../src/core/store.js';

// Hermetic setup: every test uses a fake HOME under os.tmpdir() so the
// real ~/.claude/ on this machine is never touched. The `store` module
// reads HOME via os.homedir(), which on POSIX honors process.env.HOME.

let tmpHome: string;
let originalHome: string | undefined;

beforeAll(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), 'claude-handoff-store-'));
  await mkdir(join(tmpHome, '.claude', 'projects'), { recursive: true });
  originalHome = process.env.HOME;
  process.env.HOME = tmpHome;
});

afterAll(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await rm(tmpHome, { recursive: true, force: true });
});

// Helper: create a fake project store dir containing one .jsonl with a
// single record that sets `cwd`. Returns the absolute store dir path.
async function seedProjectStore(
  keyName: string,
  cwd: string,
  opts: { sessionId?: string; extraRecords?: Record<string, unknown>[] } = {},
): Promise<string> {
  const storeDir = join(tmpHome, '.claude', 'projects', keyName);
  await mkdir(storeDir, { recursive: true });
  const sessionId = opts.sessionId ?? 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const records = [
    { type: 'user', cwd, sessionId, message: { role: 'user', content: 'hi' } },
    ...(opts.extraRecords ?? []),
  ];
  const jsonl = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  await writeFile(join(storeDir, `${sessionId}.jsonl`), jsonl, 'utf-8');
  return storeDir;
}

// Clean up the fake projects dir between tests so seeding is isolated.
afterEach(async () => {
  const projectsDir = getClaudeProjectsDir();
  await rm(projectsDir, { recursive: true, force: true });
  await mkdir(projectsDir, { recursive: true });
});

describe('sanitizeProjectKey', () => {
  it('matches the historical computeSlug rule', () => {
    expect(sanitizeProjectKey('/home/alice/projects/myapp')).toBe('-home-alice-projects-myapp');
  });

  it('replaces underscores', () => {
    expect(sanitizeProjectKey('/home/alice/my_data_pipeline')).toBe('-home-alice-my-data-pipeline');
  });

  it('replaces parentheses', () => {
    expect(sanitizeProjectKey('/tmp/test (v1)/project')).toBe('-tmp-test--v1--project');
  });

  it('strips a single trailing slash', () => {
    expect(sanitizeProjectKey('/home/alice/myapp/')).toBe('-home-alice-myapp');
  });

  it('normalizes Windows backslashes to forward slashes first', () => {
    expect(sanitizeProjectKey('C:\\Users\\alice\\app')).toBe('C--Users-alice-app');
  });

  it('handles standard Linux path', () => {
    expect(sanitizeProjectKey('/home/neo/work/cool-project')).toBe('-home-neo-work-cool-project');
  });

  it('handles macOS-style path', () => {
    expect(sanitizeProjectKey('/Users/alice/projectx')).toBe('-Users-alice-projectx');
  });

  it('replaces spaces with dashes', () => {
    expect(sanitizeProjectKey('/home/alice/projects/Homework 3')).toBe(
      '-home-alice-projects-Homework-3',
    );
  });

  it('handles short path', () => {
    expect(sanitizeProjectKey('/tmp/test')).toBe('-tmp-test');
  });

  it('handles root path', () => {
    expect(sanitizeProjectKey('/')).toBe('-');
  });

  it('replaces dots with dashes', () => {
    expect(sanitizeProjectKey('/home/user/my.project')).toBe('-home-user-my-project');
  });

  it('handles multiple consecutive spaces', () => {
    expect(sanitizeProjectKey('/home/user/my  project')).toBe('-home-user-my--project');
  });

  it('preserves hyphens in paths', () => {
    expect(sanitizeProjectKey('/home/user/my-project')).toBe('-home-user-my-project');
  });

  it('replaces non-ASCII characters with dashes (day-2 bug regression)', () => {
    expect(sanitizeProjectKey('/home/user/Türkçe/proje_ışık')).toBe('-home-user-T-rk-e-proje----k');
  });

  it('replaces colons with dashes', () => {
    expect(sanitizeProjectKey('/home/user/file:name')).toBe('-home-user-file-name');
  });
});

describe('canonicalizeProjectRoot', () => {
  it('applies Unicode NFC normalization', async () => {
    // Decomposed "ü" (U+0075 + U+0308) vs composed (U+00FC). NFC picks
    // the composed form. We don't need the path to exist to observe
    // this: realpath will fail and we fall back to the NFC-of-input.
    const decomposed = '/tmp/nonexistent-caf\u0065\u0301';
    const canonical = await canonicalizeProjectRoot(decomposed);
    expect(canonical).toBe('/tmp/nonexistent-caf\u00e9');
  });

  it('resolves symlinks when the target exists', async () => {
    const real = join(tmpHome, 'real-project');
    const linked = join(tmpHome, 'linked-project');
    await mkdir(real, { recursive: true });
    await symlink(real, linked);

    const canonical = await canonicalizeProjectRoot(linked);
    expect(canonical).toBe(real);
  });

  it('returns NFC-normalized input when the path does not exist', async () => {
    const p = '/definitely/does/not/exist';
    expect(await canonicalizeProjectRoot(p)).toBe(p);
  });
});

describe('findProjectStoreDir', () => {
  it('finds the store via fast-path key match', async () => {
    await seedProjectStore('-home-alice-projects-myapp', '/home/alice/projects/myapp');
    const result = await findProjectStoreDir('/home/alice/projects/myapp');
    expect(result).toBe(join(tmpHome, '.claude', 'projects', '-home-alice-projects-myapp'));
  });

  it('finds the store via cwd-peek fallback when the key does not match', async () => {
    // Seed a dir whose directory name is not what `sanitizeProjectKey`
    // would produce (simulates slug-rule drift or long-path hashing).
    await seedProjectStore('hashed-key-abc123', '/home/alice/projects/myapp');
    const result = await findProjectStoreDir('/home/alice/projects/myapp');
    expect(result).toBe(join(tmpHome, '.claude', 'projects', 'hashed-key-abc123'));
  });

  it('returns null when nothing matches', async () => {
    await seedProjectStore('-home-alice-projects-other', '/home/alice/projects/other');
    const result = await findProjectStoreDir('/home/alice/projects/missing');
    expect(result).toBeNull();
  });

  it('returns null when projects dir is absent', async () => {
    await rm(getClaudeProjectsDir(), { recursive: true, force: true });
    const result = await findProjectStoreDir('/home/alice/projects/myapp');
    expect(result).toBeNull();
  });

  it('matches through a symlinked project root', async () => {
    const real = join(tmpHome, 'sym-real');
    const linked = join(tmpHome, 'sym-link');
    await mkdir(real, { recursive: true });
    await symlink(real, linked);

    // Claude Code would have stored the realpath.
    await seedProjectStore(sanitizeProjectKey(real), real);

    const result = await findProjectStoreDir(linked);
    expect(result).toBe(join(tmpHome, '.claude', 'projects', sanitizeProjectKey(real)));
  });
});

describe('getOrComputeStoreDir', () => {
  it('returns an existing store when found', async () => {
    await seedProjectStore('-home-alice-projects-myapp', '/home/alice/projects/myapp');
    const result = await getOrComputeStoreDir('/home/alice/projects/myapp');
    expect(result).toBe(join(tmpHome, '.claude', 'projects', '-home-alice-projects-myapp'));
  });

  it('computes a path for a missing project (used on first import)', async () => {
    const result = await getOrComputeStoreDir('/home/alice/projects/brandnew');
    expect(result).toBe(join(tmpHome, '.claude', 'projects', '-home-alice-projects-brandnew'));
  });
});

describe('listProjectSessionFiles', () => {
  it('returns top-level .jsonl files newest first', async () => {
    const storeDir = await seedProjectStore(
      '-home-alice-projects-myapp',
      '/home/alice/projects/myapp',
      { sessionId: 'aaaaaaaa-1111-1111-1111-111111111111' },
    );
    // Seed a second session file and bump its mtime so ordering is
    // deterministic and matches the "newest first" contract.
    const second = join(storeDir, 'bbbbbbbb-2222-2222-2222-222222222222.jsonl');
    await writeFile(
      second,
      JSON.stringify({ type: 'user', cwd: '/home/alice/projects/myapp', sessionId: 'bbbbbbbb' }) +
        '\n',
      'utf-8',
    );
    // Tiny sleep-in-place so the second mtime is strictly later.
    await new Promise((r) => setTimeout(r, 10));
    await writeFile(second, await (await import('node:fs/promises')).readFile(second));

    const result = await listProjectSessionFiles('/home/alice/projects/myapp');
    expect(result.length).toBe(2);
    expect(result[0]).toBe(second); // newest first
  });

  it('returns empty when project not found', async () => {
    const result = await listProjectSessionFiles('/nope');
    expect(result).toEqual([]);
  });
});

describe('resolveMainSessionFile', () => {
  it('finds the session in a given project', async () => {
    const sid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    await seedProjectStore('-home-alice-projects-myapp', '/home/alice/projects/myapp', {
      sessionId: sid,
    });
    const result = await resolveMainSessionFile(sid, '/home/alice/projects/myapp');
    expect(result).toContain(`${sid}.jsonl`);
  });

  it('scans all projects when projectRoot is omitted', async () => {
    const sid = 'cccccccc-dddd-eeee-ffff-000011112222';
    await seedProjectStore('-home-alice-projects-a', '/home/alice/projects/a', {
      sessionId: 'unrelated-1',
    });
    await seedProjectStore('-home-alice-projects-b', '/home/alice/projects/b', {
      sessionId: sid,
    });
    const result = await resolveMainSessionFile(sid);
    expect(result).toContain(`${sid}.jsonl`);
    expect(result).toContain('-home-alice-projects-b');
  });

  it('returns null when the session is not present', async () => {
    const result = await resolveMainSessionFile('never-seen-id');
    expect(result).toBeNull();
  });
});
