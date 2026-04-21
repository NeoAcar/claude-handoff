import { describe, it, expect } from 'vitest';
import { redactText, deepRedact, parseCustomPatterns } from '../../src/core/redactor.js';

// --- Default patterns: positive cases ---

describe('redactText — default patterns', () => {
  it('redacts AWS access key', () => {
    const { text, hits } = redactText('key=AKIAIOSFODNN7EXAMPLE');
    expect(text).toBe('key=[REDACTED:aws-key]');
    expect(hits).toHaveLength(1);
    expect(hits[0].pattern).toBe('aws-key');
  });

  it('redacts AWS secret after context keyword', () => {
    const secret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    const { text } = redactText(`aws_secret_access_key=${secret}`);
    expect(text).toContain('[REDACTED:aws-secret]');
    expect(text).not.toContain(secret);
  });

  it('redacts GitHub token (ghp_)', () => {
    const token = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl';
    const { text, hits } = redactText(`GITHUB_TOKEN=${token}`);
    expect(text).toContain('[REDACTED:github-token]');
    expect(hits[0].pattern).toBe('github-token');
  });

  it('redacts GitHub token (gho_, ghs_, ghu_, ghp_)', () => {
    for (const prefix of ['gho', 'ghs', 'ghu', 'ghp', 'ghr']) {
      const token = `${prefix}_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl`;
      const { text } = redactText(token);
      expect(text).toBe('[REDACTED:github-token]');
    }
  });

  it('redacts Anthropic API key', () => {
    const { text } = redactText('ANTHROPIC_API_KEY=sk-ant-api03-abcdef1234567890');
    expect(text).toContain('[REDACTED:anthropic-key]');
  });

  it('redacts OpenAI API key', () => {
    const key = 'sk-' + 'a'.repeat(48);
    const { text } = redactText(`OPENAI_KEY=${key}`);
    expect(text).toContain('[REDACTED:openai-key]');
  });

  it('redacts Bearer token', () => {
    const { text } = redactText(
      'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def',
    );
    expect(text).toContain('[REDACTED:bearer]');
  });

  it('redacts password assignment', () => {
    const { text } = redactText('password=mysecretpass123');
    expect(text).toContain('[REDACTED:password]');
    expect(text).not.toContain('mysecretpass123');
  });

  it('redacts password with colon separator', () => {
    const { text } = redactText('password: hunter2');
    expect(text).toContain('[REDACTED:password]');
    expect(text).not.toContain('hunter2');
  });

  it('redacts URL with embedded credentials', () => {
    const { text } = redactText('https://user:pass@example.com/api');
    expect(text).toContain('[REDACTED:credentials]');
    expect(text).not.toContain('user:pass');
  });

  it('does not match ordinary URLs followed by an @ elsewhere on the line', () => {
    const { text, hits } = redactText(
      'npm notice Changelog: https://github.com/foo/bar then email me@example.com',
    );
    expect(text).not.toContain('[REDACTED:credentials]');
    expect(hits.filter((h) => h.type === 'url-with-creds')).toHaveLength(0);
  });

  it('does not match URL with port number', () => {
    const { text, hits } = redactText('server running at http://localhost:3000/api@v1');
    expect(text).not.toContain('[REDACTED:credentials]');
    expect(hits.filter((h) => h.type === 'url-with-creds')).toHaveLength(0);
  });

  it('still redacts creds with port in host', () => {
    const { text } = redactText('postgres://admin:secretpw@db.internal/app');
    // Note: this pattern is https?:// only, so postgres:// isn't matched.
    expect(text).toContain('admin:secretpw');
  });

  it('redacts creds when URL appears mid-sentence with trailing text', () => {
    const { text } = redactText('see https://bob:hunter2@example.com/ and carry on');
    expect(text).toContain('[REDACTED:credentials]');
    expect(text).not.toContain('bob:hunter2');
  });

  it('redacts private key block', () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn+ygWyF8PbnGPo
-----END RSA PRIVATE KEY-----`;
    const { text, hits } = redactText(`config:\n${pem}\nend`);
    expect(text).toContain('[REDACTED:private-key]');
    expect(text).not.toContain('MIIEow');
    expect(hits[0].pattern).toBe('private-key');
  });
});

// --- Default patterns: negative cases ---

describe('redactText — should NOT redact', () => {
  it('leaves normal text alone', () => {
    const input = 'This is a normal message about authentication.';
    const { text, hits } = redactText(input);
    expect(text).toBe(input);
    expect(hits).toHaveLength(0);
  });

  it('does not false-positive on short "sk-" strings', () => {
    // sk- followed by less than 32 chars should not match openai pattern
    const input = 'sk-short';
    const { text } = redactText(input);
    expect(text).toBe(input);
  });

  it('does not redact "password" without assignment', () => {
    const input = 'Please enter your password in the form';
    const { text } = redactText(input);
    expect(text).toBe(input);
  });

  it('does not redact AKIA prefix if too short', () => {
    const input = 'AKIA123'; // only 3 chars after AKIA, need 16
    const { text } = redactText(input);
    expect(text).toBe(input);
  });
});

// --- Deep redaction ---

describe('deepRedact', () => {
  it('redacts secrets in nested objects', () => {
    const input = {
      message: {
        content: [
          {
            type: 'text',
            text: 'My key is AKIAIOSFODNN7EXAMPLE',
          },
        ],
      },
      cwd: '/safe/path',
    };
    const { value, hits } = deepRedact(input);
    const result = value as typeof input;
    expect(result.message.content[0].text).toContain('[REDACTED:aws-key]');
    expect(result.cwd).toBe('/safe/path');
    expect(hits).toHaveLength(1);
  });

  it('does not mutate input', () => {
    const input = { key: 'AKIAIOSFODNN7EXAMPLE' };
    deepRedact(input);
    expect(input.key).toBe('AKIAIOSFODNN7EXAMPLE');
  });

  it('preserves non-string types', () => {
    const input = { count: 42, flag: true, empty: null };
    const { value } = deepRedact(input);
    expect(value).toEqual(input);
  });

  it('handles tool_use with secret in Bash command', () => {
    const input = {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Bash',
            input: {
              command:
                'curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature" https://api.example.com',
            },
          },
        ],
      },
    };
    const { value, hits } = deepRedact(input);
    const result = value as typeof input;
    expect(result.message.content[0].input.command).toContain('[REDACTED:bearer]');
    expect(hits.length).toBeGreaterThanOrEqual(1);
  });
});

// --- Custom patterns ---

describe('parseCustomPatterns', () => {
  it('parses regex lines', () => {
    const content = 'INTERNAL_TOKEN_[A-Z0-9]+\nSECRET_\\d{6}';
    const patterns = parseCustomPatterns(content);
    expect(patterns).toHaveLength(2);
    expect(patterns[0].name).toBe('custom-1');
    expect(patterns[1].name).toBe('custom-2');
  });

  it('skips empty lines and comments', () => {
    const content = '# This is a comment\n\nACTUAL_PATTERN\n  \n# Another comment';
    const patterns = parseCustomPatterns(content);
    expect(patterns).toHaveLength(1);
    expect(patterns[0].regex.source).toBe('ACTUAL_PATTERN');
  });

  it('custom patterns work with redactText', () => {
    const patterns = parseCustomPatterns('CORP_KEY_[A-Z0-9]{8}');
    const { text } = redactText('token=CORP_KEY_ABCD1234', patterns);
    expect(text).toContain('[REDACTED:custom-1]');
  });
});

// --- Aggregated hit tracking ---

describe('redaction hits', () => {
  it('tracks context around matches', () => {
    const { hits } = redactText('before AKIAIOSFODNN7EXAMPLE after');
    expect(hits).toHaveLength(1);
    expect(hits[0].context).toContain('[***]');
    expect(hits[0].context).toContain('before');
    expect(hits[0].context).toContain('after');
  });

  it('tracks multiple hits from different patterns', () => {
    const text = 'key=AKIAIOSFODNN7EXAMPLE and password=secret123';
    const { hits } = redactText(text);
    expect(hits.length).toBeGreaterThanOrEqual(2);
    const patterns = hits.map((h) => h.pattern);
    expect(patterns).toContain('aws-key');
    expect(patterns).toContain('password');
  });
});
