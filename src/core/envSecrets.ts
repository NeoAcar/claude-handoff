/**
 * Secret values the exporting machine already knows about.
 *
 * Pattern redaction only catches secrets with a recognisable shape. A
 * database password or an internal token has none — but its exact value
 * sits in the project's `.env` files and in the environment. This module
 * collects those values so export can remove them wherever they surface
 * in a transcript, as literal matches.
 *
 * Nothing here writes anything, and values never leave memory: callers
 * get redaction patterns, and the key names (not values) for reporting.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { literalPattern } from './redactor.js';
import type { RedactionPattern } from './redactor.js';

export interface EnvEntry {
  key: string;
  value: string;
}

/** A value judged worth scrubbing, with the variable it came from. */
export interface EnvSecret {
  key: string;
  value: string;
}

/** Shortest value we will ever scrub; anything shorter collides with ordinary text. */
const MIN_SECRET_LENGTH = 8;
/** Values under an innocuous key name must be this long and look random. */
const MIN_UNNAMED_SECRET_LENGTH = 20;
const MIN_UNNAMED_SECRET_ENTROPY = 3.5;

/** A purely numeric value is only taken when it is at least this long. */
const MIN_NUMERIC_SECRET_LENGTH = 12;

/** Words that mark a variable as secret when they are a whole `_`-separated part of its name. */
const SECRET_NAME_PARTS = new Set([
  'KEY',
  'APIKEY',
  'SECRET',
  'TOKEN',
  'PASSWORD',
  'PASSWD',
  'PASS',
  'PWD',
  'CREDENTIAL',
  'CREDS',
  'AUTH',
  'PRIVATE',
  'SIGNATURE',
  'SALT',
  'DSN',
  'WEBHOOK',
]);
const SECRET_NAME_PHRASES = /DATABASE_URL|CONNECTION_STRING|CONN_STR/i;

/**
 * Does the variable name say its value is a secret? Whole name parts
 * only, so `AUTHOR` and `KEYBOARD_LAYOUT` don't count while `API_KEYS`
 * and `GITHUB_TOKEN` do.
 */
export function isSecretName(key: string): boolean {
  if (SECRET_NAME_PHRASES.test(key)) return true;
  return key
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .some((part) => SECRET_NAME_PARTS.has(part) || SECRET_NAME_PARTS.has(part.replace(/S$/, '')));
}

/** Name parts that mark an env file as a template holding placeholders, not real values. */
const TEMPLATE_PARTS = new Set(['example', 'sample', 'template', 'dist', 'defaults']);

const SKIPPED_DIRS = new Set([
  'node_modules',
  '.git',
  '.claude-shared',
  '.claude-handoff',
  'dist',
  'build',
  'out',
  'target',
  'vendor',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  '.cache',
]);

const MAX_SCAN_DEPTH = 3;

/** Shell bookkeeping whose names only look secret: `PWD` is a directory, not a password. */
const SHELL_VARIABLES = new Set(['PWD', 'OLDPWD']);

// --- Parsing ---

/**
 * Parse dotenv-style content: `KEY=value`, optional `export `, single or
 * double quotes, `#` comments (full-line, or trailing after an unquoted
 * value). Lines that aren't assignments are ignored.
 */
export function parseEnvFile(content: string): EnvEntry[] {
  const entries: EnvEntry[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    let value = match[2];

    const quote = value[0];
    const quoted = quote === '"' || quote === "'" ? readQuoted(value, quote) : undefined;
    if (quoted !== undefined) {
      value = quoted;
    } else {
      const commentAt = value.search(/\s#/);
      if (commentAt >= 0) value = value.slice(0, commentAt);
      value = value.trim();
    }

    if (value.length > 0) entries.push({ key, value });
  }
  return entries;
}

/**
 * Read a quoted value starting at `text[0]`, up to its closing quote.
 * Double quotes honour backslash escapes, so the result is the value a
 * program would see, not its spelling in the file. Returns undefined if
 * the quote never closes.
 */
function readQuoted(text: string, quote: string): string | undefined {
  let out = '';
  for (let i = 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === quote) return out;
    if (quote === '"' && ch === '\\' && i + 1 < text.length) {
      const next = text[++i];
      out += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
    } else {
      out += ch;
    }
  }
  return undefined;
}

// --- Selection ---

/** Shannon entropy in bits per character. */
export function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Decide which entries are secrets worth scrubbing.
 *
 * A value qualifies when it is at least 8 characters and either its key
 * name says "secret" (`*_TOKEN`, `*_PASSWORD`, `DATABASE_URL`, …) or the
 * value itself looks like generated key material (see `looksRandom`).
 * Booleans, short numbers and filesystem paths never qualify — scrubbing
 * `86400000` or `/usr/local/bin` out of a transcript would wreck it.
 *
 * A URL that embeds a password contributes the password as a secret of
 * its own, since that is the part that tends to resurface alone.
 */
export function selectSecrets(
  entries: EnvEntry[],
  options: { namedKeysOnly?: boolean } = {},
): EnvSecret[] {
  const secrets = new Map<string, EnvSecret>();
  const add = (key: string, value: string) => {
    if (value.length >= MIN_SECRET_LENGTH && !secrets.has(value))
      secrets.set(value, { key, value });
  };

  for (const { key, value } of entries) {
    if (value.length < MIN_SECRET_LENGTH) continue;
    if (/^(?:true|false|null|undefined)$/i.test(value)) continue;
    // Numbers: a 12-digit password is plausible, `86400000` is a setting.
    if (/^[\d.,_-]+$/.test(value) && value.length < MIN_NUMERIC_SECRET_LENGTH) continue;
    if (looksLikePath(value)) continue;

    const named = isSecretName(key);
    const random = !options.namedKeysOnly && looksRandom(value);
    if (!named && !random) continue;

    add(key, value);
    const urlPassword = passwordFromUrl(value);
    if (urlPassword) add(key, urlPassword);
  }

  // Longest first, so a value that contains another is replaced whole.
  return [...secrets.values()].sort((a, b) => b.value.length - a.value.length);
}

/**
 * Does a value under an unremarkable key look like generated key
 * material? Deliberately strict: missing one of these costs little
 * (secret-named keys are taken regardless), while scrubbing a project
 * name or an image tag out of every message costs a lot. So: long, no
 * spaces, not a URL, letters and digits mixed, high entropy, and no
 * word-like run of lowercase letters (`my-application-backend`,
 * `python-3.11-slim-bookworm`).
 */
function looksRandom(value: string): boolean {
  return (
    value.length >= MIN_UNNAMED_SECRET_LENGTH &&
    !/\s/.test(value) &&
    !/^[a-z][a-z0-9+.-]*:\/\//i.test(value) &&
    /\d/.test(value) &&
    /[A-Za-z]/.test(value) &&
    !/[a-z]{6,}/.test(value) &&
    shannonEntropy(value) >= MIN_UNNAMED_SECRET_ENTROPY
  );
}

/**
 * A filesystem path rather than key material: it starts like one, and
 * isn't a base64 secret that merely begins with `/` (base64 has no `-`,
 * `_` or `.`, which real paths nearly always do).
 */
function looksLikePath(value: string): boolean {
  if (!/^(?:[A-Za-z]:[\\/]|\.{0,2}[\\/]|~[\\/])/.test(value)) return false;
  const base64Like =
    value.length >= 30 &&
    /^[A-Za-z0-9+/=]+$/.test(value) &&
    /\d/.test(value) &&
    /[a-z]/.test(value) &&
    /[A-Z]/.test(value);
  return !base64Like;
}

function passwordFromUrl(value: string): string | undefined {
  const match = /^[a-z][a-z0-9+.-]*:\/\/[^:/?#@\s]*:([^@/?#\s]+)@/i.exec(value);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/**
 * Literal redaction patterns for the selected secrets. The marker names
 * the variable, so whoever resumes the session can tell what was there.
 *
 * Each value is also matched in its JSON-escaped and URL-encoded
 * spellings: transcripts embed serialized JSON inside strings, and
 * connection strings percent-encode passwords.
 */
export function envRedactionPatterns(secrets: EnvSecret[]): RedactionPattern[] {
  const patterns: RedactionPattern[] = [];
  const seen = new Set<string>();
  for (const { key, value } of secrets) {
    const spellings = [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value)];
    for (const spelling of spellings) {
      if (seen.has(spelling)) continue;
      seen.add(spelling);
      patterns.push(literalPattern('env-value', spelling, `[REDACTED:env:${key}]`, true));
    }
  }
  return patterns;
}

// --- Discovery ---

/**
 * Is this basename a real env file (`.env`, `.env.local`, `.envrc`,
 * `secrets.env`, …) rather than a template (`.env.example`)?
 */
export function isEnvFileName(name: string): boolean {
  const isEnv =
    name === '.env' || name === '.envrc' || name.startsWith('.env.') || name.endsWith('.env');
  const isTemplate = name
    .toLowerCase()
    .split('.')
    .some((part) => TEMPLATE_PARTS.has(part));
  return isEnv && !isTemplate;
}

/**
 * Find dotenv files under the project root, a few levels deep, skipping
 * dependency and build directories. Returns absolute paths.
 */
export async function findEnvFiles(projectRoot: string): Promise<string[]> {
  const found: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (isEnvFileName(entry.name) && (await isReadableFile(path.join(dir, entry.name)))) {
        found.push(path.join(dir, entry.name));
      } else if (entry.isDirectory() && depth < MAX_SCAN_DEPTH && !SKIPPED_DIRS.has(entry.name)) {
        await walk(path.join(dir, entry.name), depth + 1);
      }
    }
  }

  await walk(projectRoot, 0);
  return found.sort();
}

/** True for a regular file, following a symlink (a linked `.env` is still the project's). */
async function isReadableFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

export interface CollectedEnvSecrets {
  secrets: EnvSecret[];
  /** Dotenv files that were read, relative to the project root. */
  files: string[];
}

/**
 * Gather secrets from the project's dotenv files and from the process
 * environment. The environment is full of long, random-looking values
 * that aren't secret (`LS_COLORS`, session ids), so only variables with a
 * secret-sounding name are taken from it.
 */
export async function collectEnvSecrets(
  projectRoot: string,
  processEnv: Record<string, string | undefined> = process.env,
): Promise<CollectedEnvSecrets> {
  const files = await findEnvFiles(projectRoot);
  const fileEntries: EnvEntry[] = [];
  for (const file of files) {
    try {
      fileEntries.push(...parseEnvFile(await readFile(file, 'utf-8')));
    } catch {
      // Unreadable file: nothing to learn from it.
    }
  }

  const envEntries: EnvEntry[] = [];
  for (const [key, value] of Object.entries(processEnv)) {
    if (value && !SHELL_VARIABLES.has(key)) envEntries.push({ key, value });
  }

  const merged = new Map<string, EnvSecret>();
  for (const s of selectSecrets(fileEntries)) merged.set(s.value, s);
  for (const s of selectSecrets(envEntries, { namedKeysOnly: true })) {
    if (!merged.has(s.value)) merged.set(s.value, s);
  }

  return {
    secrets: [...merged.values()].sort((a, b) => b.value.length - a.value.length),
    files: files.map((f) => path.relative(projectRoot, f).split(path.sep).join('/')),
  };
}
