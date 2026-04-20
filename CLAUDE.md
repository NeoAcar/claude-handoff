# Project: claude-handoff

A CLI tool that makes Claude Code session context portable between machines via git. Full spec in `SPEC.md` — read it end-to-end before making architectural decisions.

## Commands

```
npm install           # First-time setup
npm run build         # Compile TypeScript to dist/
npm run dev           # Watch mode
npm test              # Run vitest suite
npm run test:fixtures # Round-trip test against fixture session files
npm run lint          # prettier --check + tsc --noEmit
npm run lint:fix      # Auto-fix formatting
```

## Architecture

- TypeScript, Node 20+, ESM modules
- CLI entry: `src/cli.ts` — uses `commander`
- Commands live in `src/commands/{init,export,import,status,list}.ts`
- Core logic in `src/core/`:
  - `paths.ts` — path rewriting (export/import), slug computation
  - `redactor.ts` — secret detection and redaction
  - `session.ts` — JSONL read/write, schema handling
  - `manifest.ts` — `.manifest.json` read/write
- Tests mirror source: `src/core/paths.ts` → `test/core/paths.test.ts`
- No runtime dependency beyond `commander` and native Node APIs unless justified in PR

## Conventions

- All async file I/O uses `fs/promises`, never sync
- Never read entire JSONL files into memory — stream line by line
- All path handling goes through `src/core/paths.ts`; never use raw `path.join` outside that module for project-relative paths
- Errors bubble up to `src/cli.ts` which formats them for humans; do not `console.error` deep in the call stack
- Prefer pure functions in `src/core/` so they're trivial to test
- Filenames are kebab-case, types/classes are PascalCase, functions are camelCase
- No default exports; always named exports

## Watch Out For

**Path rewriting must be path-component aware, not string-replace.**
If the project is named `auth`, do not rewrite the substring "auth" everywhere in the file content. Only rewrite path prefixes that match at a path-component boundary. Test this explicitly.

**The session JSONL schema is undocumented.**
Always inspect a real session file before assuming fields. Do not invent field names. If the schema changes and the tool breaks, that's the honest tradeoff — fail loudly with a clear error, don't guess.

**Redact by default, never by accident.**
`--no-redact` requires a second confirmation flag (`--i-know-what-im-doing`). The redactor's job is to reduce risk, not to guarantee safety — the README must say this clearly.

**Never modify user source files.**
This tool only touches files inside `~/.claude/` and `.claude-shared/`. It must never write to, move, or delete anything in the user's code directories.

**Never auto-commit or auto-stage.**
The tool writes files into `.claude-shared/`. Humans run `git add` and `git commit`. Do not call git from the tool.

**Slug format is OS-specific.**
macOS/Linux use a dash-separated slug; Windows likely differs. Do not ship Windows support without running on Windows. If in doubt, print a clear "platform not tested" warning on startup.

**Dry-run is the default posture for destructive operations.**
`export` and `import` without `--yes` should either prompt for confirmation or default to `--dry-run` and print what would happen. User should never be surprised by a write.

## Testing Philosophy

- Write tests alongside features, not after
- Every function in `src/core/` has unit tests
- Integration tests use fixture JSONL files in `test/fixtures/sessions/`
- At least one end-to-end test simulates Alice → repo → Bob round-trip
- Before claiming a feature works: run it manually against a real `~/.claude/projects/` session and document the result in a PR comment

## Phase 0 Discipline

Before writing any tool code, produce `DISCOVERY.md` documenting:
1. Actual `~/.claude/projects/` structure on this machine
2. Slug format (macOS/Linux/Windows)
3. A real JSONL line schema (redact any secrets in the example)
4. `sessions-index.json` structure
5. Result of the manual round-trip test (copy session → other location → does `/resume` find it?)

**Do not skip this.** The entire tool rests on these assumptions being true. If the manual test in step 5 fails, stop and report — do not try to engineer around it.

## What "Done" Looks Like for the MVP

Alice runs `claude-handoff export`, commits, pushes. Bob pulls, runs `claude-handoff import`, opens Claude Code, `/resume` shows Alice's sessions with their original summaries, and picking one actually restores context. If any step of that flow breaks, the MVP is not done.

## Commit Messages

Format: `<area>: <imperative summary>`
- `paths: rewrite HOME references on export`
- `redactor: add detection for Anthropic API keys`
- `cli: prompt before overwrite on import`

Keep them small. One logical change per commit.