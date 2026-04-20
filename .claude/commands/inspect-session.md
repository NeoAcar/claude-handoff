---
description: Safely inspect a Claude Code session .jsonl file. Shows schema, path patterns, and potential secrets without dumping raw content.
---

You will inspect a Claude Code session `.jsonl` file at the path the user provides (or the most recently modified one in `~/.claude/projects/` if none given).

**Do not cat the file or dump its contents to the terminal.** Session files often contain secrets, API responses, and personal information. Your job is to summarize structure safely.

## Steps

1. **Locate the file.** If the user passed a path, use it. Otherwise find the most recent `.jsonl` under `~/.claude/projects/`:

   ```bash
   find ~/.claude/projects -name "*.jsonl" -type f -printf '%T@ %p\n' | sort -rn | head -1 | awk '{print $2}'
   ```

2. **Report file metadata** (size, line count, modification time) using `ls -lh` and `wc -l`. Do not read the content yet.

3. **Inspect schema from the first 3 lines only.** Use `head -3 <file> | jq 'keys'` to see top-level keys on each line. Report the distinct key sets you observe.

4. **Identify path-bearing fields.** For each distinct top-level structure, pick one sample line and use `jq` to extract where strings starting with `/` or `~` appear. Report the JSON paths (e.g., `.message.content[].input.file_path`) where absolute paths live. **Do not print the paths themselves** — just the locations.

5. **Scan for secret patterns** without printing matches. Run grep with `-c` (count only) for each pattern:

   ```bash
   grep -cE 'sk-ant-|ghp_|AKIA[0-9A-Z]{16}|-----BEGIN' <file>
   ```

   Report counts per pattern. If any are nonzero, flag this file as sensitive.

6. **Report field frequency** for the top-level `type` or equivalent discriminator field, if it exists:

   ```bash
   jq -r '.type // "unknown"' <file> | sort | uniq -c | sort -rn
   ```

7. **Produce a structured summary:**

   ```
   File: <path>
   Size: <human-readable>, Lines: <count>
   Last modified: <date>

   Schema:
     - Top-level keys observed: [key1, key2, ...]
     - Record types and counts: ...

   Path-bearing fields (locations, not values):
     - .field.subfield.path
     - ...

   Secret scan:
     - anthropic-key: <count>
     - github-token: <count>
     - aws-key: <count>
     - private-key-block: <count>

   Recommendation:
     [one of: "safe to use as fixture", "needs redaction before fixture use", "do not use — high-risk content"]
   ```

## Do Not

- Do not paste raw session content into the chat
- Do not read the file in full — streaming/sampling only
- Do not copy the file anywhere without user permission
- If the user asks to see content, extract one specific field from one specific line on explicit request, and warn about sensitivity before printing

Your output is a structured summary. That is all.
