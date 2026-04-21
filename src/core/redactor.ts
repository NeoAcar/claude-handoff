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
    regex: /(?<=(?:aws_secret_access_key|aws_secret|secret_key)\s*[:=]\s*)[A-Za-z0-9/+=]{40}/gi,
    replacement: '[REDACTED:aws-secret]',
  },
  {
    name: 'github-token',
    regex: /gh[pousr]_[A-Za-z0-9]{36,}/g,
    replacement: '[REDACTED:github-token]',
  },
  {
    name: 'anthropic-key',
    regex: /sk-ant-[A-Za-z0-9-]+/g,
    replacement: '[REDACTED:anthropic-key]',
  },
  {
    name: 'openai-key',
    regex: /sk-[A-Za-z0-9]{32,}/g,
    replacement: '[REDACTED:openai-key]',
  },
  {
    name: 'bearer',
    regex: /[Bb]earer [A-Za-z0-9._-]{20,}/g,
    replacement: 'Bearer [REDACTED:bearer]',
  },
  {
    name: 'password',
    regex: /(?<=(?:password|passwd|pwd)\s*[:=]\s*)\S+/gi,
    replacement: '[REDACTED:password]',
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

/**
 * Scan text for secrets and return redacted text plus a list of hits.
 */
export function redactText(text: string, customPatterns: RedactionPattern[] = []): RedactionResult {
  const hits: RedactionHit[] = [];
  let result = text;

  const allPatterns = [...DEFAULT_PATTERNS, ...customPatterns];

  for (const pattern of allPatterns) {
    // Reset regex state (global flag)
    const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
    let match: RegExpExecArray | null;

    // First pass: collect hits for the log
    while ((match = regex.exec(result)) !== null) {
      const start = Math.max(0, match.index - 20);
      const end = Math.min(result.length, match.index + match[0].length + 20);
      const before = result.slice(start, match.index);
      const after = result.slice(match.index + match[0].length, end);
      hits.push({
        pattern: pattern.name,
        context: `${before}[***]${after}`,
      });
    }

    // Second pass: replace
    result = result.replace(
      new RegExp(pattern.regex.source, pattern.regex.flags),
      pattern.replacement,
    );
  }

  return { text: result, hits };
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
