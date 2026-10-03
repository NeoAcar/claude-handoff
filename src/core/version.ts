/**
 * The tool's own version, read from package.json so `--version` and the
 * manifest's `toolVersion` can't drift from what was published.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const TOOL_VERSION: string = (require('../../package.json') as { version: string }).version;
