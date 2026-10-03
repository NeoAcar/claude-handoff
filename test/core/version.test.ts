import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TOOL_VERSION } from '../../src/core/version.js';

describe('TOOL_VERSION', () => {
  it('matches package.json', async () => {
    const pkgPath = join(import.meta.dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(await readFile(pkgPath, 'utf-8')) as { version: string };
    expect(TOOL_VERSION).toBe(pkg.version);
  });
});
