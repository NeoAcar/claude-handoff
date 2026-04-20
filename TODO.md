# TODO

## Phase 2 — Ready to Start

### Features
- **memory/ folder support** — Export and import `~/.claude/projects/<slug>/memory/` alongside sessions. Memory files are portable markdown with no absolute paths, so minimal transformation needed.
- **HANDOFF.md generator** — Auto-generate human-readable session summary from JSONL metadata. Preserve `<!-- MANUAL -->` sections across regenerations.
- **Session filtering flags** — Implement `--since <date>` filter on export.
- **Interactive picker** — Checkbox UI for selecting which sessions to export (instead of all-or-nothing).
- **Subagent transcript export** — Include `<uuid>/subagents/*.jsonl` files in the export pipeline.

### Configurability
- **.claude-handoff-ignore support** — Allow users to specify files/patterns to exclude from export (beyond the built-in redaction patterns).
- **Progress record stripping** — Option to exclude `progress` type records on export (they're ~54% of records by count but not needed for context restoration). Test that `/resume` still works without them.

### Investigations
- **thinking.signature field** — Do thinking signatures validate across machines? The `thinking.signature` field is an Anthropic-internal cryptographic value (not a user secret), but if exported sessions reproduce these in shared contexts, verify whether they're machine/account-tied. Test during a real cross-machine round-trip.
- **message.id field** — Fields like `msg_018vP5DYx5EAuAmzny5SbcLH` were not remapped during export. Likely fine but inconsistent with path-neutrality goals. Decide whether to remap these for full machine-neutrality.
- **Session forking** — What happens when Alice exports, Bob imports, Bob continues, Bob exports? Design the merge/fork strategy (keep both? overwrite? namespace by author?).

### Polish
- **Redaction improvements** — Consider shelling out to `detect-secrets` or `gitleaks` for more comprehensive coverage.
- **git hooks (opt-in)** — `claude-handoff install-hooks` for post-commit auto-export, post-merge auto-import.
- **`claude-handoff doctor`** — Cross-machine path diagnosis command.
- **Windows support** — Verify slug computation and path rewriting on Windows (drive letters, backslashes).
