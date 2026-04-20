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

## Bugs from real-world use (day 1)

- [ ] Parser crashes on malformed JSONL in real sessions. Example:
      FinanceAi session 8bac1cb9, line 350 appears to be two JSON
      records concatenated without a newline separator (length 2051,
      jq fails at column 135 with "invalid numeric literal").
      Root cause likely in Claude Code itself, not our tool.
      Fix required in src/core/session.ts — streamRecords should: - Catch parse errors per line - Attempt recovery (e.g., split on `}{` boundaries as a fallback) - Log warning, skip the line, continue processing - Report count of skipped lines in export summary
      Add a fixture with a corrupted/concatenated line for regression testing.

## Bugs from real-world use (day 2)

- [ ] **SILENT BUG — slug computation is incomplete.** `computeSlug` in
      src/core/paths.ts only replaces `/` and space with `-`. But Claude
      Code's real rule is broader: any non-alphanumeric non-dash character
      becomes `-`. Confirmed empirically by creating `/tmp/test.slug (v1)/project`
      and observing Claude Code produced slug `-tmp-test-slug--v1--project`.

      Real example that caused a false "no sessions" report:
        Path: /home/neo/PythonProjects/YZV405E_2526_Hedgehogs
        Claude Code slug: -home-neo-PythonProjects-YZV405E-2526-Hedgehogs (underscores → dashes)
        Our computed slug: -home-neo-PythonProjects-YZV405E_2526_Hedgehogs (underscores kept)
        Result: claude-handoff status reported "(none)" while real sessions existed.

      **Preferred fix: switch to reverse-matching instead of computing slugs.**
      List directories under ~/.claude/projects/, find the one that corresponds
      to the current cwd. This is robust to future changes in Claude Code's
      slug rule and to characters we haven't tested (Unicode, Turkish chars).

      Keep `computeSlug` as a fallback/informational utility, but don't rely
      on it for lookups. Update all callers in src/commands/*.ts.

      Regression test: add fixture with a project path containing underscores,
      dots, parentheses, and a Turkish character. Verify reverse-match finds it.

## What we learned from day-2 real-world testing

- Tool worked fine on `intern-apply-bot` (574 records, title extracted)
- Tool crashed on `FinanceAi` (corrupted line — day-1 bug)
- Tool silently failed on `YZV405E_2526_Hedgehogs` (slug bug — day-2 bug)
- Speculative Phase 2 features (HANDOFF.md generator, interactive picker,
  --last N filter, memory support, .claude-handoff-ignore, thinking
  signature investigation) were NOT observed as actual pain points during
  real use. Park them until more real usage generates real signal.
