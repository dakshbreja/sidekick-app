#!/usr/bin/env python3
"""Refresh the semester board from the status bridge, then render semester.html.

The board covers the whole term, Aug 17 - Dec 13. `/status` does not: the Worker
only loads events within LOOKBACK/LOOKAHEAD of now (10 days back, 45 forward), so
one call can speak for about eight weeks of the sixteen. That is the entire reason
this is a merge rather than a fetch.

  * Inside the window the bridge is authoritative. Dates that moved are corrected,
    items the feeds have gained are added, and completion comes from the bridge
    rather than a list maintained by hand.
  * Outside it the snapshot in data.json stands, because nothing else knows those
    dates yet. They are refreshed as the window slides over them.
  * `progress` is unscoped, so work reported done is applied across the whole term,
    not just the covered part.

Nothing is ever deleted. A snapshot item sitting inside the covered window that the
bridge did not report is flagged `gone` and rendered with a "?" rather than removed:
that is either a real cancellation or a title that stopped matching, and the two look
identical from here. Same reasoning as calendar_sync.py refusing to delete events.

Matching is exact on the normalised title, then a containment match *only when it is
unique within the course* - the confirmed/inferred/ambiguous rule the bridge itself
uses for completions. An ambiguous match adds a second chip instead of guessing.

  build.py                 refresh from the bridge, rewrite data.json, render
  build.py --offline       render from data.json alone; makes no network call
  build.py --dry-run       fetch and report what would change, write nothing
"""
import argparse, json, re, html, os, sys, urllib.request, urllib.error
import datetime as dt, pathlib
from zoneinfo import ZoneInfo

HERE = pathlib.Path(__file__).parent
ENV = HERE.parent / "bridge" / ".env"
STATE = HERE / ".board-state.json"
TZ = ZoneInfo("America/New_York")
TERM_START, TERM_END = dt.date(2026, 8, 17), dt.date(2026, 12, 13)

COURSES = [("BUSN5000", "BUSN 5000", "Data Science", "Cornwell"),
           ("MGMT4280", "MGMT 4280", "Supply Chain", "Beil"),
           ("MGMT5560", "MGMT 5560", "Intl Strategy", "Hill"),
           ("MGMT5850", "MGMT 5850", "Comp &amp; Perf.", "Guhde"),
           ("LAND2510", "LAND 2510E", "Landscape Hist.", "async"),
           ("UNIV",     "University", "Term dates", "&mdash;")]
MAJOR = re.compile(r'exam|final submission|podcast|project progress|project final|'
                   r'test one|test two|strategic plan|withdrawal|drop/add|pre-project', re.I)
BREAKS = ("Labor Day", "Fall Break", "Thanksgiving Break")
norm = lambda s: re.sub(r'[^a-z0-9]+', ' ', s.lower()).strip()
e = html.escape

CSS = open(HERE / "board.css").read()


# --- refresh from the bridge --------------------------------------------------

BUCKETS = ("overdue", "due_today", "due_this_week", "upcoming")


def load_env():
    cfg = {}
    for line in ENV.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            cfg[k.strip()] = v.strip().strip("\"'")
    return cfg


def fetch_status(timeout=25):
    cfg = load_env()
    url = cfg["WORKER_URL"].rstrip("/") + "/status"
    # Cloudflare answers urllib's default User-Agent with a 1010 block, and
    # /lastcall records the UA anyway, so identify the caller properly.
    req = urllib.request.Request(url, headers={
        "Authorization": "Bearer " + cfg["API_KEY"],
        "User-Agent": "semester-board/1.0 (+build.py)",
    })
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def local_date(iso):
    """The bridge speaks UTC instants; the board is a wall chart of local days."""
    return dt.datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(TZ).date()


def match(items, code, title):
    """(item, confidence) or (None, None). Never guesses between two candidates."""
    n = norm(title)
    pool = [i for i in items if i["course"] == code and not i["opt"]]
    for i in pool:
        if norm(i["t"]) == n:
            return i, "confirmed"
    near = [i for i in pool if norm(i["t"]) in n or n in norm(i["t"])]
    return (near[0], "inferred") if len(near) == 1 else (None, None)


def merge(items, status):
    """Fold the live payload into the snapshot. Returns a report, mutates items."""
    live = [x for b in BUCKETS for x in (status.get(b) or [])]
    if not live:
        return {"added": 0, "moved": [], "gone": [], "window": None, "live": 0}

    dates = [local_date(x["when_iso"]) for x in live]
    lo, hi = min(dates), max(dates)

    seen, added, moved = [], 0, []
    for x in live:
        code = x.get("course_code") or "UNIV"
        when = local_date(x["when_iso"]).isoformat()
        it, how = match(items, code, x["title"])
        if it is None:
            it = {"d": when, "t": x["title"], "course": code, "opt": False,
                  "src": "bridge", "desc": x.get("detail", "")}
            items.append(it)
            added += 1
        else:
            if it["d"] != when:
                moved.append((it["t"], it["d"], when))
                it["d"] = when
            if x.get("detail") and not it.get("desc"):
                it["desc"] = x["detail"]
            it["src"] = "bridge"
        it["done"] = bool(x.get("completed"))
        it.pop("gone", None)
        seen.append(id(it))

    # Work reported done anywhere in the term, not just the covered window.
    done_keys = {p.get("key") or norm(p["item"])
                 for p in (status.get("progress") or []) if p.get("status") == "done"}

    gone = []
    for it in items:
        if norm(it["t"]) in done_keys:
            it["done"] = True
        if it["opt"] or id(it) in seen:
            continue
        if lo <= dt.date.fromisoformat(it["d"]) <= hi:
            # Inside the window the bridge can see, and it did not report this.
            # Flag it; never delete it. See the module docstring.
            it["gone"] = True
            gone.append(it["t"])
        else:
            it.pop("gone", None)

    return {"added": added, "moved": moved, "gone": gone, "window": (lo, hi), "live": len(live)}


def write_state(overall, message):
    STATE.write_text(json.dumps(
        {"overall": overall, "message": message,
         "at": dt.datetime.now(TZ).isoformat(timespec="seconds")}, indent=2))


def build(items, today, stamp, live):
    weeks, d = [], TERM_START
    while d <= TERM_END:
        weeks.append(d); d += dt.timedelta(days=7)

    def wk(ds):
        dd = dt.date(*map(int, ds.split('-')))
        return 0 if dd < TERM_START else min((dd - TERM_START).days // 7, len(weeks) - 1)

    for it in items:
        dd = dt.date(*map(int, it['d'].split('-')))
        it.update(w=wk(it['d']), done=bool(it.get('done')),
                  dow=dd.strftime('%a'), day=dd.strftime('%-d'),
                  nice=dd.strftime('%a %-d %b'), major=bool(MAJOR.search(it['t'])))
        it['overdue'] = dd < today and not it['done'] and not it['opt'] and it['course'] != 'UNIV'

    cur = wk(today.isoformat())
    req = [i for i in items if not i['opt']]
    load = [sum(1 for i in req if i['w'] == w and i['course'] != 'UNIV') for w in range(len(weeks))]
    peak = max(load) or 1
    S = dict(total=len(req), done=sum(1 for i in req if i['done']),
             overdue=sum(1 for i in req if i['overdue']),
             left=sum(1 for i in req if not i['done']
                      and dt.date(*map(int, i['d'].split('-'))) >= today),
             opt=sum(1 for i in items if i['opt']), weeks=len(weeks) - cur - 1)

    rows = ['<div class="hd spine"><div class="code">Week</div></div>']
    for cid, full, sub, inst in COURSES:
        rows.append(f'<div class="hd" style="--sw:var(--c-{cid})"><div class="code">'
                    f'<span class="dot"></span>{full}</div>'
                    f'<div class="sub">{sub}<br>{inst}</div></div>')

    for w, d0 in enumerate(weeks):
        d1 = d0 + dt.timedelta(days=6)
        span = f"{d0.strftime('%b %-d')} &ndash; {d1.strftime('%b %-d')}"
        wi = [i for i in items if i['w'] == w]
        cls = "row" + (" now" if w == cur else "") + \
              (" brk" if any(b in i['t'] for i in wi for b in BREAKS) else "")
        rows.append(f'<div class="{cls}" style="display:contents">')
        rows.append(f'<div class="spinecell"><div class="wn mono">{w+1:02d}</div>'
                    f'<div class="wd mono">{span}</div><div class="meter">'
                    f'<span class="track"><span class="fill" style="width:{round(load[w]/peak*100)}%">'
                    f'</span></span><span class="n mono">{load[w] or ""}</span></div></div>')
        for cid, full, sub, inst in COURSES:
            cell = sorted((i for i in wi if i['course'] == cid),
                          key=lambda x: (x['d'], not x['major']))
            inner = []
            for i in cell:
                if i['overdue']:
                    k = "chip od" + (" done" if i['done'] else "")
                else:
                    k = "chip" + (" opt" if i['opt'] else (" major" if i['major'] else "")) \
                        + (" done" if i['done'] else "")
                k += " gone" if i.get('gone') else ""
                inner.append(
                    f'<span class="{k}" tabindex="0" data-t="{e(i["t"])}" data-d="{e(i["nice"])}" '
                    f'data-c="{e(full)}" data-desc="{e(i.get("desc",""))}" '
                    f'data-k="{"optional" if i["opt"] else "required"}" '
                    f'data-gone="{"1" if i.get("gone") else ""}">'
                    f'<span class="d mono">{i["dow"]} {i["day"]}</span>'
                    f'<span class="t">{e(i["t"])}</span></span>')
            rows.append(f'<div class="cell" style="--sw:var(--c-{cid})">{"".join(inner)}</div>')
        rows.append('</div>')

    hot = sorted(range(len(weeks)), key=lambda w: -load[w])[:2]
    hotxt = " and ".join(weeks[h].strftime('%b %-d') for h in hot)
    tiles = [("Overdue", S['overdue'], "needs attention now", "alarm" if S['overdue'] else ""),
             ("Required left", S['left'], f"of {S['total']} this term", ""),
             ("Done", S['done'], "reported to the bridge", ""),
             ("Optional tracked", S['opt'], "readings, practice, prep", ""),
             ("Weeks remaining", S['weeks'], "through Dec 13", "")]
    th = "".join(f'<div class="tile {c}"><div class="k">{k}</div><div class="v mono">{v}</div>'
                 f'<div class="s">{s}</div></div>' for k, v, s, c in tiles)
    kh = "".join(f'<i style="--sw:var(--c-{cid})">{full}</i>' for cid, full, _, _ in COURSES)

    # Provenance is load-bearing: a board that failed to refresh must not read as a
    # board that refreshed and found nothing.
    ngone = sum(1 for i in items if i.get('gone'))
    if live and live.get('window'):
        lo, hi = live['window']
        prov = (f"Refreshed <b>{stamp}</b> from the status bridge. Dates and completion between "
                f"<b>{lo.strftime('%b %-d')}</b> and <b>{hi.strftime('%b %-d')}</b> are live; "
                f"outside that range the bridge cannot see yet and the last snapshot stands. "
                f"Read-only &mdash; nothing here writes back.")
        if ngone:
            prov += (f" {ngone} item(s) inside the live range were not reported by the bridge "
                     f"and are marked with a <b>?</b> rather than removed.")
    else:
        prov = (f"<b>Could not reach the status bridge.</b> Showing the last snapshot, "
                f"rendered {stamp}. Dates may have moved since.")

    page = f"""<title>Fall 2026 Semester Board</title>
<style>{CSS}</style>
<div class="wrap">
  <header>
    <div class="lede"><h1>Fall&nbsp;2026 Semester Board</h1>
      <span class="term">Daksh Breja &middot; 5 courses &middot; Aug 17 &ndash; Dec 13</span></div>
    <p class="stamp">{prov}</p>
  </header>
  <div class="tiles">{th}</div>
  <div class="bar">
    <label class="tog"><input type="checkbox" id="optTog"> Show optional work ({S['opt']})</label>
    <div class="key">{kh}</div>
  </div>
  <div class="scroll"><div class="grid" id="grid">{"".join(rows)}</div></div>
  <p class="foot">
    Each row is one week; the bar in the left spine is that week&rsquo;s required workload, scaled
    against the busiest week of the term. Solid chips are graded milestones &mdash; exams,
    submissions, the podcast. Dashed chips are optional. Hatched chips marked overdue are past due.
    Struck-through chips are recorded done on the bridge. Course identity is carried by column
    position as well as colour, so the board stays readable without relying on hue.
    <br><br>
    Your two heaviest weeks are <b>{hotxt}</b>. Refresh with
    <code>python3 ~/Claude/school-system-suite/board/build.py</code>, which pulls
    <code>/status</code> and re-renders; it also runs on a schedule as the
    <code>board-refresh</code> routine. <code>--offline</code> re-renders the snapshot
    without a network call.
  </p>
</div>
<div id="tt" role="tooltip"></div>
<script>
(function(){{
  var g=document.getElementById('grid'),t=document.getElementById('tt'),o=document.getElementById('optTog');
  o.addEventListener('change',function(){{g.classList.toggle('showopt',o.checked);}});
  function show(el){{
    t.innerHTML='<div class="m">'+el.dataset.c+' &middot; '+el.dataset.d+' &middot; '+el.dataset.k+'</div>'
      +'<div class="h">'+el.dataset.t+'</div>'
      +(el.dataset.gone?'<div class="b"><b>Not reported by the bridge on the last refresh.</b> '
        +'It may have been cancelled, or its title may have changed. Kept from the snapshot.</div>':'')
      +(el.dataset.desc?'<div class="b">'+el.dataset.desc+'</div>':'');
    t.classList.add('on');
    var r=el.getBoundingClientRect(),tw=t.offsetWidth,th=t.offsetHeight;
    t.style.left=Math.min(Math.max(8,r.left),innerWidth-tw-8)+'px';
    var y=r.top-th-9; t.style.top=(y<8?r.bottom+9:y)+'px';
  }}
  function hide(){{t.classList.remove('on');}}
  g.addEventListener('mouseover',function(v){{var c=v.target.closest('.chip'); if(c) show(c);}});
  g.addEventListener('mouseout',function(v){{if(v.target.closest('.chip')) hide();}});
  g.addEventListener('focusin',function(v){{var c=v.target.closest('.chip'); if(c) show(c);}});
  g.addEventListener('focusout',hide);
  addEventListener('scroll',hide,true);
}})();
</script>"""
    # No <head> of our own means no <meta charset>; emit pure ASCII so the page
    # renders identically whatever encoding the host assumes.
    ascii_page = page.encode('ascii', 'xmlcharrefreplace').decode('ascii')
    (HERE / "semester.html").write_text(ascii_page, encoding='ascii')
    return S, [(weeks[h].strftime('%b %-d'), load[h]) for h in hot]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--offline", action="store_true", help="render from data.json; no network call")
    ap.add_argument("--dry-run", action="store_true", help="report what would change; write nothing")
    a = ap.parse_args()

    items = json.load(open(HERE / "data.json"))
    live, status = None, None

    if not a.offline:
        try:
            status = fetch_status()
        except Exception as ex:
            # A failed refresh is reported and the snapshot is still rendered - a
            # board that silently shows stale dates is worse than one that says so.
            msg = f"bridge unreachable ({type(ex).__name__}); rendered from snapshot"
            print(msg, file=sys.stderr)
            if not a.dry_run:
                write_state("problem", msg)

    if status:
        live = merge(items, status)
        today, stamp = local_date(status["generated_at"]), status["local_time"]
    else:
        today = dt.datetime.now(TZ).date()
        stamp = today.strftime("%a %-d %b %Y")

    if a.dry_run:
        print("dry run -", json.dumps(live, default=str) if live else "no live data")
        return 0

    if live:
        # Keep one generation back: the desc fields are hand-written and a bad merge
        # must not be the only copy.
        (HERE / "data.prev.json").write_text((HERE / "data.json").read_text())
        (HERE / "data.json").write_text(json.dumps(items, ensure_ascii=False, indent=1))

    s, hot = build(items, today, stamp, live)
    if live:
        detail = (f"{s['total']} required, {s['done']} done, {s['overdue']} overdue; "
                  f"{len(live['moved'])} moved, {live['added']} added, {len(live['gone'])} unreported")
        write_state("ok", detail)
        for name, was, now in live["moved"]:
            print(f"  moved: {name} {was} -> {now}")
    else:
        detail = f"{s['total']} required (snapshot only)"
    print("semester.html written -", s, "| heaviest:", hot)
    print(detail)
    return 0


if __name__ == "__main__":
    sys.exit(main())
