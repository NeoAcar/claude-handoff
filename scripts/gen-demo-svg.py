"""Regenerate the README terminal animation: python3 scripts/gen-demo-svg.py docs/demo.svg

Pass a third argument (A or B) to write a static frame of that scene for layout checks.
"""
import sys, html
T=23.0; W=900; H=400; FS=13; CW=7.83; LH=24; X0=24; Y0=92
SID='084c4bf8-2d1e-4c7a-9b3f-5e6a7c8d9e0f'
static = len(sys.argv)>2 and sys.argv[2]            # 'A' or 'B' → everything visible, for layout checks
def kt(*ts): return ';'.join(f'{t/T:.4f}' for t in ts)
def show(t):                                           # discrete appear at t
    if static: return ''
    return f'<animate attributeName="opacity" dur="{T}s" repeatCount="indefinite" calcMode="discrete" values="0;1" keyTimes="{kt(0,t)}"/>'
out=[]; clips=[]
def line(row, text, t, cls='o'):
    y=Y0+row*LH
    out.append(f'<text x="{X0}" y="{y}" class="{cls}" opacity="{1 if static else 0}" xml:space="preserve">{html.escape(text)}{show(t)}</text>')
def cmd(row, who, text, t0, t1):
    y=Y0+row*LH; prompt=f'{who}:~/myproject$ '; px=X0+len(prompt)*CW; w=len(text)*CW+2; cid=f'c{len(clips)}'
    out.append(f'<text x="{X0}" y="{y}" class="p {who}" opacity="{1 if static else 0}" xml:space="preserve">{prompt}{show(t0-0.35)}</text>')
    anim='' if static else f'<animate attributeName="width" dur="{T}s" repeatCount="indefinite" values="0;0;{w:.1f};{w:.1f}" keyTimes="{kt(0,t0,t1,T)}"/>'
    clips.append(f'<clipPath id="{cid}"><rect x="{px:.1f}" y="{y-16}" width="{w if static else 0:.1f}" height="22">{anim}</rect></clipPath>')
    out.append(f'<text x="{px:.1f}" y="{y}" class="c" clip-path="url(#{cid})" xml:space="preserve">{html.escape(text)}</text>')
    if not static:
        out.append(f'<rect y="{y-13}" width="8" height="16" class="cur" opacity="0">'
                   f'<animate attributeName="x" dur="{T}s" repeatCount="indefinite" values="{px:.1f};{px:.1f};{px+w:.1f};{px+w:.1f}" keyTimes="{kt(0,t0,t1,T)}"/>'
                   f'<animate attributeName="opacity" dur="{T}s" repeatCount="indefinite" calcMode="discrete" values="0;1;0" keyTimes="{kt(0,t0-0.35,t1+0.45)}"/></rect>')
def scene(name, label, t_on, t_off, body):
    global out
    saved=out; out=[]; body(); inner='\n'.join(out); out=saved
    if static: op = 1 if static==name else 0; anim=''
    else:
        op=0
        anim=f'<animate attributeName="opacity" dur="{T}s" repeatCount="indefinite" calcMode="discrete" values="0;1;0" keyTimes="{kt(0,t_on,t_off)}"/>' if t_on>0 else \
             f'<animate attributeName="opacity" dur="{T}s" repeatCount="indefinite" calcMode="discrete" values="1;0" keyTimes="{kt(0,t_off)}"/>'
        if t_on==0: op=1
    out.append(f'<g opacity="{op}">{anim}\n<text x="{W/2}" y="27" class="tab" text-anchor="middle">{label}</text>\n{inner}\n</g>')
def alice():
    cmd(0,'alice','claude-handoff export --session "upload"',0.8,2.8)
    line(1,f'  Exported: {SID}/ — Fix upload timeout (212 records + 2 sidecar(s))',3.3)
    line(2,'Exported 1 session(s) to .claude-shared/',3.6)
    line(3,'Redacted: 3 unique secret(s), 5 marker(s) written across fields',3.9,'w')
    line(4,'Before committing, run: git diff .claude-shared/',4.2,'d')
    cmd(6,'alice','git add .claude-shared && git commit -m "handoff" && git push',5.6,8.4)
    line(7,'   3f2a1c9..8d4e7b2  main -> main',9.0,'d')
    line(9,'→ the session now travels with the repo',9.6,'n')
def neo():
    cmd(0,'neo','git pull',11.9,12.5)
    line(1,'Updating 3f2a1c9..8d4e7b2',13.0,'d')
    cmd(3,'neo','claude-handoff import',13.9,15.1)
    line(4,f'  Imported: {SID}.jsonl — Fix upload timeout (3 artifact(s) + 2 sidecar(s))',15.6)
    line(5,'Imported 1 session(s)',15.9)
    line(6,'Or jump straight in:',16.2,'d')
    line(7,f'  claude --resume {SID}',16.4,'d')
    cmd(9,'neo',f'claude --resume {SID}',17.4,19.2)
    line(11,'✓ “Fix upload timeout” resumes on Neo’s machine with its full history',19.9,'ok')
scene('A',"① Alice's machine — export",0,11.2,alice)
scene('B',"② Neo's machine — import &amp; resume",11.2,T,neo)
svg=f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-label="claude-handoff demo: Alice exports a Claude Code session and pushes it; Neo pulls, imports and resumes it.">
<style>
text {{ font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; font-size: {FS}px; }}
.o {{ fill: #c9d1d9; }} .d {{ fill: #8b949e; }} .w {{ fill: #e3b341; }} .c {{ fill: #f0f6fc; }}
.n {{ fill: #79c0ff; }} .ok {{ fill: #56d364; font-weight: 600; }}
.p {{ font-weight: 600; }} .alice {{ fill: #f778ba; }} .neo {{ fill: #39c5cf; }}
.tab {{ fill: #c9d1d9; font-size: 13px; font-weight: 600; }} .cur {{ fill: #c9d1d9; }}
</style>
<defs>
{chr(10).join(clips)}
</defs>
<rect width="{W}" height="{H}" rx="10" fill="#0d1117"/>
<rect width="{W}" height="42" rx="10" fill="#161b22"/><rect y="32" width="{W}" height="10" fill="#161b22"/>
<rect x="0.5" y="0.5" width="{W-1}" height="{H-1}" rx="10" fill="none" stroke="#30363d"/>
<circle cx="22" cy="21" r="6" fill="#ff5f56"/><circle cx="42" cy="21" r="6" fill="#ffbd2e"/><circle cx="62" cy="21" r="6" fill="#27c93f"/>
{chr(10).join(out)}
</svg>
'''
open(sys.argv[1],'w').write(svg)
