# claude-handoff

Make Claude Code session context portable between machines via git.

When Alice works with Claude Code on a project, all the conversation history, decisions, and accumulated context live in `~/.claude/projects/` — invisible to teammates. **claude-handoff** exports that context into the repo so Neo can import it and pick up exactly where Alice left off.

## How it works

```
# Alice's machine
cd myproject
claude-handoff init            # One-time setup
# ... works with Claude Code ...
claude-handoff export          # Export sessions to .claude-shared/
git add .claude-shared/ && git commit -m "handoff" && git push

# Neo's machine
git pull
claude-handoff import          # Import sessions to ~/.claude/projects/
claude --resume                # Pick Alice's session and continue
```

Alice's sessions appear in Neo's `/resume` picker with their original titles and full conversation history intact.

## Install

```bash
# Local development (from repo)
npm install
npm run build
npm link

# Or run directly
node dist/cli.js <command>
```

## Commands

| Command                 | Description                                     |
| ----------------------- | ----------------------------------------------- |
| `claude-handoff init`   | Create `.claude-shared/`, update `.gitignore`   |
| `claude-handoff export` | Export local sessions to `.claude-shared/`      |
| `claude-handoff import` | Import shared sessions to `~/.claude/projects/` |
| `claude-handoff status` | Show local vs shared sessions                   |
| `claude-handoff list`   | List sessions in `.claude-shared/`              |

### Export options

```
--session <id>      Export one specific session
--last <n>          Export the last N sessions
--since <date>      Only export sessions started on/after this ISO date
--author <name>     Tag with author name (default: git user.name)
--dry-run           Show what would happen, write nothing
--no-redact         Skip redaction (requires --i-know-what-im-doing)
--strip-progress    Drop streaming progress records (smaller files)
--keep-signatures   Keep thinking.signature fields (default: strip to
                    avoid API 400s after cross-machine resume)
--memory            Also export ~/.claude/projects/<key>/memory/ files
                    (excluding MEMORY.md, which Claude Code regenerates)
```

### Custom redaction patterns

Optionally create a `.claude-handoff-ignore` file at the project root with one
regex per line (`#` for comments). Each pattern is applied in addition to the
built-in ones, with matches replaced by `[REDACTED:custom-N]`. Teams can
commit this file to share redaction rules across the repo.

### Import options

```
--session <id>    Import one specific session
--dry-run         Preview path rewrites and destination
--overwrite       Replace existing local sessions with same ID
```

**Conflict behavior.** If a shared session has the same ID as one already in
your local `~/.claude/projects/<slug>/`, the default is to **skip** it and
report the collision. Pass `--overwrite` to replace the local copy. The
summary at the end of `import` reports how many sessions were imported,
overwritten, or skipped.

## What it does

1. **Path rewriting** — Absolute paths (`/home/alice/project/...`) become portable placeholders (`{{PROJECT_ROOT}}/...`) on export, then get rewritten to Neo's paths on import.

2. **Secret redaction** — Scans for AWS keys, GitHub tokens, API keys, passwords, private keys, and bearer tokens. Replaces them with `[REDACTED:type]` placeholders. A redaction log is written locally for review.

3. **No auto-commit** — The tool writes files; you decide when to commit. Always review `git diff .claude-shared/` before committing.

## Known limitations

- **`memory/` folder not yet exported** — Auto-memory files in `~/.claude/projects/<slug>/memory/` are not included in the handoff yet. Coming in Phase 2.
- **Redaction is best-effort** — The tool reduces but does not eliminate the risk of leaking secrets. Custom patterns can be added to `.claude-handoff/ignore-patterns`. Always review the diff before committing.
- **Windows untested** — Slug computation and path rewriting have only been validated on Linux. macOS should work (same POSIX paths). Windows likely needs work.
- **Subagent transcripts not yet included** — Sessions that spawned sub-agents have companion `<uuid>/subagents/` directories that are not exported yet.
- **Large sessions** — Some sessions can be 2MB+. For projects with many sessions, consider `.gitattributes` with git-lfs.

## Development

```bash
npm install           # Install dependencies
npm run build         # Compile TypeScript
npm run dev           # Watch mode
npm test              # Run vitest suite
npm run lint          # prettier --check + tsc --noEmit
npm run lint:fix      # Auto-fix formatting
```

## Related

This tool addresses the session portability gap discussed in:

- [anthropics/claude-code#12646](https://github.com/anthropics/claude-code/issues/12646) — Session sharing between machines
- [anthropics/claude-code#25947](https://github.com/anthropics/claude-code/issues/25947) — Team collaboration with Claude Code context

## License

MIT
