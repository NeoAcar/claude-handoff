# claude-handoff

[![npm version](https://img.shields.io/npm/v/@neoacar/claude-handoff.svg)](https://www.npmjs.com/package/@neoacar/claude-handoff)
[![license](https://img.shields.io/npm/l/@neoacar/claude-handoff.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/@neoacar/claude-handoff.svg)](https://nodejs.org/)

Make Claude Code session context portable between machines via git.

Claude Code keeps every conversation in `~/.claude/projects/` on your
local machine — full transcripts, decisions, tool calls, accumulated
memory. Nothing syncs to the repo. Nothing travels with `git push`.
When a teammate picks up the branch, they get the code but none of
the reasoning.

**claude-handoff** packages that context into `./.claude-shared/` on
export, scrubs local absolute paths and secrets, and reconstructs it
into the teammate's `~/.claude/projects/` on import. `claude --resume`
then shows the shared session with its original title and full
history intact.

## Install

```bash
npm install -g @neoacar/claude-handoff
```

Then run `claude-handoff` from any project directory.

## The flow

```bash
# Alice's machine
cd myproject
claude-handoff init              # one-time setup, adds .claude-handoff/ to .gitignore
# ... Alice works with Claude Code for a while ...
claude-handoff export            # write bundle to .claude-shared/
git add .claude-shared/ && git commit -m "handoff" && git push

# Neo's machine
git pull
claude-handoff import            # reconstruct sessions under ~/.claude/projects/
claude --resume                  # pick Alice's session, keep going
```

Alice's session shows up in Neo's `/resume` picker with its original
title and 100% of the conversation history, tool calls, and subagent
transcripts.

## What ships across machines

Every session is exported as a bundle directory:

```
.claude-shared/sessions/<sessionId>/
  main.jsonl              # the transcript (streamed, path-rewritten, redacted)
  metadata.json           # author, timestamps, title
  subagents/*.jsonl       # Explore / Plan / general-purpose agent transcripts
  subagents/*.meta.json   # subagent metadata (agent type, description)
  session-memory/*.md     # session-scoped memory, when present
```

Plus optional project-level auto-memory (`--memory` flag) under
`.claude-shared/memory/`. And a `.manifest.json` tying it all together.

On import, the layout is reconstructed exactly as Claude Code expects
it, with every absolute path rewritten from the sender's filesystem
to the receiver's.

## Commands

| Command                 | Description                                        |
| ----------------------- | -------------------------------------------------- |
| `claude-handoff`        | Runs `status` by default                           |
| `claude-handoff init`   | Create `.claude-shared/`, update `.gitignore`      |
| `claude-handoff export` | Export local sessions to `.claude-shared/`         |
| `claude-handoff import` | Import shared sessions to `~/.claude/projects/`    |
| `claude-handoff status` | Show local vs shared sessions and freshness        |
| `claude-handoff list`   | List sessions in `.claude-shared/` (+ `--verbose`) |

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
--memory            Also export the project's auto-memory files
                    (~/.claude/projects/<key>/memory/, minus MEMORY.md
                    which Claude Code regenerates)
```

### Import options

```
--session <id>    Import one specific session
--dry-run         Preview path rewrites and destination
--overwrite       Replace existing local sessions with same ID
```

If a shared session has the same ID as one already in your local
`~/.claude/projects/<slug>/`, default is to **skip** it and report the
collision. Pass `--overwrite` to replace.

### Custom redaction patterns

Create `.claude-handoff-ignore` at the project root with one regex
per line (`#` for comments). Each pattern is applied on top of the
built-in ones, with matches replaced by `[REDACTED:custom-N]`. Check
it in so the whole team shares the same scrub rules.

## How it handles the tricky parts

- **Path rewriting.** Absolute paths like `/home/alice/myapp/file.ts`
  become portable placeholders (`{{PROJECT_ROOT}}/file.ts`) on export,
  translate back to the receiver's paths on import. Path-component
  boundary-aware: a project named `auth` never accidentally rewrites
  the word `auth` inside source code.
- **Claude store keys.** Memory files and in-transcript references to
  `~/.claude/projects/<key>/...` go through a `{{CLAUDE_STORE}}`
  placeholder so they land at the receiver's key, not the sender's.
- **Secret redaction.** 9 built-in patterns (AWS, GitHub, Anthropic,
  OpenAI, bearer tokens, password assignments, user:pass URLs, PEM
  blocks) replace matches with `[REDACTED:type]`. Export reports both
  the count of unique secrets found and the total markers written; a
  redaction log lives at `.claude-handoff/redaction-log.json`
  (gitignored) for review.
- **Project store resolution.** Not a naive slug match — canonicalizes
  the project root (`realpath` + Unicode NFC) and, if the computed key
  misses, falls back to reading `cwd` fields from candidate session
  files until it finds the right one. Survives symlinks, macOS vs
  Linux Unicode differences, and Claude Code slug-rule changes.
- **Malformed JSONL recovery.** Real sessions occasionally contain
  concatenated records or truncated lines. The parser tries `}{`
  split recovery, warns on failure, and keeps going instead of
  crashing.
- **`thinking.signature` stripping.** Thinking-block signatures are
  API-key + model bound. Resume doesn't validate them but the next
  API turn can 400 on mismatch. Export strips them by default; pass
  `--keep-signatures` when you know the receiver shares your key/model.

## Safety

- **Redact by default.** `--no-redact` requires a second
  `--i-know-what-im-doing` flag. No way to turn off redaction by
  accident.
- **No auto-commit.** The tool writes files; you run `git add` and
  `git commit` yourself. Always review `git diff .claude-shared/`
  before pushing.
- **Never touches your source.** Only reads from `~/.claude/` and
  writes to `.claude-shared/` and the receiver's `~/.claude/`.
- **Redaction is a safety rail, not a guarantee.** Regex can't catch
  every secret shape. Use `.claude-handoff-ignore` for project-specific
  patterns. Always diff before committing.

## Known limitations

- **`MEMORY.md` is not bundled.** Claude Code regenerates it from the
  sibling memory files via `/dream` consolidation; shipping a stale
  one would stamp over the receiver's. Individual memory files are
  bundled with `--memory`.
- **Windows untested.** Slug computation and path rewriting have
  only been validated on Linux. macOS should work (same POSIX paths
  - realpath + NFC handling). Windows likely needs work.
- **Large sessions.** Some sessions are 2 MB+. Consider
  `.gitattributes` with git-lfs on projects with many sessions.
- **Session forking.** If Alice exports, Neo imports, Neo continues,
  Neo exports — the merge story is "skip or overwrite" right now.
  Proper fork/merge is future work.

## Development

```bash
git clone https://github.com/NeoAcar/claude-handoff
cd claude-handoff
npm install
npm run build
npm test               # vitest, ~130 tests
npm run lint           # prettier --check + tsc --noEmit
npm link               # optional: make `claude-handoff` available globally
```

## Related discussions

- [anthropics/claude-code#12646](https://github.com/anthropics/claude-code/issues/12646) — session sharing between machines
- [anthropics/claude-code#25947](https://github.com/anthropics/claude-code/issues/25947) — team collaboration with Claude Code context

## License

MIT — see [LICENSE](./LICENSE).
