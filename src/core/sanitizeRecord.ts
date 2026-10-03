/**
 * Cross-machine-safe record sanitization.
 *
 * Specific, opt-in transforms applied to session records as they flow
 * through export/import. Kept separate from the path-rewriter + redactor
 * pipeline because these aren't secret removal — they're about keeping a
 * session *loadable* on a different machine.
 */

import type { SessionRecord } from './session.js';
import { literalPattern } from './redactor.js';
import type { RedactionPattern } from './redactor.js';

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

// --- Account identity ---

/** Account identifiers Claude Code writes into a transcript. */
export interface AccountIdentity {
  emails: string[];
  orgUuids: string[];
}

/** Stand-in for a scrubbed org UUID; keeps the field UUID-shaped. */
export const ORG_UUID_PLACEHOLDER = '00000000-0000-0000-0000-000000000000';

const EMAIL_REGEX = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

/**
 * Pull the account email and organization UUID out of the `attachment`
 * records that carry them (observed on Claude Code 2.1.x):
 *
 *   attachment.type === 'session_context' → attachment.context.userEmail
 *     (a sentence containing the signed-in account's email)
 *   attachment.type === 'credential_org'  → attachment.organizationUuid
 *
 * Neither is a secret the pattern redactor would catch, but both
 * identify the exporting account and would otherwise be committed with
 * the bundle. Returns empty lists for any other record.
 */
export function extractAccountIdentity(record: SessionRecord): AccountIdentity {
  const identity: AccountIdentity = { emails: [], orgUuids: [] };
  if (record.type !== 'attachment') return identity;
  const attachment = (record as { attachment?: unknown }).attachment;
  if (typeof attachment !== 'object' || attachment === null) return identity;
  const att = attachment as { type?: unknown; context?: unknown; organizationUuid?: unknown };

  if (att.type === 'session_context' && typeof att.context === 'object' && att.context !== null) {
    const userEmail = (att.context as { userEmail?: unknown }).userEmail;
    if (typeof userEmail === 'string') {
      identity.emails.push(...(userEmail.match(EMAIL_REGEX) ?? []));
    }
  }
  if (
    att.type === 'credential_org' &&
    typeof att.organizationUuid === 'string' &&
    att.organizationUuid.length > 0 &&
    att.organizationUuid !== ORG_UUID_PLACEHOLDER
  ) {
    identity.orgUuids.push(att.organizationUuid);
  }
  return identity;
}

/**
 * Turn an identity into literal redaction patterns, so the values are
 * scrubbed wherever they appear in the bundle (the same email is also
 * baked into the record's `rendered` text) and show up in the
 * redaction log like any other hit.
 */
export function identityRedactionPatterns(identity: AccountIdentity): RedactionPattern[] {
  return [
    ...identity.emails.map((e) => literalPattern('account-email', e, '[REDACTED:account-email]')),
    ...identity.orgUuids.map((o) => literalPattern('account-org', o, ORG_UUID_PLACEHOLDER)),
  ];
}
