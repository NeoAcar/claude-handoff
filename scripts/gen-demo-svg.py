"""Regenerate the README terminal animations.

    python3 scripts/gen-demo-svg.py docs/demo.svg            # repo handoff
    python3 scripts/gen-demo-svg.py docs/demo-archive.svg archive

Add a final argument A or B to write a static frame of that scene instead
(everything visible), for checking the layout.
"""

import html
import sys

W, FS, CW, LH, X0, Y0 = 900, 13, 7.83, 24, 24, 92
SID = "084c4bf8-2d1e-4c7a-9b3f-5e6a7c8d9e0f"
KNOWN = "Known secret values to scrub: 2 (DB_PASSWORD, STRIPE_SECRET_KEY) from .env, the environment"
EXPORTED = f"  Exported: {SID}/ — Fix login bug (212 records + 2 sidecar(s))"
IMPORTED = f"  Imported: {SID}.jsonl — Fix login bug (3 artifact(s) + 2 sidecar(s))"
REDACTED = "Redacted: 5 unique secret(s), 8 marker(s) written across fields"

# Each scene: (label, who, [steps]). A step is ("cmd", row, text, t0, t1) or
# ("out", row, text, t, css_class). Times are seconds from the scene start.
DEMOS = {
    "repo": {
        "height": 400,
        "label": "claude-handoff demo: Alice exports a Claude Code session and pushes it; "
        "Neo pulls, imports and resumes it.",
        "scenes": [
            ("① Alice's machine — export", "alice", 12.4, [
                ("cmd", 0, 'claude-handoff export "login bug"', 0.8, 2.4),
                ("out", 1, KNOWN, 2.9, "n"),
                ("out", 2, EXPORTED, 3.4, "o"),
                ("out", 3, "Exported 1 session(s) to .claude-shared/", 3.7, "o"),
                ("out", 4, REDACTED, 4.0, "w"),
                ("out", 5, "  by pattern: env-value=4, account-email=2, github-token=1, account-org=1", 4.2, "w"),
                ("out", 6, "Before committing, run: git diff .claude-shared/", 4.5, "d"),
                ("cmd", 8, 'git add .claude-shared && git commit -m "handoff" && git push', 6.4, 9.2),
                ("out", 9, "   3f2a1c9..8d4e7b2  main -> main", 9.8, "d"),
                ("out", 11, "→ secrets scrubbed, the session now travels with the repo", 10.4, "n"),
            ]),
            ("② Neo's machine — import &amp; resume", "neo", 11.8, [
                ("cmd", 0, "git pull", 0.7, 1.3),
                ("out", 1, "Updating 3f2a1c9..8d4e7b2", 1.8, "d"),
                ("cmd", 3, "claude-handoff import", 2.7, 3.9),
                ("out", 4, IMPORTED, 4.4, "o"),
                ("out", 5, "Imported 1 session(s)", 4.7, "o"),
                ("out", 6, "Or jump straight in:", 5.0, "d"),
                ("out", 7, f"  claude --resume {SID}", 5.2, "d"),
                ("cmd", 9, f"claude --resume {SID}", 6.2, 8.0),
                ("out", 11, "✓ “Fix login bug” resumes on Neo’s machine with its full history", 8.7, "ok"),
            ]),
        ],
    },
    "archive": {
        "height": 304,
        "label": "claude-handoff demo: exporting a session to a single file and importing it "
        "elsewhere, with no shared repository.",
        "scenes": [
            ("① Sender — no shared repo", "alice", 9.2, [
                ("cmd", 0, 'claude-handoff export "login bug" -o login-bug.handoff.tgz', 0.8, 3.2),
                ("out", 1, KNOWN, 3.7, "n"),
                ("out", 2, EXPORTED, 4.2, "o"),
                ("out", 3, "Exported 1 session(s)", 4.5, "o"),
                ("out", 4, REDACTED, 4.8, "w"),
                ("out", 5, "Wrote /home/alice/myproject/login-bug.handoff.tgz (148.3 KB)", 5.3, "o"),
                ("out", 7, "→ one checksummed file: send it any way you like", 6.4, "n"),
            ]),
            ("② Receiver — import &amp; resume", "neo", 9.8, [
                ("cmd", 0, "claude-handoff import login-bug.handoff.tgz", 0.7, 2.6),
                ("out", 1, "Archive verified: 6 file(s), written by claude-handoff 0.3.0", 3.1, "n"),
                ("out", 2, IMPORTED, 3.6, "o"),
                ("out", 3, "Imported 1 session(s)", 3.9, "o"),
                ("cmd", 5, f"claude --resume {SID}", 4.9, 6.7),
                ("out", 7, "✓ “Fix login bug” resumes with its full history — no repo involved", 7.4, "ok"),
            ]),
        ],
    },
}


def build(demo, static):
    scenes = demo["scenes"]
    total = sum(duration for _, _, duration, _ in scenes)
    height = demo["height"]
    clips, groups = [], []

    def key_times(*times):
        return ";".join(f"{t / total:.4f}" for t in times)

    def appear(t):
        if static:
            return ""
        return (f'<animate attributeName="opacity" dur="{total}s" repeatCount="indefinite" '
                f'calcMode="discrete" values="0;1" keyTimes="{key_times(0, t)}"/>')

    start = 0.0
    for index, (label, who, duration, steps) in enumerate(scenes):
        name = "AB"[index]
        body = []
        for step in steps:
            y = Y0 + step[1] * LH
            if step[0] == "out":
                _, _, text, t, css = step
                body.append(f'<text x="{X0}" y="{y}" class="{css}" opacity="{1 if static else 0}" '
                            f'xml:space="preserve">{html.escape(text)}{appear(start + t)}</text>')
                continue
            _, _, text, t0, t1 = step
            t0, t1 = start + t0, start + t1
            prompt = f"{who}:~/myproject$ "
            px = X0 + len(prompt) * CW
            width = len(text) * CW + 2
            clip_id = f"c{len(clips)}"
            body.append(f'<text x="{X0}" y="{y}" class="p {who}" opacity="{1 if static else 0}" '
                        f'xml:space="preserve">{prompt}{appear(t0 - 0.35)}</text>')
            grow = "" if static else (
                f'<animate attributeName="width" dur="{total}s" repeatCount="indefinite" '
                f'values="0;0;{width:.1f};{width:.1f}" keyTimes="{key_times(0, t0, t1, total)}"/>')
            clips.append(f'<clipPath id="{clip_id}"><rect x="{px:.1f}" y="{y - 16}" '
                         f'width="{width if static else 0:.1f}" height="22">{grow}</rect></clipPath>')
            body.append(f'<text x="{px:.1f}" y="{y}" class="c" clip-path="url(#{clip_id})" '
                        f'xml:space="preserve">{html.escape(text)}</text>')
            if not static:
                body.append(
                    f'<rect y="{y - 13}" width="8" height="16" class="cur" opacity="0">'
                    f'<animate attributeName="x" dur="{total}s" repeatCount="indefinite" '
                    f'values="{px:.1f};{px:.1f};{px + width:.1f};{px + width:.1f}" '
                    f'keyTimes="{key_times(0, t0, t1, total)}"/>'
                    f'<animate attributeName="opacity" dur="{total}s" repeatCount="indefinite" '
                    f'calcMode="discrete" values="0;1;0" keyTimes="{key_times(0, t0 - 0.35, t1 + 0.45)}"/>'
                    f'</rect>')

        end = start + duration
        if static:
            opacity, fade = (1 if static == name else 0), ""
        elif start == 0:
            opacity = 1
            fade = (f'<animate attributeName="opacity" dur="{total}s" repeatCount="indefinite" '
                    f'calcMode="discrete" values="1;0" keyTimes="{key_times(0, end)}"/>')
        else:
            opacity = 0
            fade = (f'<animate attributeName="opacity" dur="{total}s" repeatCount="indefinite" '
                    f'calcMode="discrete" values="0;1;0" keyTimes="{key_times(0, start, end)}"/>'
                    if end < total else
                    f'<animate attributeName="opacity" dur="{total}s" repeatCount="indefinite" '
                    f'calcMode="discrete" values="0;1" keyTimes="{key_times(0, start)}"/>')
        groups.append(f'<g opacity="{opacity}">{fade}\n<text x="{W / 2}" y="27" class="tab" '
                      f'text-anchor="middle">{label}</text>\n' + "\n".join(body) + "\n</g>")
        start = end

    nl = "\n"
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {height}" width="{W}" height="{height}" role="img" aria-label="{demo["label"]}">
<style>
text {{ font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; font-size: {FS}px; }}
.o {{ fill: #c9d1d9; }} .d {{ fill: #8b949e; }} .w {{ fill: #e3b341; }} .c {{ fill: #f0f6fc; }}
.n {{ fill: #79c0ff; }} .ok {{ fill: #56d364; font-weight: 600; }}
.p {{ font-weight: 600; }} .alice {{ fill: #f778ba; }} .neo {{ fill: #39c5cf; }}
.tab {{ fill: #c9d1d9; font-size: 13px; font-weight: 600; }} .cur {{ fill: #c9d1d9; }}
</style>
<defs>
{nl.join(clips)}
</defs>
<rect width="{W}" height="{height}" rx="10" fill="#0d1117"/>
<rect width="{W}" height="42" rx="10" fill="#161b22"/><rect y="32" width="{W}" height="10" fill="#161b22"/>
<rect x="0.5" y="0.5" width="{W - 1}" height="{height - 1}" rx="10" fill="none" stroke="#30363d"/>
<circle cx="22" cy="21" r="6" fill="#ff5f56"/><circle cx="42" cy="21" r="6" fill="#ffbd2e"/><circle cx="62" cy="21" r="6" fill="#27c93f"/>
{nl.join(groups)}
</svg>
'''


def main():
    args = sys.argv[1:]
    if not args:
        sys.exit(__doc__)
    out = args[0]
    static = args[-1] if len(args) > 1 and args[-1] in ("A", "B") else ""
    name = args[1] if len(args) > 1 and args[1] in DEMOS else "repo"
    with open(out, "w") as f:
        f.write(build(DEMOS[name], static))


main()
