# claude-handoff — Where We Are

_Last updated: 2026-04-21._

A running status doc so you can follow what's been shipped, what's sitting
unpushed on `main`, and what's still open. Read top-to-bottom; nothing below
the fold is surprising if you've read the top.

---

## Shipped (pushed to `origin/main`)

### Phase 0 & Phase 1 — MVP

- Full export → git → import pipeline working end-to-end
- Path rewriting (`{{PROJECT_ROOT}}`, `{{HOME}}`) with boundary-safe matching
- Secret redaction with 9 default patterns (AWS, GitHub, Anthropic, OpenAI,
  bearer, password, URL-with-creds, private key)
- Streaming JSONL read/write, never loads whole files
- Commands: `init`, `export`, `import`, `status`, `list`
- 96 unit tests at the end of Phase 1

### Phase 2.0 — Day-2 bug fixes

- **paths: slug rule fix + `findSlugForPath`** (`6393c59`)
  Claude Code's slug rule is broader than we thought — underscores,
  parentheses, dots, etc. all become dashes. Switched lookups to
  reverse-match against the actual `~/.claude/projects/` listing instead
  of recomputing; `computeSlug` is now a documented fallback.
  Fixed a silent "no sessions found" on any project with an underscore.

- **session: recover from malformed JSONL** (`a89a75e`)
  Real sessions occasionally contain two JSON records concatenated
  without a newline. Old code crashed on the first bad line. Now we
  try a `}{` split recovery, warn on failure, and return stats so
  `export`/`status` can surface counts to the user.

- **style: prettier across repo** (`1a41601`)

### Open-source prep

- **docs: anonymize examples + rename Bob → Neo** (`be1465b`)
  Scrubbed real project names (FinanceAi, YZV405E_2526_Hedgehogs,
  intern-apply-bot, NLP Homework 3) from docs, tests, and fixtures.
  Rewrote DISCOVERY.md with generic example paths. Replaced personal
  prompts in sample-session.jsonl with a short synthetic conversation.
  Renamed "Bob" → "Neo" in the Alice/Neo demo throughout.

### Phase 2.1 — First batch of polish (already on remote)

- **cli: no-arg runs `status` + next-step hint** (`b37952b`)
  `claude-handoff` alone now gives useful output instead of help text.

- **redactor: tighter url-with-creds regex** (`05cf64a`)
  Old `[^:]+:[^@]+@` was greedy — any URL on a line that contained a
  later `@` got redacted. Restricted both sides of the colon to
  non-separator chars, so only real `user:pass@host` forms match.
  Fixes a big chunk of the 122 false positives from real-world use.

- Tests: **113 passing** on `origin/main`.

---

## Committed locally, not yet pushed (7 commits)

Run `git push origin main` when you're ready. These are all backwards
compatible and add tests where applicable.

- **`b82fca9` export: unique vs total redaction counts**
  The export summary used to claim "Redacted N potential secrets" where
  N didn't match the number of `[REDACTED:…]` markers in the file
  (same secret redacted in multiple serialized fields). Now reports
  both numbers plus a per-pattern breakdown; `redaction-log.json` is
  grouped by pattern with dedup'd contexts.

- **`099657a` status: size, age, freshness marker**
  `status` now shows human-readable file size and age per session,
  with a `*` marker on local sessions modified since the last export.

- **`a9f1d8a` import: overwritten vs skipped tracking**
  `--overwrite` already worked; now the summary breaks out imported /
  overwritten / skipped counts. Conflict policy documented in README.

- **`e9573ef` todo: mark those three done**

- **`7033752` list: size + `--verbose`**
  `list` shows file size per session. `-v` / `--verbose` additionally
  prints author, export timestamp, redaction marker count, and
  session timespan (from the manifest).

- **`cbc0ea8` export: `--since`, `--strip-progress`, `.claude-handoff-ignore`**
  - `--since <iso-date>` — only export sessions whose first record is
    on/after the date. `"2026-04-01"` or full ISO timestamps both work.
  - `--strip-progress` — drop streaming `progress` records at export
    time (about half of records in long sessions). `/resume` usability
    without them is still unverified — flagged in TODO.
  - `.claude-handoff-ignore` at the project root: one regex per line,
    `#` for comments. Patterns get merged into the redaction pipeline
    alongside the built-ins. Teams can commit this to share rules.

- **`b927f33` todo: mark those three done**

Test count unchanged at 113 (no new unit tests for the new flags yet —
they're covered by smoke-tests against real sessions; worth adding
dedicated tests before next release).

---

## Still open

Kept short — full context is in `TODO.md`.

### Larger / design-heavy (deliberately deferred)

- **memory/ folder support** — high-priority, but needs careful
  path-rewriting + redaction for markdown + collision handling.
- **`inspect` command** — safe peek at a `.claude-shared/` session
  without dumping raw content. New command surface.
- **Subagent transcript export** — walk `<uuid>/subagents/*.jsonl`
  companion dirs. Straightforward but needs tests.
- **Redactor context heuristic** — detect fixtures / markdown code
  blocks / TypeScript type literals to reduce remaining false
  positives. Real design work.
- **HANDOFF.md generator** — parked; current session titles already
  carry most of the signal.
- **Interactive picker for export** — blocked on picking a UI lib.
- **git hooks (opt-in)** — `install-hooks` command, post-commit /
  post-merge.
- **`claude-handoff doctor`** — cross-machine path diagnosis.

### Needs a decision or an environment

- **`thinking.signature` field** — are Anthropic-internal thinking
  signatures machine/account-tied? Needs a real cross-machine round-
  trip with two different accounts.
- **`message.id` field remapping** — small change, but a product call
  (remap for full machine-neutrality vs leave alone).
- **Session forking** — what happens when Alice exports, Neo imports,
  Neo continues, Neo exports? Design the merge/fork strategy.

### Distribution / platform

- **npm publish** — real blocker on distribution. Needs your npm
  account; tool is currently clone + `npm link`.
- **Windows support** — untested; slug rule and path handling likely
  need adjustment.

### Small wins still on the board

- `list --verbose` edge cases; `import --dry-run` (symmetry with export);
  `detect-secrets` / `gitleaks` shell-out for better redaction coverage.

---

## How to read the repo right now

- `README.md` — user-facing docs, now includes `--since`, `--strip-progress`,
  `.claude-handoff-ignore`, and the import conflict policy.
- `SPEC.md` — original design doc. Parts are now out of date where reality
  deviated (e.g., `sessions-index.json` doesn't exist); kept for history.
- `DISCOVERY.md` — empirical findings from Phase 0, scrubbed for
  open-source. Still useful for anyone porting the tool to Windows or a
  different Claude Code version.
- `TODO.md` — living punch list, grouped by phase and priority.
- `STATUS.md` — this file.
- `PROGRESS.md` — short MVP completion record.

---

## Quick recap of what changed this session

One sitting's worth of work, roughly in order:

1. Fixed two day-2 real-world bugs (slug underscore case, parser crash).
2. Prepped the repo for open source (anonymize + rename Bob→Neo).
3. Added the remote, pushed, confirmed.
4. Worked through Phase 2.1 low-hanging items:
   - No-arg CLI default
   - url-with-creds regex fix
   - Redaction reporting clarity
   - Status/list polish
   - Import conflict messaging
   - `--since` / `--strip-progress` / `.claude-handoff-ignore`

The code is in a good state to tag `v0.2.0` once the 7 unpushed commits
are pushed and a few tests for the new flags are added.
