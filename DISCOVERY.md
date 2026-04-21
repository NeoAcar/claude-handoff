# Phase 0 Discovery — Empirical Findings

**Date:** 2026-04-20
**Machine:** Linux
**Claude Code version:** 2.1.81+ (as seen in session files)

---

## 4.1 Directory Structure

### `~/.claude/` top-level

```
.credentials.json    — auth credentials (sensitive, never touch)
backups/
cache/
debug/
downloads/
file-history/        — per-session file backups
history.jsonl        — CLI command history
ide/
paste-cache/
plans/
plugins/
projects/            — ★ session storage, keyed by project slug
session-env/         — per-session env directories (mostly empty)
sessions/            — ephemeral PID→sessionId mapping for running sessions
settings.json
shell-snapshots/
statsig/
tasks/
telemetry/
todos/
```

### `~/.claude/projects/` — project slugs

Each directory under `~/.claude/projects/` corresponds to one project the user has worked on. The directory name is the project's absolute path with each character that is not alphanumeric or dash replaced by a dash.

Examples (generic):

```
-home-alice-projects-myapp
-home-alice-projects-data-pipeline
-home-alice-projects-claude-handoff
```

### Slug format (Linux)

**Rule:** Every character that is not ASCII alphanumeric and not a dash is replaced with a dash.

- `/home/alice/projects/myapp` → `-home-alice-projects-myapp`
- `/home/alice/projects/my_data_pipeline` → `-home-alice-projects-my-data-pipeline` (underscore → dash)
- `/home/alice/projects/Homework 3` → `-home-alice-projects-Homework-3` (space → dash)
- Leading slash becomes a leading dash.
- No trailing dash.

### Contents of a project slug directory

```
~/.claude/projects/-home-alice-projects-myapp/
├── <session-uuid>.jsonl                (session transcript)
├── <session-uuid>/                     (subagents dir, optional)
│   └── subagents/
│       ├── agent-*.jsonl
│       └── agent-*.meta.json
└── memory/
    ├── MEMORY.md
    └── *.md                            (individual memory files)
```

**Key observations:**

- Session files are `<uuid>.jsonl` — the UUID is the session ID
- Each session may have a companion directory `<uuid>/subagents/` for sub-agent transcripts
- `memory/` directory contains project-level auto-memory (MEMORY.md + individual memory files)

---

## 4.2 JSONL Session File Schema

Inspected two real session files on disk (one short, one large).

### Message types observed

| Type                    | Purpose                                     |
| ----------------------- | ------------------------------------------- |
| `progress`              | Streaming progress updates (tool execution) |
| `assistant`             | Claude's responses                          |
| `user`                  | User messages                               |
| `file-history-snapshot` | File state tracking for undo                |
| `custom-title`          | Session title (for /resume picker)          |
| `agent-name`            | Sub-agent naming                            |
| `system`                | System messages                             |
| `last-prompt`           | Last user prompt (for /resume display)      |

### Record schemas (by type)

#### `user` message

```json
{
  "parentUuid": null,
  "isSidechain": false,
  "promptId": "4c97ea58-...",
  "type": "user",
  "message": {
    "role": "user",
    "content": [{ "type": "text", "text": "..." }]
  },
  "uuid": "0d38e833-...",
  "timestamp": "2026-03-24T15:30:54.196Z",
  "permissionMode": "default",
  "userType": "external",
  "entrypoint": "claude-vscode",
  "cwd": "/home/alice/projects/myapp",      ← ABSOLUTE PATH
  "sessionId": "7d697ce2-...",
  "version": "2.1.81",
  "gitBranch": "main"
}
```

#### `assistant` message

```json
{
  "parentUuid": "0d38e833-...",
  "isSidechain": false,
  "message": {
    "role": "assistant",
    "content": [
      { "type": "thinking", "thinking": "..." },
      { "type": "tool_use", "id": "toolu_...", "name": "Read", "input": { "file_path": "/home/alice/..." } }
    ]
  },
  "requestId": "req_...",
  "type": "assistant",
  "uuid": "63d01f07-...",
  "timestamp": "2026-03-24T15:30:56.288Z",
  "userType": "external",
  "entrypoint": "claude-vscode",
  "cwd": "/home/alice/projects/myapp",      ← ABSOLUTE PATH
  "sessionId": "7d697ce2-...",
  "version": "2.1.81",
  "gitBranch": "main"
}
```

#### `custom-title`

```json
{
  "type": "custom-title",
  "customTitle": "example-session-title",
  "sessionId": "aaaaaaaa-..."
}
```

#### `last-prompt`

```json
{
  "type": "last-prompt",
  "lastPrompt": "how do i restart",
  "sessionId": "aaaaaaaa-..."
}
```

#### `file-history-snapshot`

```json
{
  "type": "file-history-snapshot",
  "messageId": "0d38e833-...",
  "snapshot": {
    "messageId": "...",
    "trackedFileBackups": {},
    "timestamp": "2026-03-24T15:30:54.197Z"
  },
  "isSnapshotUpdate": false
}
```

#### `queue-operation` (only seen in short sessions)

```json
{
  "type": "queue-operation",
  "operation": "enqueue",
  "timestamp": "2026-03-24T15:30:54.172Z",
  "sessionId": "aaaaaaaa-..."
}
```

### Where absolute paths appear

1. **Top-level `cwd` field** — on every `user` and `assistant` record
2. **`tool_use` inputs** — `file_path` in Read/Edit/Write, `command` in Bash
3. **`tool_result` outputs** — file contents, command outputs may contain paths
4. **`message.content[].text`** — user/assistant text may reference paths
5. **`thinking` blocks** — Claude's reasoning may reference paths

### Fields that do NOT contain paths

- `uuid`, `parentUuid`, `promptId`, `requestId` — pure IDs
- `timestamp` — ISO dates
- `type`, `userType`, `entrypoint`, `permissionMode` — enums
- `sessionId` — UUID
- `gitBranch` — branch name only

---

## 4.3 sessions-index.json

**FINDING: `sessions-index.json` DOES NOT EXIST.**

Searched the entire `~/.claude/` tree — no file by this name anywhere. The SPEC's assumption (Section 5.1, 5.2, 8) that `sessions-index.json` exists and powers `/resume` is **incorrect** for this version of Claude Code.

### How `/resume` actually works (inferred)

1. Claude Code computes the slug for the current CWD
2. It scans `~/.claude/projects/<slug>/*.jsonl` for session files
3. It reads `custom-title` and `last-prompt` records from within each JSONL file to populate the picker
4. Timestamps come from the JSONL records themselves

**Implication for the tool:** We do NOT need to generate or merge a `sessions-index.json`. We just need to place `.jsonl` files in the correct slug directory. The HANDOFF.md generator will need to parse session metadata from within the JSONL files instead.

### `~/.claude/sessions/` (ephemeral process registry)

Contains per-PID JSON files for currently running sessions:

```json
{
  "pid": 5020,
  "sessionId": "b396030e-...",
  "cwd": "/home/alice/projects/myapp",
  "startedAt": 1776696935461,
  "kind": "interactive",
  "entrypoint": "cli"
}
```

These are cleaned up when sessions end. Not relevant for export/import.

---

## 4.4 Auto-Memory Location

**Found at:** `~/.claude/projects/<slug>/memory/`

Structure:

```
memory/
├── MEMORY.md              (index file with links to individual memories)
├── feedback_*.md          (user feedback memories)
├── project_*.md           (project context memories)
└── ...
```

Memory files use YAML frontmatter:

```markdown
---
name: ...
description: ...
type: user|feedback|project|reference
---

Content here
```

**Decision:** Auto-memory is in-scope for the MVP since it lives right next to the session files and follows a simple, portable format. No absolute paths observed in memory files (they contain conceptual knowledge, not file references).

---

## 4.5 Hypothesis Test — Manual Round-Trip

### Test performed (clean setup)

1. Created `/tmp/handoff-test-project/` with `git init` and a `README.md`
2. Created `~/.claude/projects/-tmp-handoff-test-project/`
3. Copied a real session file to the destination as a fresh UUID
4. Rewrote all fields containing the original path to `/tmp/handoff-test-project`:
   - `cwd` (top-level) on every record
   - `sessionId` (remapped to the new UUID)
   - `tool_use` inputs (`file_path`, etc.)
   - `toolUseResult` (`stdout`, `notebook_path`, etc.)
5. Verified: zero occurrences of the old path or old session ID remaining

### Result

**PASSED.** The user opened a separate terminal, ran `claude --resume` from `/tmp/handoff-test-project/`, and confirmed:

1. The session appeared in the `/resume` picker
2. Selecting it loaded the **full chat history** from the original session
3. Context was fully restored — the session was usable

### Confirmed facts

- **Session discovery is filesystem-based.** `/resume` scans `~/.claude/projects/<slug>/*.jsonl`. No index file needed.
- **Fresh UUID filenames work.** The filename doesn't need to match the original session ID.
- **`cwd` rewrite is sufficient.** No other machine-identity field (user ID, machine ID, etc.) blocks session loading.
- **Cross-project transfer works.** A session from project A can be loaded in project B if the slug directory and `cwd` are set correctly.

### What this means for the tool

The core import mechanism is simple:

1. Compute target slug from CWD
2. Place rewritten `.jsonl` files in `~/.claude/projects/<slug>/`
3. Rewrite `cwd`, `sessionId`, and all path-bearing fields
4. Done — `/resume` picks them up automatically

---

## Additional Findings

### Subagent transcripts

Sessions that used the Agent tool have a companion directory:

```
<session-uuid>/subagents/agent-<hash>.jsonl
```

These are separate JSONL files for sub-agent conversations. They likely contain the same absolute paths. **For MVP:** include subagent files in export. They're part of the context.

### File sizes

- Small session: ~12 KB
- Medium session (with subagents): ~1–2 MB

For a typical project with 5-10 sessions, expect 5-20 MB in `.claude-shared/`. Worth noting in README; git-lfs may be recommended for large projects.

### `progress` records

These are streaming progress updates (tool execution output). They're roughly half of records by count. They may be safely excluded from export to reduce file size, as they're not needed for context resumption. **Test this assumption in Phase 1.**

---

## Flags / Deviations from SPEC

1. **`sessions-index.json` does not exist.** SPEC Sections 5.1, 5.2, and 8 reference it. The HANDOFF.md generator must parse metadata from JSONL files directly instead.

2. **Memory files are plain markdown with frontmatter.** They don't contain absolute paths and are highly portable as-is. They could be included in handoff with minimal transformation.

3. **The `thinking` field in assistant messages may contain sensitive reasoning.** Consider whether to include or strip thinking blocks on export (they may reference secrets or internal decision-making the user prefers not to share).

---

## Go / No-Go Decision

**GO.** The core mechanism is sound:

- Sessions live in a predictable filesystem location
- They're self-contained JSONL files
- Discovery is by filesystem scan, not by an opaque index
- Path rewriting targets are clearly identifiable (top-level `cwd`, tool inputs, message text)
- No `sessions-index.json` simplifies the design (one less file to manage)

Proceed to Phase 1 implementation.
