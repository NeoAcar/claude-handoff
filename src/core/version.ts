/**
 * The tool's own version, read from package.json so `--version` and the
 * manifest's `toolVersion` can't drift from what was published.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const TOOL_VERSION: string = (require('../../package.json') as { version: string }).version;

/**
 * Bundles written by a version older than this (or by one that didn't
 * record its version at all) are rewritten on the next export even if
 * the session is unchanged. Raise it whenever export starts removing
 * something it used to let through — 0.2.1 began scrubbing the account
 * email and org UUID, and 0.2.2 is the first version that stamps bundles.
 */
export const REFRESH_BUNDLES_BEFORE = '0.2.2';

/** True when `version` is missing or sorts before `baseline` (numeric x.y.z). */
export function isOlderVersion(version: string | undefined, baseline: string): boolean {
  if (!version) return true;
  const a = version.split('.').map((n) => parseInt(n, 10) || 0);
  const b = baseline.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff < 0;
  }
  return false;
}
