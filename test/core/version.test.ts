import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isOlderVersion, TOOL_VERSION } from '../../src/core/version.js';

describe('TOOL_VERSION', () => {
  it('matches package.json', async () => {
    const pkgPath = join(import.meta.dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(await readFile(pkgPath, 'utf-8')) as { version: string };
    expect(TOOL_VERSION).toBe(pkg.version);
  });
});

describe('isOlderVersion', () => {
  it('treats a missing version as older', () => {
    expect(isOlderVersion(undefined, '0.2.2')).toBe(true);
  });

  it('compares numerically, not as strings', () => {
    expect(isOlderVersion('0.2.1', '0.2.2')).toBe(true);
    expect(isOlderVersion('0.2.2', '0.2.2')).toBe(false);
    expect(isOlderVersion('0.10.0', '0.2.2')).toBe(false);
    expect(isOlderVersion('1.0', '0.2.2')).toBe(false);
  });
});
