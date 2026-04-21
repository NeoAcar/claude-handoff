# TODO

Open work. Completed phases are listed at the bottom with the commit
ranges that shipped them; git history has the details.

---

## Open

### High priority

- [ ] **Sequential iteration for the same session ID.** Today
      `export` skips a session as soon as its ID appears in the
      manifest, which means the Alice→Bob→Alice→Bob cycle on *one*
      session is effectively one-shot — Bob's continuation never
      makes it back into the bundle. Fix is small (~40 lines):
      in `src/commands/export.ts`, replace the "already exported"
      skip with a "has this session grown since last export" check.
      Pseudocode:

      ```ts
      const existing = manifest.sessions.find((s) => s.sessionId === sessionId);
      if (existing) {
        const localCount = meta.recordCount;
        const exportedCount = existing.artifacts.find(a => a.kind === 'transcript')?.recordCount ?? 0;
        if (localCount <= exportedCount) continue;  // skip — no new turns
        manifest.sessions = manifest.sessions.filter(s => s.sessionId !== sessionId);
        await rm(bundleDir, { recursive: true, force: true });
      }
      // fall through to the existing export logic, which rebuilds the bundle
      ```

      Also:
      - Improve `import`'s skip message to say "bundle is N records
        ahead of your local copy — rerun with --overwrite to catch
        up" instead of the generic "already exists locally".
      - New integration test under `test/integration/` covering the
        Alice → Bob → Alice → Bob round-trip on one session ID.
      - Ships as `0.2.0` (user-visible behavior change).

      Explicitly **out of scope** for this task: concurrent editing
      (both sides have `claude --resume` running after the initial
      handoff and both append). That's the "session forking" problem
      and requires a real merge/divergence model. This fix assumes
      sequential editing — only one party has the session open at a
      time.

- [ ] **Redactor false positives beyond `url-with-creds`.**
      Exporting from this repo still produces false positives from:
      (a) synthetic secrets inside `test/core/redactor.test.ts`
      fixtures, (b) markdown docs that use `password=xxx`-style
      examples, (c) TypeScript literals like `type: 'aws-key'`. The
      URL pattern was tightened in `05cf64a`, but the broader fix is
      a context heuristic (skip inside test fixtures, markdown code
      blocks tagged `example`, type-literal strings). Alternatively
      / additionally: extend `.claude-handoff-ignore` to support
      path globs so the user can say "skip scanning test/fixtures".

- [ ] **`inspect` command.** Safe read-only viewer for a shared
      session. Pattern is already defined in
      `.claude/commands/inspect-session.md`: print user / assistant
      message counts, tool-use summary, redaction summary, first /
      last timestamps — **never** print raw content. This is what
      reviewers will want before pulling a PR that touches
      `.claude-shared/`.

### Medium priority

- [ ] **`.claude-handoff-memory-ignore` allow-list.** Memory export
      is currently all-or-nothing (minus `MEMORY.md`). Teams that
      want to share only select memory files need a filter. Format
      mirrors `.claude-handoff-ignore`: one glob per line,
      `#` comments.

- [ ] **Metadata-scrub for subagent meta sidecars.** The Codex pass
      (`task-mo8qd79h-aa0vti`) enumerated fields in `writeAgentMetadata`
      / `writeRemoteAgentMetadata` that are freeform text or
      machine-specific: `worktreePath`, `description`, `title`,
      `command`, `spawnedAt`, `sessionId`, `taskId`, `toolUseId`,
      `remoteTaskMetadata.{owner,repo,prNumber}`. Our pipeline
      already path-rewrites and redacts string values, but we don't
      have an explicit scrub for wallclock timestamps or machine-
      specific IDs. Decide whether to add one.

- [ ] **message.id remapping.** Anthropic `msg_…` IDs currently
      pass through unchanged. They're not path-bearing so nothing
      breaks, but they're machine-tied. Decide: leave alone (current
      behavior) or remap to a deterministic-per-session UUID so the
      export is fully machine-neutral.

- [ ] **Verify `/resume` still works with `--strip-progress`.**
      We exclude streaming progress records to shrink big sessions,
      but haven't confirmed end-to-end that Claude Code's resume
      picker and replay behave correctly on a stripped file. Manual
      round-trip on a real session.

- [ ] **Session forking design.** Alice exports → Neo imports →
      Neo continues → Neo exports. Today we skip or overwrite on
      collision. Design a proper fork/merge strategy: keep both?
      Namespace by author? First-write-wins with a warning?

- [ ] **Worktree-aware enumeration (Phase 3E).** `store.ts:enumerateWorktreeRoots(projectRoot)`
      via `git worktree list --porcelain`, then
      `listProjectSessionFiles(projectRoot, { includeWorktrees: true })`
      unions them. Gated behind `--include-worktrees` on
      `export` / `status`.

### Low priority

- [ ] **`--dry-run` on import.** Symmetry with export. Low demand
      so far; no one has asked.

- [ ] **Interactive picker for export.** Checkbox UI for selecting
      sessions. Nice-to-have; no real pain point yet.

- [ ] **HANDOFF.md generator.** Auto-generate a human-readable
      summary with `<!-- MANUAL -->` sections preserved across
      regenerations. Deferred because current session titles
      already make the picker useful enough.

- [ ] **npm publish.** Current install is clone + `npm link`.
      Blocker on non-technical collaborators adopting the tool.

- [ ] **Redaction via `detect-secrets` or `gitleaks`.** Optional
      shell-out for broader pattern coverage. Adds a dependency, so
      gate behind a flag.

### Out of scope for now

- [ ] Git hooks (auto-export on commit, auto-import on pull).
- [ ] `claude-handoff doctor` cross-machine diagnostic.
- [ ] Windows support — needs a test machine.
- [ ] Long-path hash tolerance — the reference hashes paths that
      exceed some threshold instead of sluggifying. We don't know
      the threshold or hash function yet. Revisit if a user hits it.

### What we deliberately skip from the reference codebase

- `Project` write-queue, tail-window metadata re-append — live-CLI
  concerns, not relevant to offline file packaging.
- `permissions/filesystem.ts` carve-outs — not our job.
- Background `extractMemories` service — requires an LLM call.
- `teamMemorySync` — out of scope for a git-based tool.

---

## Completed

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

**Current test count:** 133 across 7 suites, including two
integration suites (`bundle-roundtrip`, `memory-roundtrip`).
