/**
 * Secret detection and redaction.
 *
 * Scans text for known secret patterns and replaces them with
 * [REDACTED:type] placeholders. This is a safety rail, not a guarantee.
 */

// --- Pattern definitions ---

export interface RedactionPattern {
  name: string;
  regex: RegExp;
  replacement: string;
}

const DEFAULT_PATTERNS: RedactionPattern[] = [
  {
    name: 'aws-key',
    regex: /AKIA[0-9A-Z]{16}/g,
    replacement: '[REDACTED:aws-key]',
  },
  {
    name: 'aws-secret',
    regex:
      /(?<=(?:aws_secret_access_key|aws_secret|secret_key)\s{0,10}[:=]\s{0,10})[A-Za-z0-9/+=]{40}/gi,
    replacement: '[REDACTED:aws-secret]',
  },
  {
    name: 'github-token',
    regex: /gh[pousr]_[A-Za-z0-9]{36,}/g,
    replacement: '[REDACTED:github-token]',
  },
  {
    name: 'github-pat',
    // Fine-grained personal access tokens.
    regex: /github_pat_[A-Za-z0-9_]{30,}/g,
    replacement: '[REDACTED:github-pat]',
  },
  {
    name: 'anthropic-key',
    regex: /sk-ant-[A-Za-z0-9_-]+/g,
    replacement: '[REDACTED:anthropic-key]',
  },
  {
    name: 'openai-key',
    // Legacy keys are `sk-` + 32+ alphanumerics. Project / service-account /
    // admin keys carry a prefix and use `-` and `_` in the body.
    regex: /sk-(?:(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}|[A-Za-z0-9]{32,})/g,
    replacement: '[REDACTED:openai-key]',
  },
  {
    name: 'google-api-key',
    regex: /AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g,
    replacement: '[REDACTED:google-api-key]',
  },
  {
    name: 'slack-token',
    regex: /xox[a-z]-[A-Za-z0-9-]{10,}/g,
    replacement: '[REDACTED:slack-token]',
  },
  {
    name: 'slack-webhook',
    regex: /hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{20,}/g,
    replacement: 'hooks.slack.com/services/[REDACTED:slack-webhook]',
  },
  {
    name: 'bearer',
    regex: /[Bb]earer [A-Za-z0-9._-]{20,}/g,
    replacement: 'Bearer [REDACTED:bearer]',
  },
  {
    name: 'password',
    regex: /(?<=(?:password|passwd|pwd)\s{0,10}[:=]\s{0,10})\S+/gi,
    replacement: '[REDACTED:password]',
  },
  {
    name: 'secret-assignment',
    // `api_key = "…"`, `"client_secret": "…"`, `SECRET_KEY=…`, `TOKEN=…`.
    // The value must be 16+ characters and contain a digit, so
    // `token = parseAuthorizationHeader` and other plain identifiers on
    // the right-hand side are left alone. Whitespace runs are bounded:
    // an open-ended \s* inside a lookbehind goes quadratic on long blanks.
    regex:
      /(?<=(?:api[_-]?key|secret|token|access[_-]?key)(?:[_-]?(?:key|id|value))?['"]?\s{0,10}[:=]\s{0,10}['"]?)(?=[A-Za-z0-9._/+-]*\d)[A-Za-z0-9._/+-]{16,}/gi,
    replacement: '[REDACTED:secret]',
  },
  {
    name: 'url-with-creds',
    // Match only true user:pass@host forms. The previous pattern
    // [^:]+:[^@]+@ was too greedy — in a line containing any URL and a later
    // `@` (e.g., email addresses, npm changelog notices), it matched across
    // the whole span and redacted innocuous URLs. Restrict both sides of the
    // colon to non-separator characters so we only catch embedded credentials.
    regex: /https?:\/\/[^:/?#@\s]+:[^@/?#\s]+@/g,
    replacement: 'https://[REDACTED:credentials]@',
  },
  {
    name: 'url-password',
    // Any scheme (postgres://, redis://, amqp://, …): replace only the
    // password, so the reader still sees which service and user it was.
    regex: /(?<=\b[a-z][a-z0-9+.-]{1,20}:\/\/[^:/?#@\s]{1,100}:)[^@/?#\s]+(?=@)/gi,
    replacement: '[REDACTED:credentials]',
  },
  {
    name: 'private-key',
    regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: '[REDACTED:private-key]',
  },
];

// --- Redaction results ---

export interface RedactionHit {
  pattern: string;
  context: string; // ~20 chars before and after, with match masked
}

export interface RedactionResult {
  text: string;
  hits: RedactionHit[];
}

// --- Core redaction ---

/** A match that is nothing but a marker from an earlier export. */
const EXISTING_MARKER = /^\[REDACTED:[^\]\s]*\]$/;

/**
 * Scan text for secrets and return redacted text plus a list of hits.
 */
export function redactText(text: string, customPatterns: RedactionPattern[] = []): RedactionResult {
  // Caller-supplied patterns first: they are the specific ones (a project's
  // own regexes, literal values learned from the session or the machine),
  // so they win the label when two matches are equally long.
  const allPatterns = [...customPatterns, ...DEFAULT_PATTERNS];

  // Every pattern is matched against the ORIGINAL text. Applying them one
  // after another lets an earlier replacement cut a later pattern's match
  // short — `sk-ant-…<env value>…tail` would lose only its head and middle,
  // and the tail would ship.
  const spans: Span[] = [];
  allPatterns.forEach((pattern, order) => {
    const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      if (match[0].length === 0) {
        regex.lastIndex++;
        continue;
      }
      // Text that is already a marker (a re-exported session) stays as is.
      if (EXISTING_MARKER.test(match[0])) continue;
      spans.push({ start: match.index, end: match.index + match[0].length, pattern, order });
    }
  });
  if (spans.length === 0) return { text, hits: [] };

  // Overlapping matches become one redaction covering their union, labelled
  // by the longest match (earliest pattern on a tie).
  spans.sort((a, b) => a.start - b.start || b.end - a.end || a.order - b.order);
  const merged: Span[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.start < last.end) {
      const lastLength = last.labelEnd! - last.labelStart!;
      const spanLength = span.end - span.start;
      if (spanLength > lastLength || (spanLength === lastLength && span.order < last.order)) {
        last.pattern = span.pattern;
        last.order = span.order;
        last.labelStart = span.start;
        last.labelEnd = span.end;
      }
      last.end = Math.max(last.end, span.end);
    } else {
      merged.push({ ...span, labelStart: span.start, labelEnd: span.end });
    }
  }

  const parts: string[] = [];
  const placed: Array<{ pattern: string; start: number; end: number }> = [];
  let cursor = 0;
  let outLength = 0;
  for (const span of merged) {
    const before = text.slice(cursor, span.start);
    parts.push(before, span.pattern.replacement);
    outLength += before.length;
    placed.push({
      pattern: span.pattern.name,
      start: outLength,
      end: outLength + span.pattern.replacement.length,
    });
    outLength += span.pattern.replacement.length;
    cursor = span.end;
  }
  parts.push(text.slice(cursor));
  const result = parts.join('');

  // Context comes from the finished text, so a neighbouring secret shows
  // up in the log as its marker, not in the clear.
  const hits = placed.map(({ pattern, start, end }) => ({
    pattern,
    context:
      result.slice(Math.max(0, start - 20), start) +
      '[***]' +
      result.slice(end, Math.min(result.length, end + 20)),
  }));

  return { text: result, hits };
}

interface Span {
  start: number;
  end: number;
  pattern: RedactionPattern;
  order: number;
  /** Extent of the match that currently supplies the label. */
  labelStart?: number;
  labelEnd?: number;
}

/**
 * Recursively redact all string values in a JSON-compatible structure.
 * Returns the redacted structure and aggregated hits.
 */
export function deepRedact(
  value: unknown,
  customPatterns: RedactionPattern[] = [],
): { value: unknown; hits: RedactionHit[] } {
  const allHits: RedactionHit[] = [];

  function walk(v: unknown): unknown {
    if (typeof v === 'string') {
      const { text, hits } = redactText(v, customPatterns);
      allHits.push(...hits);
      return text;
    }
    if (Array.isArray(v)) {
      return v.map(walk);
    }
    if (v !== null && typeof v === 'object') {
      const result: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        result[k] = walk(val);
      }
      return result;
    }
    return v;
  }

  const redacted = walk(value);
  return { value: redacted, hits: allHits };
}

/**
 * Build a pattern that matches one exact string (no regex semantics).
 * Case-insensitive unless asked otherwise — right for an email address,
 * wrong for a password. Used for values learned from the session or the
 * exporting machine rather than recognised by shape.
 */
export function literalPattern(
  name: string,
  literal: string,
  replacement: string,
  caseSensitive = false,
): RedactionPattern {
  return {
    name,
    regex: new RegExp(literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'g' : 'gi'),
    replacement,
  };
}

/**
 * Parse custom patterns from an ignore-patterns file.
 * Each non-empty, non-comment line is a regex pattern.
 */
export function parseCustomPatterns(content: string): RedactionPattern[] {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line, i) => ({
      name: `custom-${i + 1}`,
      regex: new RegExp(line, 'g'),
      replacement: `[REDACTED:custom-${i + 1}]`,
    }));
}
