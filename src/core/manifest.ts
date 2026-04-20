/**
 * .manifest.json read/write for .claude-shared/.
 *
 * Tracks tool version, schema version, and export metadata.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface ManifestEntry {
  sessionId: string;
  originalFilename: string;
  exportedFilename: string;
  author: string;
  exportedAt: string;
  recordCount: number;
  redactionHits: number;
}

export interface Manifest {
  schemaVersion: number;
  toolVersion: string;
  lastExportAt: string;
  sessions: ManifestEntry[];
}

const SCHEMA_VERSION = 1;

export function createEmptyManifest(toolVersion: string): Manifest {
  return {
    schemaVersion: SCHEMA_VERSION,
    toolVersion,
    lastExportAt: new Date().toISOString(),
    sessions: [],
  };
}

export async function readManifest(sharedDir: string): Promise<Manifest | null> {
  const manifestPath = path.join(sharedDir, '.manifest.json');
  try {
    const content = await readFile(manifestPath, 'utf-8');
    return JSON.parse(content) as Manifest;
  } catch {
    return null;
  }
}

export async function writeManifest(sharedDir: string, manifest: Manifest): Promise<void> {
  const manifestPath = path.join(sharedDir, '.manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
}
