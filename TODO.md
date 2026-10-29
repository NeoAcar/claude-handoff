# TODO

Open work. Completed phases are listed at the bottom with the commit
ranges that shipped them; git history has the details.

---

## Open

- [ ] **Which route should be the default?** A bare `export` writes
      `.claude-shared/` (committed, so it stays in git history for
      good); `-o` writes a `.handoff` file (leaves no trace, but has
      to be sent by hand and has no iteration tracking). The file is
      the safer default, the repo is what the tool is known for.
      Decide after real use shows which one people reach for; the
      alternative is `export` → file, `export --repo` → `.claude-shared/`.

### Known limits, not planned

- Windows is untested — needs a machine to test on.
- Very long project paths: Claude Code may hash them instead of
  turning them into a folder name. Store lookup falls back to reading
  `cwd` from session files, which should cope; revisit if someone
  reports a miss.

### What we deliberately skip from the reference codebase

- `Project` write-queue, tail-window metadata re-append — live-CLI
  concerns, not relevant to offline file packaging.
- `permissions/filesystem.ts` carve-outs — not our job.
- Background `extractMemories` service — requires an LLM call.
- `teamMemorySync` — out of scope for a git-based tool.

---

## Completed

### 0.3.1 — Handoff context

`HANDOFF.md` per bundle (edited files, commands, last request, commit),
import warnings for a missing commit, uncommitted edits and very large
transcripts. Forked sessions checked: self-contained.

### 0.3.0 — Known-secret scrubbing, archives, doctor, skill

`.env` / environment value scrubbing, wider key patterns, single-file
handoff with checksums, `doctor`, `skill install`, first-prompt
titles, and a simpler CLI (positional arguments, no init step, bare
`export` lists). See `CHANGELOG.md`.

### 0.2.2 — Self-refreshing bundles

Manifest entries record `exportedWith`; `export` rewrites unchanged
sessions whose bundle predates `REFRESH_BUNDLES_BEFORE`.

### 0.2.1 — Claude Code 2.1.x compatibility

Account-identity scrubbing (email, org UUID), `tool-results/`
sidecars, `ai-title` titles, `--session` by title text. Verified
export → import → `claude --resume` on Claude Code 2.1.288. See
`CHANGELOG.md`.

### 0.2.0 — Iterative handoff

Sequential round-tripping of the same session ID. Export uses
mtime + record count to distinguish unchanged / has-new-turns /
fork-suspected; prior rounds archived into `previousExports`.
Import auto-catches-up when bundle is ahead, skip-with-warning
when local is ahead. New `--force` escape hatch. See `CHANGELOG.md`.

### 0.1.0 — Initial public release (published to npm)

### Phase 0–1 — Discovery and MVP

End-to-end `export → git → import` with streaming JSONL, path
rewriting, secret redaction, manifest, and `status` / `list`
commands. Details in `PROGRESS.md`.

### Phase 2.0 — Day-2 bug fixes

- Silent slug mismatch on paths with underscores / parens / dots —
  `computeSlug` corrected; lookups switched to reverse-match
  (`6393c59`).
- Parser crashes on malformed JSONL — recovery via `}{` split with
  warn-and-continue fallback (`a89a75e`).
- Repo anonymization + Bob→Neo rename for open-source release
  (`be1465b`).

### Phase 2.1 — Real-world dogfooding polish

- No-arg CLI runs `status` (`b37952b`).
- `url-with-creds` regex tightened to true `user:pass@host` forms
  (`05cf64a`).
- Redaction reporting shows unique vs total markers with
  per-pattern breakdown; log grouped by pattern (`b82fca9`).
- `status` shows size, age, and a `*` marker for sessions modified
  since last export (`099657a`).
- `import` reports imported / overwritten / skipped separately;
  README documents the skip-by-default-then-`--overwrite` policy
  (`a9f1d8a`).
- `list` gains size + `--verbose` with manifest-aware details
  (`7033752`).
- `export --since <iso-date>`, `--strip-progress`,
  `.claude-handoff-ignore` custom redaction patterns (`cbc0ea8`).

### Phase 3 — Storage layer refactor + bundle model

Informed by Codex analysis of the reference repo at `/tmp/codecli`
(`task-mo8njiyj-g4cpk6` for the storage patterns,
`task-mo8qd79h-aa0vti` for memory / meta sidecars /
`thinking.signature` semantics).

- **3A — storage layer split.** New `src/core/store.ts` owns Claude
  store discovery (canonical project root via `realpath` + NFC,
  fast-path key lookup, `cwd`-peek fallback, sessionId resolution).
  `paths.ts` shrunk to placeholder rewriting only. Commits
  `dcb9805`, `5ced4b5`.
- **3B + 3C — bundle model.** Sessions exported as directory
  bundles under `.claude-shared/sessions/<sessionId>/` with
  `main.jsonl`, `metadata.json`, and `subagents/`,
  `remote-agents/`, `session-memory/` sidecars. Manifest schema v2
  with auto-migration from v1 flat-file exports. Commit `9385d3c`.
- **3C.5 — signed-thinking-block strip.** `thinking.signature`
  fields are API-key + model bound; resume itself doesn't validate
  them but the next API turn 400s on mismatch. Default strip on
  export (matches the reference mitigation); `--keep-signatures`
  opts back in. Commit `30e402f`.
- **`{{CLAUDE_STORE}}` placeholder.** Third portable placeholder
  alongside `{{PROJECT_ROOT}}` / `{{HOME}}`. Translates absolute
  paths that point inside the machine-specific `~/.claude/projects/<key>/`
  so Alice's key gets rewritten to Neo's on import. Commit
  `d96a8fd`.
- **3D — repo memory (opt-in).** `--memory` flag walks
  `<store-via-canonical-git-root>/memory/*` excluding `MEMORY.md`
  (LLM-maintained; Claude Code rebuilds it). Worktrees share one
  memory store via `findCanonicalGitRoot`. Commit `07d2753`.

**Current test count:** 257 across 22 suites.
