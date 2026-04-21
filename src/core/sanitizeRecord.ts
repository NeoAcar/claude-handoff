/**
 * Cross-machine-safe record sanitization.
 *
 * Specific, opt-in transforms applied to session records as they flow
 * through export/import. Kept separate from the path-rewriter + redactor
 * pipeline because these aren't secret removal — they're about keeping a
 * session *loadable* on a different machine.
 */

import type { SessionRecord } from './session.js';

interface AssistantMessage {
  content?: unknown[];
  [key: string]: unknown;
}

/**
 * Drop any `thinking` content block that carries a non-empty signature.
 *
 * Rationale: the signature is produced by the Anthropic API and tied to
 * the originating API key + model. It isn't verified during Claude Code's
 * resume flow, so sessions *load* fine on a different machine. But the
 * first new API turn after resume includes those thinking blocks, and
 * the server rejects stale/mismatched signatures with a 400. The
 * reference Claude Code mitigation strips the whole signature-bearing
 * block rather than rewriting the signature — so do the same. The
 * assistant's user-facing text stays; only the signed thinking chunks
 * go away.
 *
 * Returns a shallow-copied record when anything changed, or the original
 * record reference otherwise so the hot path stays allocation-free.
 */
export function stripThinkingSignatures(record: SessionRecord): SessionRecord {
  if (record.type !== 'assistant') return record;
  const message = (record as { message?: AssistantMessage }).message;
  if (!message || !Array.isArray(message.content)) return record;

  let changed = false;
  const filtered = message.content.filter((item) => {
    if (!isSignedThinkingBlock(item)) return true;
    changed = true;
    return false;
  });

  if (!changed) return record;

  return {
    ...record,
    message: { ...message, content: filtered },
  } as SessionRecord;
}

function isSignedThinkingBlock(item: unknown): boolean {
  if (typeof item !== 'object' || item === null) return false;
  const obj = item as { type?: unknown; signature?: unknown };
  return obj.type === 'thinking' && typeof obj.signature === 'string' && obj.signature.length > 0;
}
