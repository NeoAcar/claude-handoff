# claude-handoff — Project Specification

> **For Claude Code:** This document is the full spec for a tool you are about to build. Read it end-to-end before writing any code. Several assumptions in here need to be **verified against reality** on the current machine before implementation — sections marked **VERIFY FIRST** must be checked empirically, not taken on faith. Do not guess file formats or paths; inspect them.

---

## 1. The Problem

Claude Code is powerful locally but its "project memory" is **not portable**. When a developer works on a project with Claude Code, three kinds of artifacts accumulate:

1. **In the repo** (already shareable via git):
   - `CLAUDE.md`, `.claude/settings.json`, `.claude/commands/`, `.claude/agents/`, `.claude/skills/`, `.mcp.json`

2. **In the user's home directory** (`~/.claude/`, **never shared**):
   - `~/.claude/projects/<project-slug>/*.jsonl` — full session transcripts (every prompt, every response, every tool call)
   - `~/.claude/projects/<project-slug>/sessions-index.json` — session metadata (auto-summaries, timestamps, git branch, message counts)
   - Auto-memory files — observations Claude accumulated about the project over time

When Alice pushes her branch and Bob pulls it, Bob gets the code and the configuration, but **none of the conversational context, decisions, or accumulated memory**. Bob has to re-explain the project to Claude Code from scratch. This is the gap we are closing.

## 2. The Goal

Build a small, focused CLI tool — **`claude-handoff`** — that makes Claude Code's session context and memory **explicitly portable** via the project's git repo.

The tool lets Alice run `claude-handoff export` after a work session. It copies the relevant session files out of `~/.claude/` and into `./.claude-shared/` inside the repo, with paths rewritten to be machine-independent and secrets redacted. Alice commits this folder like any other artifact.

Bob pulls the repo and runs `claude-handoff import`. The tool copies files back into his own `~/.claude/projects/` with paths rewritten to his machine. When Bob opens Claude Code, the `/resume` picker shows Alice's sessions. Bob picks one and continues the exact conversation.

**Non-goal:** we are not building a real-time sync or cloud service. This is a local, explicit, git-based workflow.

---

## 3. Success Criteria

The MVP works if all of these are true:

- [ ] Alice can run `claude-handoff export` after a Claude Code session.
- [ ] The resulting `.claude-shared/` folder commits cleanly to git and contains no absolute paths from Alice's machine and no obvious secrets.
- [ ] Bob, on a different OS if possible, runs `claude-handoff import` after pulling.
- [ ] Bob opens Claude Code in the project and `/resume` lists Alice's sessions with their original summaries.
- [ ] Bob picks a session and Claude Code behaves as if continuing — it references the earlier decisions, file changes, and reasoning from Alice's turn.

If any of the above fails, the tool has not delivered its value.

---

## 4. VERIFY FIRST — Empirical Discovery Before Coding

Before writing a single line of tool code, inspect the actual state of the machine and document findings in a file called `DISCOVERY.md` inside the repo. The tool's behavior must be derived from what's actually there, not what this spec assumes.

### 4.1 Discover the real directory structure

```bash
ls -la ~/.claude/
ls -la ~/.claude/projects/
```

Document what's actually present. Expected (but **verify**):
- `~/.claude/projects/<slug>/` — one folder per project the user has worked on
- The slug is the absolute project path with path separators replaced by dashes (e.g., `/Users/alice/projectx` → `-Users-alice-projectx`). **Confirm this on the current OS.** Linux uses `/home/`, Windows uses backslashes and drive letters — the slug format likely differs.

### 4.2 Inspect a real session file

Pick one `.jsonl` file from `~/.claude/projects/<some-project>/`. Run:

```bash
head -5 <session-file>.jsonl | jq .
wc -l <session-file>.jsonl
```

Document the schema of each line: what fields exist, which contain file paths, which contain tool inputs/outputs, which contain user messages. **Do not invent a schema — read what's there.**

Particular things to find:
- Where are absolute file paths stored? (Likely in tool inputs like `Read`, `Edit`, `Write`, `Bash` commands.)
- Is the CWD stored anywhere? (Useful as the anchor for path rewriting.)
- Are there fields that embed environment variables, home directory references, or user identifiers?

### 4.3 Inspect `sessions-index.json`

```bash
cat ~/.claude/projects/<slug>/sessions-index.json | jq .
```

Document its structure. This is what `/resume` reads to build the picker. We need to understand it well enough to regenerate or merge it on import.

### 4.4 Find the auto-memory location

Run `/memory` inside Claude Code or check whether there's a `MEMORY.md` or equivalent in `~/.claude/projects/<slug>/`. If present, document it. If not found, mark auto-memory as out-of-scope for the MVP and revisit in Phase 3.

### 4.5 Validate the core hypothesis manually

Before building the tool, **test the concept by hand**:

1. Copy a session folder from one location to another (simulating Alice → Bob) with edited paths.
2. On the "Bob" side, launch Claude Code in the target project.
3. Does `/resume` show the copied session?
4. Does picking it actually restore context?

If yes: proceed. If no: the whole premise needs rethinking — stop and report findings.

---

## 5. Architecture

### 5.1 Conceptual model

Two machines, one repo, a folder in the repo as the exchange medium.

```
Alice's machine                  Git repo                   Bob's machine
~/.claude/projects/              .claude-shared/            ~/.claude/projects/
  -Users-alice-projectx/   →       sessions/         →        -Users-bob-projectx/
    session-A.jsonl                  session-A.jsonl            session-A.jsonl
    session-B.jsonl                  session-B.jsonl            session-B.jsonl
    sessions-index.json              sessions-index.json        sessions-index.json
                                     HANDOFF.md
                                     .manifest.json
```

Two transformations happen at the boundaries:

- **Export (Alice → repo):** absolutize-to-portable — rewrite machine-specific paths to portable placeholders, redact secrets, strip user-identifying fields.
- **Import (repo → Bob):** portable-to-absolutize — rewrite placeholders back to Bob's real paths, put files in Bob's `~/.claude/projects/` slug.

### 5.2 Repo layout produced by export

```
<project-root>/
├── .claude-shared/
│   ├── sessions/
│   │   ├── 2026-04-18T14-32_alice_session-abc123.jsonl
│   │   ├── 2026-04-18T16-01_alice_session-def456.jsonl
│   │   └── 2026-04-20T09-15_bob_session-ghi789.jsonl
│   ├── sessions-index.json
│   ├── HANDOFF.md              # Human-readable, auto-generated + hand-edited
│   ├── .manifest.json          # Tool version, schema version, export timestamp
│   └── README.md               # Explains this folder to humans looking at the repo
└── .claude-handoff/            # Local-only, gitignored
    ├── redaction-log.json      # What was redacted in the last export (for review)
    ├── ignore-patterns         # User-defined patterns to additionally redact
    └── config.json             # Local preferences
```

Session filenames include timestamp and author for human scannability in `git log` and `ls`. The original session ID is preserved in filename and inside the file.

### 5.3 CLI surface (MVP)

```
claude-handoff init              # One-time: set up .claude-shared/, gitignore entries, config
claude-handoff status            # Show: local sessions, shared sessions, diff
claude-handoff export [opts]     # Alice's command
claude-handoff import [opts]     # Bob's command
claude-handoff list              # List sessions in .claude-shared/
claude-handoff redact --preview  # Dry-run redaction on a session
```

Export options:
- `--session <id>` — export one specific session
- `--last <n>` — export the last N sessions (default: all since last export)
- `--since <date>` — export sessions modified since a date
- `--author <name>` — tag exported sessions with author name (default: git user.name)
- `--dry-run` — show what would happen, write nothing
- `--no-redact` — skip redaction (require explicit `--i-know-what-im-doing` flag)

Import options:
- `--session <id>` — import one specific session
- `--all` — import everything (default)
- `--dry-run` — preview path rewrites and destination
- `--overwrite` — replace existing local sessions with same ID (default: skip)

---

## 6. Path Rewriting — the core transformation

This is the single most error-prone part of the project. Get it right.

### 6.1 Export-side rewrite

1. Determine the project root on the current machine. Walk up from CWD looking for `.git/`, then confirm it contains `CLAUDE.md` or `.claude/` or `.claude-shared/`. Call this `$LOCAL_ROOT`.
2. Determine the user's home directory. Call this `$LOCAL_HOME`.
3. For every string field in the JSONL that could contain a path (tool inputs, tool outputs, message text), perform these replacements **in this order**:
   - Exact prefix match of `$LOCAL_ROOT` → replace with the literal placeholder `{{PROJECT_ROOT}}`
   - Exact prefix match of `$LOCAL_HOME` → replace with `{{HOME}}` (then flag for redaction review — usernames in paths often leak info)
4. Store in `.manifest.json` the values that were replaced (without the actual paths, just the fact of replacement and the project name).

**Critical:** only replace **exact path-prefix matches**. Do not string-replace the project folder name everywhere — if the project is called `auth`, don't rewrite the word "auth" inside code. Use path-aware matching (the match must be a path component boundary).

### 6.2 Import-side rewrite

1. Determine Bob's `$LOCAL_ROOT` and `$LOCAL_HOME` the same way.
2. Replace `{{PROJECT_ROOT}}` → `$LOCAL_ROOT`.
3. Replace `{{HOME}}` → `$LOCAL_HOME`.
4. Compute Bob's slug for `~/.claude/projects/` and place files there.

### 6.3 Slug computation

Must be OS-aware:
- macOS: `/Users/bob/projectx` → `-Users-bob-projectx`
- Linux: `/home/bob/projectx` → `-home-bob-projectx`
- Windows: `C:\Users\bob\projectx` → likely something like `C--Users-bob-projectx` — **verify on a Windows machine or skip Windows in MVP**

Confirm the exact slug rule by reading how Claude Code names folders in `~/.claude/projects/` on the test machine.

---

## 7. Secret Redaction

Redaction is a safety rail, not a guarantee. Be honest with users about this in the README.

### 7.1 Default patterns

Scan every text value in every JSONL record for:

| Pattern | Example | Replace with |
|---|---|---|
| AWS access key | `AKIA[0-9A-Z]{16}` | `[REDACTED:aws-key]` |
| AWS secret | 40-char base64 after `aws_secret` context | `[REDACTED:aws-secret]` |
| GitHub token | `gh[pousr]_[A-Za-z0-9]{36,}` | `[REDACTED:github-token]` |
| Anthropic key | `sk-ant-[A-Za-z0-9-]+` | `[REDACTED:anthropic-key]` |
| OpenAI key | `sk-[A-Za-z0-9]{32,}` | `[REDACTED:openai-key]` |
| Generic bearer | `[Bb]earer [A-Za-z0-9._-]{20,}` | `[REDACTED:bearer]` |
| Password assignment | `(?i)password\s*[:=]\s*\S+` | `password=[REDACTED]` |
| URL with creds | `https?://[^:]+:[^@]+@` | `https://[REDACTED]@` |
| Private key blocks | `-----BEGIN .* PRIVATE KEY-----` | full block → `[REDACTED:private-key]` |

### 7.2 Custom patterns

Read `.claude-handoff/ignore-patterns` (local, gitignored) for user-supplied regex patterns.

### 7.3 Redaction log

Every export writes `.claude-handoff/redaction-log.json` (local only, gitignored) with:
- Which sessions had matches
- How many of each pattern type
- Context around each match (e.g., 20 chars before and after, with the match itself masked)

This lets the user verify "did the tool miss something?" before committing.

### 7.4 Pre-commit safety

`claude-handoff export` should, at the end, print a clear prompt:

```
Exported 3 sessions to .claude-shared/
Redacted: 2 github-tokens, 1 password assignment
Review: .claude-handoff/redaction-log.json
Before committing, run: git diff .claude-shared/
```

Do not auto-stage or auto-commit.

---

## 8. HANDOFF.md Generator

Auto-generate a human-readable summary from `sessions-index.json`. Format:

```markdown
# Project Handoff Notes
_Auto-generated by claude-handoff on 2026-04-20. Edit freely; manual edits are preserved across regenerations in sections marked `<!-- MANUAL -->`._

## Recent Sessions

### 2026-04-20 — Bob — Cleanup refactor
- **Branch:** `refactor/auth-cleanup`
- **Messages:** 47
- **Summary:** <summary from sessions-index>

### 2026-04-18 — Alice — Database migration
- **Branch:** `feat/email-verification`
- **Messages:** 112
- **Summary:** <summary from sessions-index>

<!-- MANUAL -->
## Current State of the Project
(Write freeform notes here. This section survives regenerations.)

## Known Issues / Open Threads
- Refresh token tests failing on CI (see session 2026-04-20)
- Prod migration not yet run
<!-- /MANUAL -->
```

Regeneration logic: parse existing file, preserve content between `<!-- MANUAL -->` and `<!-- /MANUAL -->` markers, regenerate everything else.

---

## 9. Implementation Plan

### Phase 0 — Discovery (no code)
Produce `DISCOVERY.md` per Section 4. Do not proceed until this is complete and the manual hypothesis test in 4.5 passes.

### Phase 1 — MVP (~1–2 days of focused work)
- `init`, `export`, `import`, `status`, `list` commands
- Path rewriting (export + import)
- Basic regex redaction
- `.manifest.json` with version info
- Dry-run support on export and import
- Tests with fixture JSONL files

### Phase 2 — Polish
- HANDOFF.md generator with manual-section preservation
- `--session`, `--last`, `--since`, `--author` filters
- Redaction log
- Interactive selection UI for export (checkbox picker)
- Better secret detection (consider using `detect-secrets` or `gitleaks` as a shell-out if it's not too heavy)

### Phase 3 — Integration
- Optional git hooks (`claude-handoff install-hooks`): post-commit auto-export, post-merge auto-import — always opt-in
- Auto-memory support if Section 4.4 identified a location
- Cross-machine path diagnosis command (`claude-handoff doctor`)

### Phase 4 — Distribution
- npm publish as `@<scope>/claude-handoff` or unscoped if available
- README with GIF demo
- Submit a comment/link on the relevant Claude Code GitHub issues (#12646 and #25947) so the community can find it

---

## 10. Tech Stack

- **Language:** TypeScript
- **Runtime:** Node.js 20+ (matches Claude Code's own requirement)
- **CLI framework:** `commander` or `yargs` (keep it minimal; do not pull in oclif)
- **File I/O:** native `fs/promises` — avoid heavy abstractions
- **JSONL parsing:** line-by-line with native streams for large files
- **Testing:** `vitest` or `node:test`
- **Linting:** minimal — prettier + tsc --noEmit as a lint pass is enough

Dependencies budget: keep runtime deps under 5 packages. This is a trust-sensitive tool; a small surface area matters.

---

## 11. Testing Strategy

### Unit tests
- Path rewriter: given a JSONL line and a root, correct placeholder substitution; no over-matching
- Slug computer: macOS, Linux, Windows cases
- Redactor: each default pattern on positive and negative cases
- HANDOFF.md merger: manual sections preserved across regenerations

### Integration tests
- Fixture: two fake session files with known paths and fake secrets
- Round-trip: export from simulated Alice's env, import into simulated Bob's env, diff should show only path changes and redactions

### Manual end-to-end
The hypothesis test from 4.5, now automated via a script that:
1. Copies a real session into a temp directory
2. Runs `export`
3. Clears the temp directory
4. Runs `import` 
5. Diffs the before-and-after session

### Platform coverage
At minimum: run on the developer's own OS. Document what's untested. Do not claim Windows support without Windows testing.

---

## 12. Safety and Privacy Principles

These are non-negotiable design constraints:

1. **Opt-in always.** Nothing is exported automatically. No background daemons.
2. **Redact by default.** `--no-redact` requires a loud flag.
3. **Preview before write.** Dry-run is the default posture; actions require confirmation for anything irreversible.
4. **Never auto-commit.** The tool stages files for git; the human commits.
5. **Local logs stay local.** `.claude-handoff/` is gitignored from `init` onward.
6. **Honest scope.** README must state: "This tool reduces but does not eliminate the risk of leaking secrets or sensitive context. Review the diff before committing."
7. **Don't modify source files.** The tool never touches the user's code, only Claude Code's session files.

---

## 13. Open Questions To Resolve During Build

1. Does `sessions-index.json` regenerate automatically when Claude Code starts, or do we need to write it ourselves on import?
2. What happens if two people export overlapping session IDs? (Probably: namespace by author; if collision, keep both with disambiguating suffix.)
3. Are session `.jsonl` files ever referenced by other files in `~/.claude/`? (If yes, those references might need updating too.)
4. What's the right behavior when Alice exports, Bob imports, Bob continues the session, Bob exports? Do we overwrite Alice's version or keep both as a fork?
5. How big do these files get over a long project? If they're multi-MB, should we recommend git-lfs in the README?

Answer these during implementation. Update this section with findings.

---

## 14. What Success Looks Like in a README Demo

A one-minute demo GIF showing:

```
# Alice's machine
$ cd myproject
$ claude-handoff init
Created .claude-shared/ and updated .gitignore
$ # ... works with Claude Code for an hour ...
$ claude-handoff export
✓ Exported 3 sessions to .claude-shared/
✓ Redacted 2 potential secrets (see .claude-handoff/redaction-log.json)
$ git add .claude-shared/ && git commit -m "handoff" && git push

# Bob's machine
$ git pull
$ claude-handoff import
✓ Imported 3 sessions from Alice
$ claude  # opens Claude Code
> /resume
[picker shows Alice's sessions with original summaries]
```

If we can make this demo real and it works cleanly, the tool has shipped.

---

## 15. First Steps for Claude Code

When you start building:

1. Read this file completely. Ask clarifying questions if anything is ambiguous.
2. Set up the repo: `package.json`, `tsconfig.json`, `src/`, `test/`, `README.md` (stub).
3. **Do Phase 0 discovery before writing tool code.** Produce `DISCOVERY.md`. This is not optional — the entire design rests on assumptions that must be empirically confirmed.
4. Run the manual hypothesis test from 4.5. If it fails, stop and report.
5. Build Phase 1 MVP vertically (one command fully working end-to-end) rather than horizontally (all commands at 10% done).
6. Write tests alongside each feature, not after.
7. Commit frequently with clear messages.

Good luck.
