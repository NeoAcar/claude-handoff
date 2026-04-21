# Changelog

All notable changes to `@neoacar/claude-handoff`. The format follows
[Keep a Changelog](https://keepachangelog.com/); the project uses
[Semantic Versioning](https://semver.org/).

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
