#!/usr/bin/env python3
"""Status bars for tracked work.

Terminal first, because that is where Daksh will actually look at it day to day.
`render_html` produces the same view as a standalone page, which is the seed of the
artifact idea — it deliberately takes no arguments beyond the records and inlines
its own CSS, so publishing it later is a copy rather than a rewrite.
"""
from grades import model

BAR_WIDTH = 22

# The bar is a lifecycle, not a percentage: four segments, filled up to the state
# the item has reached. A graded item additionally shows its score, which is the
# only place a number appears — and it appears only on this machine.
FILL = {"pending": 0, "in_progress": 1, "completed": 2, "graded": 4}
LABEL = {"pending": "pending", "in_progress": "in progress",
         "completed": "completed", "graded": "graded"}


def bar(state, width=BAR_WIDTH):
    filled = int(round(width * FILL[state] / 4))
    return "█" * filled + "░" * (width - filled)


def line(rec):
    pct = "" if rec.get("percent") is None else f"  {rec['percent']:.0f}%"
    flag = "  OVERDUE" if model.is_overdue(rec) else ""
    return "  %s  %-34s %-12s%s%s" % (
        bar(rec["state"]), rec["item"][:34], LABEL[rec["state"]], pct, flag)


def render_text(records):
    by_course = {}
    for r in records:
        by_course.setdefault(r["course"], []).append(r)
    out = []
    for course in sorted(by_course):
        items = sorted(by_course[course],
                       key=lambda r: (model.RANK[r["state"]], r["item"]))
        graded = [r for r in items if r.get("percent") is not None]
        head = f"{course}  ({len(items)} tracked"
        if graded:
            avg = sum(r["percent"] for r in graded) / len(graded)
            head += f", {len(graded)} graded, avg {avg:.0f}%"
        out.append(head + ")")
        out += [line(r) for r in items]
        out.append("")
    return "\n".join(out).rstrip() or "nothing tracked yet"


def render_html(records, title="Coursework status"):
    """Self-contained page — no external CSS, no fonts, no scripts."""
    by_course = {}
    for r in records:
        by_course.setdefault(r["course"], []).append(r)

    rows = []
    for course in sorted(by_course):
        items = sorted(by_course[course],
                       key=lambda r: (model.RANK[r["state"]], r["item"]))
        graded = [r for r in items if r.get("percent") is not None]
        sub = f"{len(items)} tracked"
        if graded:
            avg = sum(r["percent"] for r in graded) / len(graded)
            sub += f" · {len(graded)} graded · avg {avg:.0f}%"
        rows.append(f'<h2>{esc(course)}<span class="sub">{esc(sub)}</span></h2>')
        for r in items:
            pct = "" if r.get("percent") is None else f'<span class="pct">{r["percent"]:.0f}%</span>'
            od = '<span class="od">overdue</span>' if model.is_overdue(r) else ""
            rows.append(
                f'<div class="row"><div class="name">{esc(r["item"])}</div>'
                f'<div class="bar s{FILL[r["state"]]}"><i></i></div>'
                f'<div class="state">{LABEL[r["state"]]}{pct}{od}</div></div>')

    return f"""<title>{esc(title)}</title>
<style>
:root {{ color-scheme: light dark; --fg:#111; --mut:#666; --line:#e5e5e5; --fill:#2f6fed; --od:#b4232c; }}
@media (prefers-color-scheme: dark) {{
  :root {{ --fg:#e9e9e9; --mut:#9a9a9a; --line:#2a2a2a; --fill:#5b8dfb; --od:#ff6b6b; }}
}}
body {{ font:15px/1.5 ui-sans-serif,-apple-system,Segoe UI,Roboto,sans-serif; color:var(--fg);
       max-width:820px; margin:2rem auto; padding:0 1rem; }}
h2 {{ font-size:1rem; margin:1.8rem 0 .6rem; border-bottom:1px solid var(--line); padding-bottom:.35rem; }}
.sub {{ float:right; font-weight:400; color:var(--mut); font-size:.85rem; }}
.row {{ display:grid; grid-template-columns:1fr 140px 150px; gap:.75rem; align-items:center;
        padding:.35rem 0; }}
.name {{ overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }}
.bar {{ height:8px; border-radius:4px; background:var(--line); overflow:hidden; }}
.bar i {{ display:block; height:100%; background:var(--fill); }}
.s0 i {{ width:0 }} .s1 i {{ width:25% }} .s2 i {{ width:50% }} .s4 i {{ width:100% }}
.state {{ color:var(--mut); font-size:.85rem; }}
.pct {{ color:var(--fg); font-weight:600; margin-left:.4rem; }}
.od {{ color:var(--od); margin-left:.4rem; }}
@media (max-width:600px) {{ .row {{ grid-template-columns:1fr; }} .sub {{ float:none; display:block; }} }}
</style>
<h1>{esc(title)}</h1>
{"".join(rows)}
"""


def esc(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))
