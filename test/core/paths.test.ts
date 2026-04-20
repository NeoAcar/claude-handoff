import { describe, it, expect } from 'vitest';
import {
  computeSlug,
  localToPortable,
  portableToLocal,
  deepRewrite,
  PROJECT_ROOT_PLACEHOLDER,
  HOME_PLACEHOLDER,
} from '../../src/core/paths.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Load fixture expected values
const expectedPath = join(
  import.meta.dirname,
  '..',
  'fixtures',
  'sessions',
  'sample-session.expected.json',
);
const expected = JSON.parse(readFileSync(expectedPath, 'utf-8'));

// --- Slug computation ---

describe('computeSlug', () => {
  it('handles standard Linux path', () => {
    expect(computeSlug('/home/bob/work/cool-project')).toBe('-home-bob-work-cool-project');
  });

  it('handles macOS-style path', () => {
    expect(computeSlug('/Users/alice/projectx')).toBe('-Users-alice-projectx');
  });

  it('replaces spaces with dashes (empirically confirmed)', () => {
    expect(computeSlug('/home/neo/Dersler/NLP/Homework 3')).toBe(
      '-home-neo-Dersler-NLP-Homework-3',
    );
  });

  it('handles short path', () => {
    expect(computeSlug('/tmp/test')).toBe('-tmp-test');
  });

  it('strips trailing slash', () => {
    expect(computeSlug('/home/user/project/')).toBe('-home-user-project');
  });

  it('handles root path', () => {
    expect(computeSlug('/')).toBe('-');
  });

  // Fixture-driven slug cases
  for (const c of expected.slug_computation.cases) {
    const label = c._unverified ? `${c.input} (UNVERIFIED hypothesis)` : c.input;
    it(`fixture case: ${label}`, () => {
      expect(computeSlug(c.input)).toBe(c.expected);
    });
  }

  // Edge cases — unverified, document expectations
  it('preserves dots in path components', () => {
    expect(computeSlug('/home/user/my.project')).toBe('-home-user-my.project');
  });

  it('handles multiple consecutive spaces', () => {
    expect(computeSlug('/home/user/my  project')).toBe('-home-user-my--project');
  });

  it('handles Windows-style path with backslashes', () => {
    expect(computeSlug('C:\\Users\\bob\\projectx')).toBe('C:-Users-bob-projectx');
  });

  it('handles path with underscores', () => {
    expect(computeSlug('/home/user/my_project')).toBe('-home-user-my_project');
  });

  it('handles path with hyphens', () => {
    expect(computeSlug('/home/user/my-project')).toBe('-home-user-my-project');
  });

  it('handles non-ASCII characters', () => {
    // Unverified: we assume non-ASCII passes through unchanged
    expect(computeSlug('/home/user/проект')).toBe('-home-user-проект');
  });
});

// --- Path rewriting: local → portable ---

describe('localToPortable', () => {
  const root = '/fake/user/fake-project';
  const home = '/fake/user';

  it('rewrites exact project root', () => {
    expect(localToPortable(root, root, home)).toBe(PROJECT_ROOT_PLACEHOLDER);
  });

  it('rewrites project root followed by subpath', () => {
    expect(localToPortable(`${root}/HW3.ipynb`, root, home)).toBe(
      `${PROJECT_ROOT_PLACEHOLDER}/HW3.ipynb`,
    );
  });

  it('rewrites home directory when not under project root', () => {
    expect(localToPortable('/fake/user/.config/settings', root, home)).toBe(
      `${HOME_PLACEHOLDER}/.config/settings`,
    );
  });

  it('rewrites project root before home (order matters)', () => {
    // The project root is under home. Project root match should win.
    const text = `/fake/user/fake-project/src/main.ts and /fake/user/.bashrc`;
    const result = localToPortable(text, root, home);
    expect(result).toBe(`${PROJECT_ROOT_PLACEHOLDER}/src/main.ts and ${HOME_PLACEHOLDER}/.bashrc`);
  });

  it('does not rewrite partial path matches', () => {
    // /fake/user/fake-project-extra is a DIFFERENT project
    const text = '/fake/user/fake-project-extra/file.ts';
    const result = localToPortable(text, root, home);
    // Should NOT match project root (followed by '-', not '/')
    // But /fake/user IS a valid home prefix match
    expect(result).toBe(`${HOME_PLACEHOLDER}/fake-project-extra/file.ts`);
  });

  it('rewrites path in bash command', () => {
    const cmd = `wc -l "${root}/HW3.ipynb"`;
    expect(localToPortable(cmd, root, home)).toBe(
      `wc -l "${PROJECT_ROOT_PLACEHOLDER}/HW3.ipynb"`,
    );
  });

  it('rewrites path in cd command', () => {
    const cmd = `cd "${root}" && ls`;
    expect(localToPortable(cmd, root, home)).toBe(`cd "${PROJECT_ROOT_PLACEHOLDER}" && ls`);
  });

  it('rewrites multiple occurrences', () => {
    const text = `${root}/a.ts ${root}/b.ts`;
    expect(localToPortable(text, root, home)).toBe(
      `${PROJECT_ROOT_PLACEHOLDER}/a.ts ${PROJECT_ROOT_PLACEHOLDER}/b.ts`,
    );
  });

  it('leaves text without paths unchanged', () => {
    const text = 'Hello, this is a regular message with no paths.';
    expect(localToPortable(text, root, home)).toBe(text);
  });

  it('handles path in JSON-like string', () => {
    const text = `{"file_path":"${root}/src/main.ts"}`;
    expect(localToPortable(text, root, home)).toBe(
      `{"file_path":"${PROJECT_ROOT_PLACEHOLDER}/src/main.ts"}`,
    );
  });

  // Fixture-driven export expectations
  it('fixture: Read tool_use file_path', () => {
    const exp = expected.export.sample_records.line_4_tool_use_read;
    const input = root + '/HW3.ipynb';
    expect(localToPortable(input, root, home)).toBe(exp.input_file_path);
  });

  it('fixture: Bash tool_use command (wc -l)', () => {
    const exp = expected.export.sample_records.line_6_tool_use_bash;
    const input = `wc -l "${root}/HW3.ipynb"`;
    expect(localToPortable(input, root, home)).toBe(exp.input_command);
  });

  it('fixture: Bash tool_result stdout', () => {
    const exp = expected.export.sample_records.line_7_tool_result_bash;
    const input = `1891 ${root}/HW3.ipynb`;
    expect(localToPortable(input, root, home)).toBe(exp.toolUseResult_stdout);
  });

  it('fixture: cwd field', () => {
    expect(localToPortable(root, root, home)).toBe(PROJECT_ROOT_PLACEHOLDER);
  });
});

// --- Path rewriting: portable → local ---

describe('portableToLocal', () => {
  const root = '/home/bob/work/cool-project';
  const home = '/home/bob';

  it('rewrites PROJECT_ROOT placeholder', () => {
    expect(portableToLocal(PROJECT_ROOT_PLACEHOLDER, root, home)).toBe(root);
  });

  it('rewrites PROJECT_ROOT with subpath', () => {
    expect(portableToLocal(`${PROJECT_ROOT_PLACEHOLDER}/HW3.ipynb`, root, home)).toBe(
      `${root}/HW3.ipynb`,
    );
  });

  it('rewrites HOME placeholder', () => {
    expect(portableToLocal(`${HOME_PLACEHOLDER}/.bashrc`, root, home)).toBe(`${home}/.bashrc`);
  });

  it('rewrites both placeholders in one string', () => {
    const text = `${PROJECT_ROOT_PLACEHOLDER}/a.ts and ${HOME_PLACEHOLDER}/.config`;
    expect(portableToLocal(text, root, home)).toBe(`${root}/a.ts and ${home}/.config`);
  });

  it('leaves text without placeholders unchanged', () => {
    const text = 'No placeholders here';
    expect(portableToLocal(text, root, home)).toBe(text);
  });

  // Fixture-driven import expectations
  it('fixture: Read tool_use file_path', () => {
    const exp = expected.import.sample_records.line_4_tool_use_read;
    expect(portableToLocal(`${PROJECT_ROOT_PLACEHOLDER}/HW3.ipynb`, root, home)).toBe(
      exp.input_file_path,
    );
  });

  it('fixture: Bash tool_result stdout', () => {
    const exp = expected.import.sample_records.line_7_tool_result_bash;
    expect(portableToLocal(`1891 ${PROJECT_ROOT_PLACEHOLDER}/HW3.ipynb`, root, home)).toBe(
      exp.toolUseResult_stdout,
    );
  });

  it('fixture: cwd field', () => {
    const exp = expected.import.sample_records.line_2_user_cwd;
    expect(portableToLocal(PROJECT_ROOT_PLACEHOLDER, root, home)).toBe(exp.cwd);
  });
});

// --- Round-trip: local → portable → local ---

describe('round-trip', () => {
  const aliceRoot = '/home/alice/projects/myapp';
  const aliceHome = '/home/alice';
  const bobRoot = '/Users/bob/dev/myapp';
  const bobHome = '/Users/bob';

  it('file path survives export then import', () => {
    const original = `${aliceRoot}/src/index.ts`;
    const portable = localToPortable(original, aliceRoot, aliceHome);
    const imported = portableToLocal(portable, bobRoot, bobHome);
    expect(imported).toBe(`${bobRoot}/src/index.ts`);
  });

  it('bash command survives round-trip', () => {
    const original = `cd "${aliceRoot}" && npm test`;
    const portable = localToPortable(original, aliceRoot, aliceHome);
    const imported = portableToLocal(portable, bobRoot, bobHome);
    expect(imported).toBe(`cd "${bobRoot}" && npm test`);
  });

  it('mixed project + home paths survive round-trip', () => {
    const original = `${aliceRoot}/file.ts and ${aliceHome}/.bashrc`;
    const portable = localToPortable(original, aliceRoot, aliceHome);
    const imported = portableToLocal(portable, bobRoot, bobHome);
    expect(imported).toBe(`${bobRoot}/file.ts and ${bobHome}/.bashrc`);
  });

  it('home-only path survives round-trip', () => {
    const original = `${aliceHome}/.claude/settings.json`;
    const portable = localToPortable(original, aliceRoot, aliceHome);
    const imported = portableToLocal(portable, bobRoot, bobHome);
    expect(imported).toBe(`${bobHome}/.claude/settings.json`);
  });
});

// --- Deep rewrite ---

describe('deepRewrite', () => {
  const rewriter = (s: string) => s.replace('/old/path', '/new/path');

  it('rewrites string values', () => {
    expect(deepRewrite('/old/path/file.ts', rewriter)).toBe('/new/path/file.ts');
  });

  it('rewrites nested object values', () => {
    const input = { cwd: '/old/path', nested: { file: '/old/path/x.ts' } };
    const result = deepRewrite(input, rewriter) as typeof input;
    expect(result.cwd).toBe('/new/path');
    expect(result.nested.file).toBe('/new/path/x.ts');
  });

  it('rewrites array elements', () => {
    const input = ['/old/path/a.ts', '/old/path/b.ts'];
    const result = deepRewrite(input, rewriter) as string[];
    expect(result).toEqual(['/new/path/a.ts', '/new/path/b.ts']);
  });

  it('handles mixed nested structure', () => {
    const input = {
      message: {
        content: [
          { type: 'tool_use', input: { file_path: '/old/path/src/main.ts' } },
          { type: 'text', text: 'See /old/path/README.md' },
        ],
      },
      cwd: '/old/path',
    };
    const result = deepRewrite(input, rewriter) as typeof input;
    expect(result.message.content[0].input.file_path).toBe('/new/path/src/main.ts');
    expect(result.message.content[1].text).toBe('See /new/path/README.md');
    expect(result.cwd).toBe('/new/path');
  });

  it('preserves non-string primitives', () => {
    const input = { count: 42, flag: true, empty: null, cwd: '/old/path' };
    const result = deepRewrite(input, rewriter) as typeof input;
    expect(result.count).toBe(42);
    expect(result.flag).toBe(true);
    expect(result.empty).toBeNull();
    expect(result.cwd).toBe('/new/path');
  });

  it('does not mutate input', () => {
    const input = { cwd: '/old/path' };
    const result = deepRewrite(input, rewriter);
    expect(input.cwd).toBe('/old/path');
    expect((result as typeof input).cwd).toBe('/new/path');
  });
});

// --- Boundary safety: the "auth" problem ---

describe('path-component boundary safety', () => {
  const root = '/home/user/auth';
  const home = '/home/user';

  it('does not rewrite "auth" in "authentication"', () => {
    const text = 'authentication module loaded';
    expect(localToPortable(text, root, home)).toBe(text);
  });

  it('does not rewrite "auth" in "/home/user/auth-service"', () => {
    // auth-service is a DIFFERENT directory than auth
    const text = '/home/user/auth-service/main.ts';
    // home/user/auth is followed by '-' which is a path component char,
    // so it should NOT match as the project root.
    // But /home/user IS a valid match.
    const result = localToPortable(text, root, home);
    expect(result).toBe(`${HOME_PLACEHOLDER}/auth-service/main.ts`);
  });

  it('does rewrite "/home/user/auth" when followed by /', () => {
    const text = '/home/user/auth/controllers/login.ts';
    expect(localToPortable(text, root, home)).toBe(
      `${PROJECT_ROOT_PLACEHOLDER}/controllers/login.ts`,
    );
  });

  it('does rewrite "/home/user/auth" at end of string', () => {
    expect(localToPortable('/home/user/auth', root, home)).toBe(PROJECT_ROOT_PLACEHOLDER);
  });

  it('does rewrite "/home/user/auth" followed by quote', () => {
    const text = '"/home/user/auth"';
    expect(localToPortable(text, root, home)).toBe(`"${PROJECT_ROOT_PLACEHOLDER}"`);
  });

  it('does rewrite "/home/user/auth" followed by space', () => {
    const text = '/home/user/auth is the project';
    expect(localToPortable(text, root, home)).toBe(`${PROJECT_ROOT_PLACEHOLDER} is the project`);
  });
});
