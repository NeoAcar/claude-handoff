# TODO

## Phase 2 — Ready to Start

### Features

- **memory/ folder support** — Export and import `~/.claude/projects/<slug>/memory/` alongside sessions. Memory files are portable markdown with no absolute paths, so minimal transformation needed.
- **HANDOFF.md generator** — Auto-generate human-readable session summary from JSONL metadata. Preserve `<!-- MANUAL -->` sections across regenerations.
- ~~**Session filtering flags** — Implement `--since <date>` filter on export.~~ ✅ done
- **Interactive picker** — Checkbox UI for selecting which sessions to export (instead of all-or-nothing).
- **Subagent transcript export** — Include `<uuid>/subagents/*.jsonl` files in the export pipeline.

### Configurability

- ~~**.claude-handoff-ignore support**~~ ✅ done — project-root file, one regex per line, merged into the redaction pipeline.
- ~~**Progress record stripping**~~ ✅ done via `--strip-progress`. Still to verify: `/resume` works without these records (manual test).

### Investigations

- **thinking.signature field** — Do thinking signatures validate across machines? The `thinking.signature` field is an Anthropic-internal cryptographic value (not a user secret), but if exported sessions reproduce these in shared contexts, verify whether they're machine/account-tied. Test during a real cross-machine round-trip.
- **message.id field** — Fields like `msg_018vP5DYx5EAuAmzny5SbcLH` were not remapped during export. Likely fine but inconsistent with path-neutrality goals. Decide whether to remap these for full machine-neutrality.
- **Session forking** — What happens when Alice exports, Neo imports, Neo continues, Neo exports? Design the merge/fork strategy (keep both? overwrite? namespace by author?).

### Polish

- **Redaction improvements** — Consider shelling out to `detect-secrets` or `gitleaks` for more comprehensive coverage.
- **git hooks (opt-in)** — `claude-handoff install-hooks` for post-commit auto-export, post-merge auto-import.
- **`claude-handoff doctor`** — Cross-machine path diagnosis command.
- **Windows support** — Verify slug computation and path rewriting on Windows (drive letters, backslashes).

## Bugs from real-world use (day 1)

- [ ] Parser crashes on malformed JSONL in real sessions. Example:
      a real session's line 350 appears to be two JSON records
      concatenated without a newline separator (length 2051, jq
      fails at column 135 with "invalid numeric literal").
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
        Path: /home/alice/projects/course_2526_team
        Claude Code slug: -home-alice-projects-course-2526-team (underscores → dashes)
        Our computed slug: -home-alice-projects-course_2526_team (underscores kept)
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

- Tool worked fine on a clean project (574 records, title extracted)
- Tool crashed on a project with a corrupted session line (day-1 bug)
- Tool silently failed on a project with underscores in its path (day-2 bug)
- Speculative Phase 2 features (HANDOFF.md generator, interactive picker,
  --last N filter, memory support, .claude-handoff-ignore, thinking
  signature investigation) were NOT observed as actual pain points during
  real use. Park them until more real usage generates real signal.

## Phase 2.1 — Real-world usage signals (day 2, after demo handoff test)

Gathered from two real-world export tests:

- `claude-handoff` repo itself (2 sessions, 700+ records, heavy self-referential content)
- `handoff-demo` toy project (1 session, 40 records, clean case)

### High priority

- [ ] **Redactor false positives flood real projects.** Exporting from the
      tool's own repo produced 122 redaction markers across 13 pattern types.
      The overwhelming majority are false positives: synthetic secrets inside
      `redactor.test.ts` fixtures, markdown documentation tables in SPEC.md
      (e.g., `password=xxx` examples), and TypeScript type literals like
      `type: 'aws-key'`. Real projects that contain auth/crypto code will
      have the same problem — code samples and docstrings get mangled.

      Fix direction:
      - Add a context heuristic: detect when a match is inside a test fixture,
        a markdown code block tagged `example`, or a type literal
      - Support a `.claude-handoff-ignore` file with user-defined patterns to
        skip or allowlist
      - ~~Tune the `url-with-creds` regex~~ ✅ done in 05cf64a — restricted
        to true `user:pass@host` forms so ordinary URLs are no longer matched.

- [ ] **Memory folder support.** `~/.claude/projects/<slug>/memory/` was
      discovered in Phase 0 but deferred. In the day-2 demo handoff test,
      Claude Code itself tried to create/delete memory files during a
      handed-off session, suggesting both Claude Code and future users
      expect this folder to travel with the session. Export and import
      should now cover `memory/*.md` with the same path rewriting and
      redaction treatment as sessions.

### Medium priority

- [x] **Redaction reporting is confusing.** Summary now shows both unique
      secrets and total markers, plus a per-pattern breakdown. The log
      (`.claude-handoff/redaction-log.json`) groups hits by pattern with
      dedup'd contexts.

- [ ] **`inspect` command for shared sessions.** Opening a `.jsonl` file
      from `.claude-shared/sessions/` with `cat` is unreadable — pure JSON
      blobs. Users and reviewers need a safe way to peek at a shared
      session before pulling or pushing. Build `claude-handoff inspect
<session-id>` that prints: user message count, assistant response
      count, tool_use summary, redaction summary, first/last timestamps.
      Never print raw content. Same philosophy as `.claude/commands/
inspect-session.md`.

- [x] **Conflict behavior on import.** Default is skip-with-warning;
      `--overwrite` replaces. Summary now separately reports imported /
      overwritten / skipped counts. Documented in README.

### Low priority

- [ ] **HANDOFF.md auto-generator.** Deferred from Phase 2 of SPEC. Current
      session titles (e.g., "Actually let me stop here. Next person will
      add JSON output support.") are already surprisingly good as a handoff
      signal in the demo test — so this is less urgent than assumed. Revisit
      after more real team use; maybe we don't even need it.

- [x] **Reporting polish for status/list.** `status` shows size, age, and
      a `*` marker for sessions modified since the last export. `list` now
      shows size and supports `--verbose` (author, export time, redaction
      markers, timespan).

- [x] **No-arg CLI behavior.** Running `claude-handoff` alone now runs
      `status` by default and hints at next steps.

- [ ] **Distribution friction.** Tool is not on npm yet. Installing it
      requires clone + `npm link`, which is a significant barrier for
      non-technical collaborators. Before widespread sharing, publish
      to npm so the install step is one line.

### Phase 2.1 bugs to fix before next dogfooding round

- [ ] **thinking.signature field** (flagged in day-1 TODO) — still not
      investigated. If signatures are machine/account-tied, they will
      fail validation on a different user's machine. Test on a real
      cross-user handoff. Might be invisible (signature ignored) or
      might silently corrupt thinking blocks — unknown.

- [ ] **message.id remapping** (flagged in day-1 TODO) — inconsistent with
      our UUID-remap policy. Decide whether to leave as-is or remap for
      full machine-neutrality.

### Out of scope for Phase 2.1 (revisit later)

- [ ] Git hooks (auto-export on commit, auto-import on pull) — Phase 3
- [ ] `claude-handoff doctor` cross-machine diagnostic — Phase 3
- [ ] Windows support — Phase 4, after distribution strategy is clear
- [ ] Interactive picker for export — nice-to-have, no real pain point yet
- [ ] `--dry-run` on import — symmetry with export; low demand so far
