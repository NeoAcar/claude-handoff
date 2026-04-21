# How claude-handoff works

A walkthrough of the mechanics, not the project status. Read this if you
want to understand how a Claude Code session actually makes it from
Alice's laptop to Neo's laptop.

---

## The problem in one paragraph

Claude Code keeps every conversation you've had with it in
`~/.claude/projects/<project-slug>/<session-uuid>.jsonl` — one file per
session, on your machine only. The content is great (full tool calls,
reasoning, decisions), but it's stuck there. Nothing syncs to the repo,
nothing travels with `git push`. This tool makes those session files
**portable** so you can share them through the repo like any other
artifact.

---

## The mental model

There's no cloud service, no daemon, nothing magic. It's just a file
copier with two clever transformations:

```
Alice's laptop                       the repo                       Neo's laptop
~/.claude/projects/                  .claude-shared/                ~/.claude/projects/
  -home-alice-projects-myapp/  ────►   sessions/              ────►   -home-neo-projects-myapp/
    abc123.jsonl                        2026-04-18_alice_abc123.jsonl    abc123.jsonl
    def456.jsonl                        2026-04-18_alice_def456.jsonl    def456.jsonl
                                         .manifest.json
```

Export rewrites Alice's absolute paths to neutral placeholders and
redacts secrets on the way out. Import does the reverse on Neo's
machine. Git handles the middle. No new protocols, no servers, no state
outside the repo.

---

## 1. Finding the session files

Claude Code stores sessions under a **slug** of your project path — the
path with every non-alphanumeric-non-dash character replaced by a dash:

```
/home/alice/projects/myapp              →  -home-alice-projects-myapp
/home/alice/projects/course_2526_team   →  -home-alice-projects-course-2526-team
/tmp/test.slug (v1)/project             →  -tmp-test-slug--v1--project
```

We don't compute this at lookup time though — we **reverse-match**. The
tool lists whatever's in `~/.claude/projects/` and finds the directory
that corresponds to your current project. Why reverse-match? Because
our hypothesis about the slug rule turned out wrong twice (first about
spaces, then about underscores), and reading the filesystem doesn't
lie. `computeSlug` stays as a fallback for Neo's first import when the
directory doesn't exist yet.

See `src/core/paths.ts` — `findSlugForPath()`.

---

## 2. Reading session files safely

Session files get big — a day of tool use can be 2 MB. We never load a
whole file into memory. Everything streams line-by-line:

```ts
for await (const line of rl) {
  const record = JSON.parse(line);
  onRecord(record);
}
```

One surprise from real-world use: Claude Code occasionally emits two
JSON records concatenated without a newline between them. Instead of
crashing, the reader tries a `}{` split recovery; if that fails it
warns and skips that one line. The session stays usable.

See `src/core/session.ts` — `streamRecords()`.

---

## 3. Export — making sessions portable

On Alice's machine, `claude-handoff export` walks her session files and
applies three transformations per record:

### 3a. Path rewriting

Absolute paths are everywhere in a session: the `cwd` field on every
record, `tool_use` inputs (`file_path`, `command`), `tool_result`
outputs (like `wc -l` stdout), message text, even inside `thinking`
blocks. We walk the record recursively and for every string value do:

- `/home/alice/projects/myapp` → `{{PROJECT_ROOT}}`
- `/home/alice` → `{{HOME}}`

Critically, this is **path-component-aware**, not string-replace. If
Alice's project is called `auth`, we do **not** rewrite the word "auth"
inside her code. A match has to be followed by `/`, end-of-string, a
quote, or whitespace — something that marks a path boundary.

See `src/core/paths.ts` — `localToPortable()`, `replaceWithBoundaryCheck()`.

### 3b. Secret redaction

Each string is scanned against 9 regex patterns: AWS keys, GitHub
tokens, Anthropic keys, OpenAI keys, bearer tokens, `password=...`
assignments, `user:pass@host` URLs, PEM private key blocks. Matches
are replaced with `[REDACTED:aws-key]` etc.

Users can add project-specific patterns via `.claude-handoff-ignore`
(one regex per line, `#` for comments). These get merged in with the
built-ins — one place to add "our internal employee IDs look like X".

Two important caveats baked into the design:

1. **Redaction is a safety rail, not a guarantee.** A regex can't
   catch every secret shape; the README says so out loud.
2. **`--no-redact` is gated.** You have to pass `--i-know-what-im-doing`
   too. Otherwise it's too easy to forget and push a raw session.

The tool writes `.claude-handoff/redaction-log.json` (local, gitignored)
so you can audit what got redacted before committing.

See `src/core/redactor.ts`.

### 3c. Streaming write

Transformed records get JSON-stringified one per line and streamed
back out to `.claude-shared/sessions/<timestamp>_<author>_<sid>.jsonl`.
Same pipeline as reading — no full-file buffering.

### What the manifest tracks

`.claude-shared/.manifest.json` is a little ledger: for each exported
session, what its original filename was, who exported it, when, and
how many redaction markers it contained. This lets `export` avoid
re-exporting the same session twice, and lets `list --verbose` show
per-session provenance.

---

## 4. The git step — on you

`claude-handoff export` writes files. It does **not** stage or commit.
You review `git diff .claude-shared/`, then `git add`, `git commit`,
`git push` yourself. This is a deliberate design choice — the tool
should never surprise you by publishing something. A session can
contain a lot of context; the human is the last line of defense.

---

## 5. Import — putting sessions on Neo's machine

`claude-handoff import` is the mirror:

1. Compute / reverse-match the slug for Neo's project root. If no
   slug directory exists yet (first time on this machine), we fall back
   to `computeSlug` to create one.
2. For each `.jsonl` under `.claude-shared/sessions/`, walk every string
   value and do the reverse rewrite:
   - `{{PROJECT_ROOT}}` → Neo's project root
   - `{{HOME}}` → Neo's home
3. Write the transformed record stream into
   `~/.claude/projects/<neo-slug>/<original-session-id>.jsonl`.
4. If a session with the same ID already exists locally, skip with a
   warning unless `--overwrite` was passed.

See `src/commands/import.ts` and `src/core/paths.ts` — `portableToLocal()`.

---

## 6. Why `/resume` picks these up automatically

This is the part that makes the whole thing work. We discovered in
Phase 0 that Claude Code's `/resume` picker is **not** index-backed —
it just scans `~/.claude/projects/<current-slug>/*.jsonl` at runtime,
reads the `custom-title` and `last-prompt` records inside each file,
and shows the picker. No `sessions-index.json` exists.

So as long as Neo's filesystem has the right `.jsonl` file in the
right slug directory with the right `cwd` field, Claude Code will find
it and offer to resume it. **That's the entire trick.** Getting files
into the right place, with the right contents, is all we need to do.

---

## 7. The full pipeline, top to bottom

```
Alice runs `claude-handoff export`
          │
          ▼
reverse-match slug  ──► list *.jsonl in ~/.claude/projects/<slug>/
          │
          ▼  (for each session file, streaming)
     read line
          │
          ▼
     JSON.parse  ──► recovery on failure (}{ split or skip+warn)
          │
          ▼
     deep walk record  ──► rewrite /home/alice/... → {{PROJECT_ROOT}}/{{HOME}}
          │                (boundary-safe; never inside code)
          ▼
     deep walk record  ──► redact secrets against 9 patterns + .claude-handoff-ignore
          │
          ▼
     JSON.stringify  ──► write one line to .claude-shared/sessions/<name>.jsonl
          │
          ▼
update manifest  ──► record what was exported, by whom, when, hit counts
          │
          ▼
write .claude-handoff/redaction-log.json  ──► local-only audit trail
          │
          ▼
print summary — tell user to git diff and commit

════════════════ git commit / push / pull ════════════════

Neo runs `claude-handoff import`
          │
          ▼
list *.jsonl in .claude-shared/sessions/
          │
          ▼  (for each file, streaming)
     read line
          │
          ▼
     deep walk record  ──► rewrite {{PROJECT_ROOT}} → /home/neo/...
          │
          ▼
     write one line to ~/.claude/projects/<neo-slug>/<sid>.jsonl
          │
          ▼
Neo opens Claude Code, types /resume
          │
          ▼
Claude Code scans the slug directory, reads the new file,
shows it in the picker with Alice's original title.
```

---

## 8. What could go wrong (and does)

- **Redaction gaps.** Regex is dumb. If your secret doesn't match a
  pattern, it goes through. Review the diff. Add custom patterns.
  This is why we're loud about `--no-redact` needing a second flag.
- **Schema drift.** The session JSONL schema is undocumented —
  Anthropic can change it any time. We deliberately don't validate
  every field; we walk strings and rewrite paths. That's fragile by
  choice: the tool breaks loudly when the schema changes rather than
  silently corrupting things.
- **Path boundary edge cases.** A project named like a common word
  (`auth`, `api`, `core`) could in principle cause over-matching.
  The boundary check is tested against these; if you hit a case it
  missed, the fix is in `replaceWithBoundaryCheck()`.
- **Big sessions.** Multi-MB session files bloat the repo over time.
  The README mentions `git-lfs` as an option. `--strip-progress`
  drops streaming updates (~half the records in long sessions) for a
  big file-size win, though whether `/resume` stays happy without
  them is still unverified in the wild.
- **Forking.** Alice exports, Neo imports, Neo continues, Neo exports.
  Now there are two session files with the same ID but different
  content. We currently just skip or overwrite; a real
  fork/merge story is TODO.

---

## 9. Where to look in the code

```
src/cli.ts                — commander setup, flag wiring, default action
src/commands/init.ts      — create .claude-shared/, update .gitignore
src/commands/export.ts    — Alice's pipeline
src/commands/import.ts    — Neo's pipeline
src/commands/status.ts    — local vs shared summary
src/commands/list.ts      — browse .claude-shared/
src/core/paths.ts         — slug lookup, path rewriting, deep walk
src/core/session.ts       — streaming read/write, recovery, meta extraction
src/core/redactor.ts      — patterns, deepRedact, custom pattern loader
src/core/manifest.ts      — .manifest.json read/write
scripts/roundtrip-test.sh — end-to-end Alice → repo → Neo test
test/core/                — unit tests per core module
test/fixtures/sessions/   — synthetic session files for tests
```

---

## 10. The design rules we didn't break

Worth stating explicitly, because they shaped every decision:

1. **Never modify user source files.** The tool only touches
   `~/.claude/` and `.claude-shared/`. It never writes into, moves,
   or deletes anything in the project's own code.
2. **Never auto-commit.** The tool writes files; humans run git.
3. **Redact by default, `--no-redact` needs a second confirmation.**
4. **Dry-run is the safe posture.** Nothing destructive runs without
   intent.
5. **Stream, don't buffer.** Session files can be big; memory stays flat.
6. **Be honest about limits.** README says out loud that redaction
   reduces but does not eliminate risk. The tool is a safety rail,
   not a vault.

That's the whole thing. The rest is plumbing.
