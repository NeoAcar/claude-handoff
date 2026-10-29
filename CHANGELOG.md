# Changelog

All notable changes to `@neoacar/claude-handoff`. The format follows
[Keep a Changelog](https://keepachangelog.com/); the project uses
[Semantic Versioning](https://semver.org/).

## [0.3.1]

### Added

- **What the receiver may be missing.** Each exported session records
  the commit and branch it was exported from and which files it edited,
  and flags the edits that were still uncommitted. `export` points
  those out ("commit and push them too"); `import` warns when the
  receiver's checkout lacks the commit, or when the session edited
  files the sender never committed. Read-only git queries only.
- **`HANDOFF.md` in every bundle.** A short, readable account of the
  session — edited files, shell commands (and how many failed), the
  last request — taken from the transcript itself rather than from
  anything the model wrote. Useful to the receiver and to anyone
  reviewing `.claude-shared/` in a pull request. Redacted like the
  rest of the bundle.
- `import` notes when a transcript is large (over 1.5 MB), since
  resuming it re-reads the whole conversation.

### Removed

- `--strip-progress`. It dropped `progress` records, which current
  Claude Code no longer writes, so it had nothing left to do.

### Docs

- The README says plainly that redaction cleans what is shared, and
  does not stop a secret from reaching the model during a session.

### Checked

- Forked sessions (`--fork-session`) copy their parent's records into
  their own file, so they export and resume without the parent.

## [0.3.0]

Verified end-to-end against Claude Code 2.1.289.

### Added

- **Scrubbing of the project's own secrets.** Export reads the
  project's `.env` files (templates such as `.env.example` excluded)
  and secret-named environment variables, and removes those exact
  values from everything it writes, marked `[REDACTED:env:KEY]`. This
  catches secrets with no recognisable shape, which patterns cannot.
  JSON-escaped and URL-encoded spellings are matched too. Short,
  numeric and ordinary-looking values are left alone. Opt out with
  `--no-env-scan`.
- **More key formats.** OpenAI project / service-account / admin keys
  (`sk-proj-…` was previously missed), GitHub fine-grained tokens,
  Google API keys, Slack tokens and webhook URLs, generic `api_key` /
  `secret` / `token` assignments, and passwords in non-HTTP connection
  strings (`postgres://`, `redis://`, …).
- **Single-file archives.** `export -o` writes the bundle as one
  `.handoff` file (a gzip tar) instead of `.claude-shared/`; `import
<file>` reads it. An index of SHA-256 checksums is verified before anything is
  imported. For handoffs without a shared repo.
- **`doctor`.** Read-only check: where the sessions are, whether your
  Claude Code is newer than the last verified version, bundles written
  by older versions, `.gitignore`, and what redaction has to work with.
- **`skill install` / `skill print`.** A Claude Code skill so the agent
  can run a handoff when asked. It never commits, pushes, or disables
  redaction.

### Changed

- **Simpler commands.** `export [session]` and `import [file]` take
  what used to be `--session` and `--archive` as plain arguments
  (`export "login bug"`, `import fix-login-bug.handoff`). `-n` is short
  for `--last`, `-o` for `--archive`.
- **A bare `export` no longer writes every session.** On a terminal it
  shows the sessions by title to pick from, like `claude --resume`;
  elsewhere it lists them and stops. A title, `-n`, or `--all` skips
  the picker. **Breaking** for scripts that relied on the old
  behaviour: use `export --all`.
- **Archives name themselves.** `export -o` with no file name writes
  `<session-title>.handoff`; `import` accepts the name with or without
  the extension. `*.handoff` is git-ignored along with
  `.claude-handoff/`.
- **No setup step.** The first export adds `.claude-handoff/` to
  `.gitignore` itself (in a git repository). `init` still works but is
  no longer needed.
- `list` is folded into `status -v`. `import --all` is gone; it was
  already the default.
- Rarely used export flags moved out of the main `--help` into a
  "less common options" block.
- Sessions with no title record are labelled by the first thing the
  user asked, with Claude Code's control blocks stripped, rather than
  by the last prompt.
- Custom patterns from `.claude-handoff-ignore` now run before the
  built-in ones, so they label the match.
- Bundles no longer record the sender's absolute project path
  (`sourceProjectRoot`, `sourceGitRoot`).
- Bundles written before 0.3.0 are rewritten on the next export.

- All patterns are matched against the original text and overlapping
  matches are merged. Applying them one after another could let one
  pattern's marker cut another's match short and leave the tail of a
  key in place.
- `import` validates session IDs and paths from the manifest before
  writing anything.

### Fixed

- Anthropic keys containing `_` were only partly redacted.
- Redaction-log contexts could show a neighbouring secret that a later
  pattern went on to redact; contexts now come from the finished text.
- Lookbehind patterns went quadratic on very long runs of whitespace.

## [0.2.2]

### Added

- **Old bundles refresh themselves.** Each manifest entry now records
  the claude-handoff version that wrote it (`exportedWith`). `export`
  rewrites an unchanged session when its bundle is unstamped or older
  than the last change to what export removes, so bundles from 0.2.0
  lose the account email / org UUID on the next export. Earlier
  commits in git history are not affected.

## [0.2.1]

Compatibility pass against Claude Code 2.1.288.

### Added

- **Account identity scrubbing.** Newer Claude Code versions write the
  account email (`session_context` attachment, plus its `rendered`
  copy) and organization UUID (`credential_org` attachment) into the
  transcript. Export now scrubs both across the whole bundle; hits are
  logged as `account-email` / `account-org`. Skipped with `--no-redact`.
  The identity is gathered from every local session of the project, so
  sessions and memory files that don't carry the record are covered too.
- **`tool-results/` sidecars.** Large tool outputs that Claude Code
  persists under `<sessionId>/tool-results/` are bundled (path-rewritten
  and redacted) so the transcript's `{{CLAUDE_STORE}}` references
  resolve on the receiver. Binary files are skipped with a warning.
- New manifest artifact kind `tool-result`.
- **`--session` accepts title text.** `export --session "fix upload"`
  matches a case-insensitive substring of the session title, as well
  as the ID prefix it always took. Same on `import`.
- `import` prints a ready-to-paste `claude --resume <id>` line when
  it imported three sessions or fewer.

### Fixed

- Session titles written to `metadata.json` and `.manifest.json` now go
  through path rewriting and redaction like the transcript.
- Symlinks inside a session's sidecar directory are no longer followed.
- `--version` and the manifest's `toolVersion` reported `0.1.0`
  regardless of the installed version; both now come from `package.json`.

### Changed

- Session titles prefer the user's custom title, then the
  auto-generated `ai-title` record, then the last prompt.

## [0.2.0]

### Added

- **Iterative handoff on one session ID.** The same session can now
  ping-pong through the repo multiple times (Alice ↔ Neo ↔ Alice…).
  Each round's author and timestamp is archived into a new
  `previousExports` field on the manifest entry so the history is
  visible in `status` / `list` and in `.manifest.json`.
- **`--force`** on `export`. Escape hatch for the fork-detection
  refusal — needed when you intentionally want to overwrite a
  bundle that was ahead of your local.
- **Fork detection.** If the local session has fewer records than
  the shared bundle's recorded source (i.e. you pulled teammate
  work without importing), `export` now refuses by default with an
  explicit message. Prevents silently clobbering teammates' work.
- **Auto-catch-up on `import`.** When the shared bundle is ahead of
  your local copy, `import` now brings it up to date without
  requiring `--overwrite`. `--overwrite` is still needed (and still
  warns) if your local has unshared work that would be discarded.
- Manifest fields on each entry: `sourceMtimeMs`, `sourceRecordCount`,
  `previousExports`.

### Changed

- `export` no longer blindly skips a session ID on every run; it now
  uses `sourceMtimeMs` + `sourceRecordCount` to distinguish
  "unchanged" from "has new turns" from "fork suspected."
- `import` `utimes()`-pins the local transcript's mtime to the
  manifest's `sourceMtimeMs` after writing. This is the signal that
  makes the in-sync vs behind vs ahead check stable across
  handoffs. Side effect: imported files show the sender's source
  mtime rather than the import wallclock — functionally correct,
  cosmetically unusual.

### Backward compat

- v0.1.0 manifest entries (missing `sourceMtimeMs`) fall back to the
  old "skip unless --overwrite" rule on import and to "treat as
  legacy, refresh" on export so they self-upgrade on next round.
  No manual migration needed.

## [0.1.0]

Initial public release.

- `init` / `export` / `import` / `status` / `list` / no-arg default
  to `status`.
- Bundle layout under `.claude-shared/sessions/<sessionId>/` with
  `main.jsonl`, `metadata.json`, `subagents/`, `remote-agents/`,
  `session-memory/`.
- Portable path placeholders: `{{PROJECT_ROOT}}`, `{{HOME}}`,
  `{{CLAUDE_STORE}}`.
- Secret redaction with 9 built-in patterns and
  `.claude-handoff-ignore` for custom ones.
- Canonical-git-root-based memory export (`--memory`), excluding
  `MEMORY.md`.
- `--since`, `--last`, `--strip-progress`, `--keep-signatures`,
  `--no-redact`, `--i-know-what-im-doing`.
- `thinking.signature` stripped by default on export to avoid
  post-resume API 400s; `--keep-signatures` opts out.
- Store discovery via `realpath()` + Unicode NFC canonicalization
  with `cwd`-peek fallback for robustness against slug-rule drift.
- Malformed-JSONL recovery (`}{` split, warn-and-continue).

[0.2.0]: https://github.com/NeoAcar/claude-handoff/releases/tag/v0.2.0
[0.1.0]: https://github.com/NeoAcar/claude-handoff/releases/tag/v0.1.0
