#!/usr/bin/env bash
set -euo pipefail

#
# roundtrip-test.sh — End-to-end round-trip test for claude-handoff.
#
# Simulates: Alice exports a session → git push/pull → Bob imports it.
# Validates that the final session file exists with correct cwd rewriting.
#
# SAFETY: Only touches ~/.claude/projects/-tmp-handoff-rt-* paths.
# Will not run if those patterns don't match expectations.
#

# --- Configuration ---
ALICE_DIR="/tmp/handoff-rt-alice"
BOB_DIR="/tmp/handoff-rt-bob"
ALICE_SLUG="-tmp-handoff-rt-alice"
BOB_SLUG="-tmp-handoff-rt-bob"
CLAUDE_PROJECTS="$HOME/.claude/projects"
CLI="$(cd "$(dirname "$0")/.." && pwd)/dist/cli.js"

# Source session to copy (short, 72 lines, NLP homework)
SOURCE_SESSION="$CLAUDE_PROJECTS/-home-neo-Dersler-NLP-Homework-3/50fba2b0-0a44-4893-ac5b-4b2b6513830e.jsonl"
SOURCE_CWD="/home/neo/Dersler/NLP/Homework 3"
ALICE_SESSION_ID="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"

# --- Safety checks ---
echo "=== SAFETY CHECKS ==="

# Verify we're only touching -tmp-handoff-rt-* paths
if [[ "$ALICE_SLUG" != -tmp-handoff-rt-* ]]; then
    echo "ABORT: ALICE_SLUG '$ALICE_SLUG' does not match safety pattern -tmp-handoff-rt-*"
    exit 1
fi
if [[ "$BOB_SLUG" != -tmp-handoff-rt-* ]]; then
    echo "ABORT: BOB_SLUG '$BOB_SLUG' does not match safety pattern -tmp-handoff-rt-*"
    exit 1
fi

# Verify source session exists
if [[ ! -f "$SOURCE_SESSION" ]]; then
    echo "ABORT: Source session not found at $SOURCE_SESSION"
    echo "Pick a different session file and update the script."
    exit 1
fi

# Verify CLI is built
if [[ ! -f "$CLI" ]]; then
    echo "ABORT: CLI not built. Run 'npm run build' first."
    exit 1
fi

echo "  ALICE_SLUG: $ALICE_SLUG (safe)"
echo "  BOB_SLUG:   $BOB_SLUG (safe)"
echo "  Source:     $SOURCE_SESSION (exists)"
echo "  CLI:        $CLI (exists)"
echo ""

# --- Cleanup from previous runs ---
echo "=== CLEANUP ==="
rm -rf "$ALICE_DIR" "$BOB_DIR"
rm -rf "$CLAUDE_PROJECTS/$ALICE_SLUG"
rm -rf "$CLAUDE_PROJECTS/$BOB_SLUG"
echo "  Cleaned previous test artifacts"
echo ""

# --- Step 1: Create test project directories ---
echo "=== STEP 1: Create test project directories ==="
mkdir -p "$ALICE_DIR"
mkdir -p "$BOB_DIR"
cd "$ALICE_DIR" && git init && echo "# Alice's project" > README.md && git add . && git commit -m "init" --quiet
cd "$BOB_DIR" && git init && echo "# Bob's project" > README.md && git add . && git commit -m "init" --quiet
echo "  Created $ALICE_DIR (git init)"
echo "  Created $BOB_DIR (git init)"
echo ""

# --- Step 2: Create fake slug directory with rewritten session ---
echo "=== STEP 2: Create Alice's slug directory with rewritten session ==="
mkdir -p "$CLAUDE_PROJECTS/$ALICE_SLUG"

python3 - "$SOURCE_SESSION" "$CLAUDE_PROJECTS/$ALICE_SLUG/$ALICE_SESSION_ID.jsonl" "$SOURCE_CWD" "$ALICE_DIR" "$ALICE_SESSION_ID" << 'PYEOF'
import json
import sys

src_path, dst_path, old_cwd, new_cwd, new_sid = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]

# Read original session ID from the file
with open(src_path) as f:
    lines = f.readlines()

old_sid = None
for line in lines:
    d = json.loads(line)
    if d.get('sessionId'):
        old_sid = d['sessionId']
        break

if not old_sid:
    print("ERROR: No sessionId found in source file", file=sys.stderr)
    sys.exit(1)

def rewrite(v):
    if isinstance(v, str):
        v = v.replace(old_cwd, new_cwd)
        if old_sid:
            v = v.replace(old_sid, new_sid)
        return v
    if isinstance(v, list):
        return [rewrite(x) for x in v]
    if isinstance(v, dict):
        return {k: rewrite(val) for k, val in v.items()}
    return v

output = []
for line in lines:
    d = json.loads(line)
    d = rewrite(d)
    output.append(json.dumps(d, separators=(',', ':')))

with open(dst_path, 'w') as f:
    for line in output:
        f.write(line + '\n')

print(f"  Copied and rewrote {len(output)} records")
print(f"  Old CWD: {old_cwd}")
print(f"  New CWD: {new_cwd}")
print(f"  Old SID: {old_sid}")
print(f"  New SID: {new_sid}")
PYEOF

echo "  Session file: $CLAUDE_PROJECTS/$ALICE_SLUG/$ALICE_SESSION_ID.jsonl"
echo ""

# Verify the rewrite
echo "=== STEP 2 verification: cwd values in Alice's session ==="
python3 -c "
import json
with open('$CLAUDE_PROJECTS/$ALICE_SLUG/$ALICE_SESSION_ID.jsonl') as f:
    cwds = set()
    for line in f:
        d = json.loads(line)
        if 'cwd' in d:
            cwds.add(d['cwd'])
    for c in sorted(cwds):
        print(f'  cwd found: {c}')
    if '$ALICE_DIR' in cwds:
        print('  OK: CWD correctly set to Alice path')
    else:
        print('  WARNING: Expected $ALICE_DIR in cwd values')
"
echo ""

# --- Step 3: Run claude-handoff init + export from Alice's dir ---
echo "=== STEP 3: Alice runs init + export ==="
cd "$ALICE_DIR"
echo "  Running: node $CLI init"
node "$CLI" init
echo ""
echo "  Running: node $CLI export"
node "$CLI" export
echo ""

# Verify export output
echo "=== STEP 3 verification: exported files ==="
echo "  .claude-shared/ contents:"
find "$ALICE_DIR/.claude-shared/" -type f | sort | while read -r f; do
    echo "    $f"
done

# Check that exported session contains placeholders, not Alice's paths
echo ""
echo "  Checking for portable placeholders in exported session:"
EXPORTED_SESSION=$(find "$ALICE_DIR/.claude-shared/sessions/" -name "*.jsonl" | head -1)
if [[ -n "$EXPORTED_SESSION" ]]; then
    python3 -c "
import json
with open('$EXPORTED_SESSION') as f:
    has_placeholder = False
    has_alice_path = False
    for line in f:
        if '{{PROJECT_ROOT}}' in line:
            has_placeholder = True
        if '$ALICE_DIR' in line:
            has_alice_path = True
    if has_placeholder:
        print('  OK: Contains {{PROJECT_ROOT}} placeholders')
    else:
        print('  FAIL: No {{PROJECT_ROOT}} placeholders found')
    if has_alice_path:
        print('  FAIL: Still contains Alice absolute path')
    else:
        print('  OK: Alice absolute path removed')
"
else
    echo "  FAIL: No exported .jsonl file found"
fi
echo ""

# --- Step 4: Copy .claude-shared/ from Alice to Bob (simulates git push/pull) ---
echo "=== STEP 4: Copy .claude-shared/ from Alice to Bob ==="
cp -r "$ALICE_DIR/.claude-shared" "$BOB_DIR/.claude-shared"
echo "  Copied .claude-shared/ to Bob's directory"
echo ""

# --- Step 5: Run claude-handoff import from Bob's dir ---
echo "=== STEP 5: Bob runs import ==="
cd "$BOB_DIR"
echo "  Running: node $CLI import"
node "$CLI" import
echo ""

# --- Step 6: Verify Bob's session file ---
echo "=== STEP 6: Verify Bob's imported session ==="
BOB_SLUG_DIR="$CLAUDE_PROJECTS/$BOB_SLUG"
echo "  Bob's slug directory: $BOB_SLUG_DIR"
echo "  Contents:"
ls -la "$BOB_SLUG_DIR/" 2>&1 | while read -r line; do
    echo "    $line"
done
echo ""

BOB_SESSION=$(find "$BOB_SLUG_DIR" -name "*.jsonl" 2>/dev/null | head -1)
if [[ -z "$BOB_SESSION" ]]; then
    echo "  FAIL: No .jsonl file found in Bob's slug directory"
    echo ""
    echo "=== RESULT: FAIL ==="
    exit 1
fi

echo "  Bob's session file: $BOB_SESSION"
echo ""

echo "  Checking cwd values in Bob's session:"
python3 -c "
import json
with open('$BOB_SESSION') as f:
    cwds = set()
    has_placeholder = False
    has_alice = False
    has_bob = False
    has_original = False
    for line in f:
        d = json.loads(line)
        if 'cwd' in d:
            cwds.add(d['cwd'])
        if '{{PROJECT_ROOT}}' in line:
            has_placeholder = True
        if '$ALICE_DIR' in line:
            has_alice = True
        if '$BOB_DIR' in line:
            has_bob = True
        if '$SOURCE_CWD' in line:
            has_original = True

    for c in sorted(cwds):
        print(f'  cwd: {c}')

    print()
    if '$BOB_DIR' in cwds:
        print('  OK: CWD is Bob path ($BOB_DIR)')
    else:
        print('  FAIL: CWD is not Bob path')

    if has_placeholder:
        print('  FAIL: Still contains {{PROJECT_ROOT}} placeholders')
    else:
        print('  OK: No remaining placeholders')

    if has_alice:
        print('  FAIL: Still contains Alice path ($ALICE_DIR)')
    else:
        print('  OK: No Alice paths remaining')

    if has_original:
        print('  FAIL: Still contains original path ($SOURCE_CWD)')
    else:
        print('  OK: No original project paths remaining')
"
echo ""

# --- Step 7: Check a specific tool_use record to verify deep rewriting ---
echo "=== STEP 7: Verify tool_use input paths ==="
python3 -c "
import json
with open('$BOB_SESSION') as f:
    for i, line in enumerate(f):
        d = json.loads(line)
        msg = d.get('message', {})
        content = msg.get('content', [])
        if isinstance(content, list):
            for c in content:
                if isinstance(c, dict) and c.get('type') == 'tool_use':
                    inp = c.get('input', {})
                    fp = inp.get('file_path', '')
                    cmd = inp.get('command', '')
                    if fp:
                        ok = fp.startswith('$BOB_DIR')
                        status = 'OK' if ok else 'FAIL'
                        print(f'  Line {i+1}: {c[\"name\"]} file_path={fp[:80]} [{status}]')
                    if cmd and '$BOB_DIR' in cmd:
                        print(f'  Line {i+1}: {c[\"name\"]} command contains Bob path [OK]')
                    if cmd and '$ALICE_DIR' in cmd:
                        print(f'  Line {i+1}: {c[\"name\"]} command still has Alice path [FAIL]')
                    if cmd and '$SOURCE_CWD' in cmd:
                        print(f'  Line {i+1}: {c[\"name\"]} command still has original path [FAIL]')
" 2>&1 || echo "  (no tool_use records found or error)"
echo ""

# --- Summary ---
echo "=========================================="
echo "=== ROUND-TRIP TEST COMPLETE ==="
echo "=========================================="
echo ""
echo "Bob's session file ready at:"
echo "  $BOB_SESSION"
echo ""
echo "To manually verify with Claude Code:"
echo "  cd $BOB_DIR && claude --resume"
echo ""
echo "To cleanup after testing:"
echo "  rm -rf $ALICE_DIR $BOB_DIR $CLAUDE_PROJECTS/$ALICE_SLUG $CLAUDE_PROJECTS/$BOB_SLUG"
