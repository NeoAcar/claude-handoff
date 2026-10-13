import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  collectEnvSecrets,
  envRedactionPatterns,
  findEnvFiles,
  isEnvFileName,
  parseEnvFile,
  selectSecrets,
  shannonEntropy,
} from '../../src/core/envSecrets.js';
import { redactText } from '../../src/core/redactor.js';

describe('parseEnvFile', () => {
  it('parses plain, exported and quoted assignments', () => {
    const entries = parseEnvFile(
      [
        '# comment',
        'PLAIN=value1',
        'export EXPORTED=value2',
        'DOUBLE="has spaces # not a comment"',
        "SINGLE='single quoted'",
        'TRAILING=abc123 # trailing comment',
        'SPACED = padded',
        'EMPTY=',
        'not an assignment',
      ].join('\n'),
    );
    expect(entries).toEqual([
      { key: 'PLAIN', value: 'value1' },
      { key: 'EXPORTED', value: 'value2' },
      { key: 'DOUBLE', value: 'has spaces # not a comment' },
      { key: 'SINGLE', value: 'single quoted' },
      { key: 'TRAILING', value: 'abc123' },
      { key: 'SPACED', value: 'padded' },
    ]);
  });

  it('handles CRLF line endings', () => {
    expect(parseEnvFile('A=one\r\nB=two\r\n')).toEqual([
      { key: 'A', value: 'one' },
      { key: 'B', value: 'two' },
    ]);
  });
});

describe('selectSecrets', () => {
  const keys = (entries: Array<{ key: string; value: string }>, namedKeysOnly = false) =>
    selectSecrets(entries, { namedKeysOnly }).map((s) => s.key);

  it('takes values under secret-sounding keys', () => {
    expect(
      keys([
        { key: 'DB_PASSWORD', value: 'correct-horse' },
        { key: 'STRIPE_SECRET_KEY', value: 'whatever-it-is' },
        { key: 'SESSION_TOKEN', value: 'abcdefgh' },
      ]),
    ).toEqual(['STRIPE_SECRET_KEY', 'DB_PASSWORD', 'SESSION_TOKEN']);
  });

  it('skips short values, numbers, booleans and paths even under secret keys', () => {
    expect(
      keys([
        { key: 'API_KEY', value: 'short' },
        { key: 'TOKEN_TTL', value: '86400000' },
        { key: 'AUTH_ENABLED', value: 'false' },
        { key: 'PRIVATE_KEY_PATH', value: '/etc/ssl/private/server.key' },
        { key: 'KEY_FILE', value: './secrets/key.pem' },
      ]),
    ).toEqual([]);
  });

  it('takes long random values under innocuous keys, but not ordinary settings', () => {
    expect(
      keys([
        { key: 'SOMETHING', value: 'q7Zp2Lx9Vb4Nc8Rt1Wy6Ku3J' },
        { key: 'NODE_ENV', value: 'development' },
        { key: 'APP_NAME', value: 'my-application-backend' },
        { key: 'BASE_IMAGE', value: 'python-3.11.4-slim-bookworm' },
        { key: 'GREETING', value: 'hello there general kenobi friend' },
        { key: 'PUBLIC_URL', value: 'https://example.com/some/long/path/here' },
      ]),
    ).toEqual(['SOMETHING']);
  });

  it('ignores innocuous keys entirely with namedKeysOnly', () => {
    expect(keys([{ key: 'SOMETHING', value: 'q7Zp2Lx9Vb4Nc8Rt1Wy6Ku3J' }], true)).toEqual([]);
  });

  it('adds the password embedded in a URL as its own secret', () => {
    const secrets = selectSecrets([
      { key: 'DATABASE_URL', value: 'postgres://app:s3cr%40t-pw-9@db.internal:5432/main' },
    ]);
    expect(secrets.map((s) => s.value)).toEqual([
      'postgres://app:s3cr%40t-pw-9@db.internal:5432/main',
      's3cr@t-pw-9',
    ]);
  });

  it('orders longest first and drops duplicate values', () => {
    const secrets = selectSecrets([
      { key: 'A_TOKEN', value: 'abcdefgh' },
      { key: 'B_TOKEN', value: 'abcdefgh-longer' },
      { key: 'C_TOKEN', value: 'abcdefgh' },
    ]);
    expect(secrets).toEqual([
      { key: 'B_TOKEN', value: 'abcdefgh-longer' },
      { key: 'A_TOKEN', value: 'abcdefgh' },
    ]);
  });
});

describe('shannonEntropy', () => {
  it('is zero for a repeated character and higher for mixed text', () => {
    expect(shannonEntropy('aaaaaaaa')).toBe(0);
    expect(shannonEntropy('abcdefgh')).toBe(3);
  });
});

describe('envRedactionPatterns', () => {
  it('replaces the exact value, case-sensitively, naming the variable', () => {
    const patterns = envRedactionPatterns([{ key: 'DB_PASSWORD', value: 'Tr0ub4dor&3' }]);
    const { text, hits } = redactText('pw is Tr0ub4dor&3, not tr0ub4dor&3', patterns);
    expect(text).toBe('pw is [REDACTED:env:DB_PASSWORD], not tr0ub4dor&3');
    expect(hits.map((h) => h.pattern)).toEqual(['env-value']);
  });

  it('also matches JSON-escaped and URL-encoded spellings', () => {
    const patterns = envRedactionPatterns([{ key: 'API_SECRET', value: 'a"b\\c d/e+f' }]);
    const text = ['raw a"b\\c d/e+f', 'json a\\"b\\\\c d/e+f', 'url a%22b%5Cc%20d%2Fe%2Bf'].join(
      ' | ',
    );
    expect(redactText(text, patterns).text).toBe(
      'raw [REDACTED:env:API_SECRET] | json [REDACTED:env:API_SECRET] | url [REDACTED:env:API_SECRET]',
    );
  });

  it('treats regex metacharacters and $ literally', () => {
    const patterns = envRedactionPatterns([{ key: 'WEIRD_KEY', value: '$1.*(x)+[y]' }]);
    expect(redactText('v=$1.*(x)+[y]; other=$1zzz', patterns).text).toBe(
      'v=[REDACTED:env:WEIRD_KEY]; other=$1zzz',
    );
  });
});

describe('env file discovery', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'claude-handoff-env-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('recognises real dotenv names and rejects templates', () => {
    expect(['.env', '.env.local', '.env.production'].map(isEnvFileName)).toEqual([
      true,
      true,
      true,
    ]);
    expect(
      ['.env.example', '.env.sample', '.env.local.template', '.envrc', 'env', 'a.env'].map(
        isEnvFileName,
      ),
    ).toEqual([false, false, false, false, false, false]);
  });

  it('finds dotenv files in the project but not in dependency directories', async () => {
    await mkdir(join(root, 'apps', 'api'), { recursive: true });
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
    await mkdir(join(root, 'a', 'b', 'c', 'd'), { recursive: true });
    await writeFile(join(root, '.env'), 'A=1');
    await writeFile(join(root, '.env.example'), 'A=placeholder');
    await writeFile(join(root, 'apps', 'api', '.env.local'), 'B=2');
    await writeFile(join(root, 'node_modules', 'pkg', '.env'), 'C=3');
    await writeFile(join(root, 'a', 'b', 'c', 'd', '.env'), 'D=4');

    expect(await findEnvFiles(root)).toEqual([
      join(root, '.env'),
      join(root, 'apps', 'api', '.env.local'),
    ]);
  });

  it('collects secrets from files and only secret-named variables from the environment', async () => {
    await writeFile(
      join(root, '.env'),
      'DB_PASSWORD=hunter2-hunter2\nNODE_ENV=development\nPORT=3000\n',
    );
    const collected = await collectEnvSecrets(root, {
      GITHUB_TOKEN: 'ghx-environment-token-value',
      LS_COLORS: 'rs=0:di=01;34:ln=01;36:mh=00:pi=40;33:so=01;35',
      EMPTY_TOKEN: '',
    });
    expect(collected.files).toEqual(['.env']);
    expect(collected.secrets.map((s) => s.key)).toEqual(['GITHUB_TOKEN', 'DB_PASSWORD']);
  });

  it('returns nothing for a project with no dotenv files and a clean environment', async () => {
    expect(await collectEnvSecrets(root, {})).toEqual({ secrets: [], files: [] });
  });
});
