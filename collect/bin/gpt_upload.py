#!/usr/bin/env python3
"""Push extracted course text into a ChatGPT custom GPT's Knowledge, unattended.

Uses Neo's official local-file upload on the exact Knowledge input. Only that
input's presentation is exposed temporarily for a unique snapshot ref; original
presentation is restored in finally. No browser credentials or raw CDP are used.

Driving the page rather than the API is a deliberate choice. The direct route is
POST /backend-api/files/process_upload_stream followed by
POST /backend-api/gizmos?gizmo_id=..., but that second call takes the *whole*
gizmo object. Composing it here means owning a schema we do not control, and one
wrong field silently overwrites the GPT's instructions. (It also needs a bearer
token; cookies alone return 401.) Letting the page save itself keeps that
read-modify-write inside the code that owns the schema.

Safety rails, in order of how much they matter:
  * A backup of name/description/instructions is written to disk before anything
    is clicked, so a bad save is always recoverable.
  * Update is never clicked unless the Instructions box holds real content. An
    editor that half-loaded looks exactly like a GPT with empty instructions, and
    saving that would wipe it.
  * Exact full Knowledge inventory and editor configuration must survive reloads
    before and after Update. A count or confirmation dialog alone is not a receipt.
  * Owned tab identities and URL guards reject tab drift; unexpected concurrent
    edits fail closed. Callers still must serialize the entire publication window.
"""
import uuid
from collections import Counter
import json
import os
import re
from urllib.parse import urlsplit
import sys
import time
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import chrome_bridge as cb

ROOT = os.path.expanduser("~/Claude/school-system-suite/collect")
GPTS = os.path.join(ROOT, "gpts.json")
BACKUPS = os.path.join(ROOT, "gpt-backups")

EDITOR = "https://chatgpt.com/gpts/editor/%s"
KNOWLEDGE_CAP = 20          # ChatGPT's per-GPT Knowledge file limit
MIN_INSTRUCTIONS = 200      # below this, assume the editor did not really load


class UploadError(RuntimeError):
    pass


def load_gpt_map():
    with open(GPTS) as f:
        return json.load(f)


# ------------------------------------------------------------------ page probes
# One helper per question, each returning JSON, so a failure names the step it
# failed at instead of surfacing as an opaque None three calls later.

# Current editor exposes "Remove <name>"; older editors used "Remove file: <name>".
# Match the full accessible label, never substrings or grid positions.
REMOVE_NAME_JS = r"""
function knowledgeRemoveName(button) {
  var label = button.getAttribute('aria-label') || button.textContent.trim();
  var match = /^Remove (?:file: )?(.+)$/.exec(label);
  return match && match[1].trim() === match[1] ? match[1] : null;
}
"""

KNOWLEDGE_INPUT_JS = r"""
function knowledgeUploadInput() {
  var buttons = Array.from(document.querySelectorAll('button')).filter(function(b){
    return b.textContent.trim() === 'Upload files';
  });
  if (buttons.length !== 1) return null;
  var b = buttons[0];
  if (b.disabled || b.getAttribute('aria-disabled') === 'true') return null;
  /* Current input is a direct sibling, older input a descendant.
     Never search a larger ancestor that could contain a chat composer. */
  var candidates = Array.from(b.querySelectorAll('input[type=file]'));
  if (b.parentElement) {
    Array.from(b.parentElement.children).forEach(function(x){
      if (x.matches('input[type=file]')) candidates.push(x);
    });
  }
  candidates = Array.from(new Set(candidates));
  if (candidates.length !== 1) return null;
  var inp = candidates[0];
  if (inp.disabled || inp.getAttribute('aria-disabled') === 'true' ||
      /attach|composer|message/i.test([inp.getAttribute('aria-label'),
        inp.getAttribute('name'), inp.getAttribute('id')].join(' '))) return null;
  return {button:b, input:inp};
}
"""

PROBE = r"""
(function(){
__REMOVE_NAME__
__KNOWLEDGE_INPUT__
  var target = knowledgeUploadInput();
  if (!target) return JSON.stringify({ready:false});
  var b = target.button, inp = target.input;
  var removes = Array.from(document.querySelectorAll('button')).filter(function(x){return knowledgeRemoveName(x) !== null;});
  var names = removes.map(knowledgeRemoveName);
  var tas = Array.from(document.querySelectorAll('textarea'));
  var visible = function(x){return !!(x.getClientRects().length);};
  var credential = function(x){return (x.getAttribute('type')||'').toLowerCase()==='password' ||
    /password|api.?key|access.?token|secret|credential|authorization/i.test(
      [x.getAttribute('name'),x.getAttribute('aria-label'),x.getAttribute('placeholder')].join(' '));};
  var credentialDialog = Array.from(document.querySelectorAll('input,textarea')).some(function(x){return visible(x)&&credential(x);});
  var controls = Array.from(document.querySelectorAll('input,textarea,select,[role="switch"],[role="checkbox"],[role="combobox"]'))
    .filter(function(x){
      var t=(x.getAttribute('type')||'').toLowerCase();
      var hint=(x.getAttribute('placeholder')||'').toLowerCase();
      return visible(x) && !credential(x) && !['password','file','hidden','submit','button'].includes(t) &&
        !/ask anything|message gpt|message chatgpt/.test(hint) && !x.closest('[data-testid="conversation-turn"]');
    }).map(function(x){return {
      tag:x.tagName, type:x.getAttribute('type')||'', name:x.getAttribute('name')||'',
      label:x.getAttribute('aria-label')||'', placeholder:x.getAttribute('placeholder')||'',
      value:('value' in x)?x.value:x.textContent.trim(),
      checked:('checked' in x)?x.checked:x.getAttribute('aria-checked')
    };});
  var actions = Array.from(document.querySelectorAll('button')).filter(function(x){
    return visible(x) && /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/|$)/i.test(x.textContent.trim());
  }).map(function(x){return x.textContent.trim();}).sort();
  var uploadArea = b.parentElement && b.parentElement.parentElement;
  var busy = uploadArea && (uploadArea.querySelector('[aria-busy="true"],[role="progressbar"]') ||
    /\b(uploading|processing|saving)\b/i.test(uploadArea.innerText));
  var errors = uploadArea && /\b(upload failed|could not upload|error uploading)\b/i.test(uploadArea.innerText);
  var name = (document.querySelector('input[name="name"]') || {}).value || '';
  return JSON.stringify({
    ready: !!inp, url:location.href, names:names, chips:names, count:names.length,
    config:{controls:controls,actions:actions}, busy:!!busy, uploadError:!!errors, credentialDialog:credentialDialog,
    updateEnabled:Array.from(document.querySelectorAll('button')).some(function(x){
      return x.textContent.trim()==='Update' && !x.disabled;
    }),
    instructions:tas.length ? Math.max.apply(null,tas.map(function(t){return (t.value||'').length;})) : 0,
    pendingDraft: document.body.innerText.indexOf('Updates pending') !== -1,
    updated: document.body.innerText.indexOf('GPT Updated') !== -1,
    name:name
  });
})()
""".replace("__REMOVE_NAME__", REMOVE_NAME_JS).replace("__KNOWLEDGE_INPUT__", KNOWLEDGE_INPUT_JS)

DUMP = r"""
(function(){
  var tas = Array.from(document.querySelectorAll('textarea'));
  tas.sort(function(a,b){ return (b.value||'').length - (a.value||'').length; });
  var ins = tas.length ? tas[0].value : '';
  var inputs = Array.from(document.querySelectorAll('input[type=text], textarea'));
  var desc = '';
  inputs.forEach(function(i){
    var v = i.value || '';
    if (v.length > desc.length && v.length < 1000 && v !== ins) desc = v;
  });
  return JSON.stringify({instructions: ins, description: desc});
})()
"""


def publication_destination(url, gpt_id):
    """Allow only the same editor or the exact GPT's post-Update landing route."""
    parsed = urlsplit(url)
    if (parsed.scheme != "https" or parsed.netloc != "chatgpt.com"
            or parsed.query or parsed.fragment):
        raise UploadError("unexpected GPT publication destination")
    if parsed.path == "/gpts/editor/" + gpt_id:
        return "editor"
    if re.fullmatch(r"/g/" + re.escape(gpt_id) + r"(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?", parsed.path):
        return "published"
    raise UploadError("unexpected GPT publication destination")


class OwnedEditor:
    """Resolve the owned tab each operation and guard its exact editor URL in JS."""
    def __init__(self, gpt_id):
        self.gpt_id = gpt_id
        self.url = EDITOR % gpt_id
        self.identity = cb.open_owned_tab(self.url)

    def position(self):
        position = cb.find_tab_id(self.identity)
        if position is None:
            raise UploadError("owned GPT editor tab disappeared")
        return position

    def run(self, js, timeout=60, json_result=False):
        win, tab = self.position()
        guarded = "if(location.origin+location.pathname!==" + json.dumps(self.url) + ") throw new Error('wrong GPT editor');" + js
        call = cb.run_js_json if json_result else cb.run_js
        return call(win, tab, guarded, timeout=timeout)

    def reload(self):
        self.run("(function(){location.reload();return 'reloading';})()")
        time.sleep(1)
        cb.wait_loaded(*self.position(), timeout=45)

    def publication_destination(self):
        # Inspect only the owned tab URL after Update, before running editor probes.
        win, tab = self.position()
        observed = cb.run_js(win, tab, "location.href", timeout=15).strip()
        return publication_destination(observed, self.gpt_id)

    def reopen_published_editor(self):
        win, tab = self.position()
        observed = cb.run_js(win, tab, "location.href", timeout=15).strip()
        if publication_destination(observed, self.gpt_id) != "published":
            raise UploadError("published GPT route changed before editor readback")
        # A second in-page guard closes the observation/navigation race.
        script = ("if(location.href!==" + json.dumps(observed) +
                  ") throw new Error('published GPT route changed');" +
                  "location.href=" + json.dumps(self.url) + ";'reopening'")
        cb.run_js(win, tab, script, timeout=15)
        time.sleep(1)
        cb.wait_loaded(*self.position(), timeout=45)

    def close(self):
        position = cb.find_tab_id(self.identity)
        if position is not None:
            cb.close_tab(*position)


def _run_js(win, tab, js, timeout=60):
    if isinstance(win, OwnedEditor):
        return win.run(js, timeout=timeout)
    return cb.run_js(win, tab, js, timeout=timeout)


def _run_js_json(win, tab, js, timeout=60):
    if isinstance(win, OwnedEditor):
        return win.run(js, timeout=timeout, json_result=True)
    return cb.run_js_json(win, tab, js, timeout=timeout)


def inventory(state):
    names = state.get("names")
    if not isinstance(names, list) or any(not isinstance(n, str) or not n for n in names):
        raise UploadError("exact Knowledge filename inventory unavailable")
    if len(names) != len(set(names)):
        raise UploadError("duplicate Knowledge filenames require review")
    return Counter(names)


def configuration_ready(state):
    if state.get("credentialDialog"):
        raise UploadError("credential dialog visible; refusing publication")
    return state.get("instructions", 0) >= MIN_INSTRUCTIONS and bool(state.get("config", {}).get("controls"))


def configuration(state):
    if state.get("credentialDialog"):
        raise UploadError("credential dialog visible; refusing publication")
    if state.get("instructions", 0) < MIN_INSTRUCTIONS or not state.get("config", {}).get("controls"):
        raise UploadError("editor configuration incomplete; refusing publication")
    return state["config"]


def wait_inventory(win, tab, expected, baseline, *, timeout=180, require_update=False):
    """Require three stable exact observations, preserving all original files/settings."""
    deadline, stable = time.time() + timeout, 0
    while time.time() < deadline:
        state = probe(win, tab)
        if not configuration_ready(state) or not state.get("ready"):
            stable = 0
        else:
            if configuration(state) != baseline:
                raise UploadError("editor configuration changed during publication")
            current = inventory(state)
            if state.get("uploadError"):
                raise UploadError("Knowledge upload reported an error")
            good = current == expected and not state.get("busy")
            good = good and (not require_update or state.get("updateEnabled"))
            stable = stable + 1 if good else 0
            if stable >= 3:
                return state
        time.sleep(2)
    raise UploadError("exact Knowledge inventory did not stabilize; publication unconfirmed")


def reload_verified(editor, expected, baseline, *, require_update=False):
    editor.reload()
    wait_ready(editor, None)
    return wait_inventory(editor, None, expected, baseline, timeout=60,
                          require_update=require_update)


def probe(win, tab):
    out = _run_js_json(win, tab, PROBE.replace("\n", " "))
    if not isinstance(out, dict):
        raise UploadError(f"probe returned {out!r}")
    return out


def wait_ready(win, tab, timeout=60):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            last = probe(win, tab)
            if configuration_ready(last) and last.get("ready"):
                return last
        except cb.ChromeError as e:
            last = str(e)
        time.sleep(2)
    raise UploadError(f"GPT editor never became ready (last: {last!r})")


def backup(course, gpt_id, state, win, tab):
    """Write what we are about to risk, before we risk it."""
    os.makedirs(BACKUPS, exist_ok=True)
    values = [c.get("value", "") for c in configuration(state)["controls"]
              if isinstance(c, dict) and c.get("tag") in ("TEXTAREA", "INPUT")]
    values = [v for v in values if isinstance(v, str)]
    instructions = max(values, key=len, default="")
    description = max((v for v in values if len(v) < 1000 and v != instructions), key=len, default="")
    blob = {
        "course": course,
        "gpt_id": gpt_id,
        "captured_at": datetime.now().isoformat(timespec="seconds"),
        "name": state.get("name"),
        "knowledge": state.get("names"),
        "configuration": state.get("config"),
        "instructions": instructions,
        "description": description,
    }
    path = os.path.join(
        BACKUPS, f"{course}-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json")
    with open(path, "w") as f:
        json.dump(blob, f, indent=2)
    return path


# ------------------------------------------------------------------- the upload
EXPOSE_KNOWLEDGE_INPUT = r"""
__KNOWLEDGE_INPUT__
if (location.origin+location.pathname !== args.url) throw Error('wrong GPT editor');
var target=knowledgeUploadInput();
if (!target || window.__neoKnowledgeInput) throw Error('ambiguous Knowledge upload input');
var input=target.input;
var saved={input:input,label:args.label,aria:input.getAttribute('aria-label'),
  display:input.style.getPropertyValue('display'),priority:input.style.getPropertyPriority('display')};
window.__neoKnowledgeInput=saved;
input.setAttribute('aria-label',args.label);
input.style.setProperty('display','block','important');
return true;
""".replace("__KNOWLEDGE_INPUT__", KNOWLEDGE_INPUT_JS)

VERIFY_KNOWLEDGE_INPUT = r"""
__KNOWLEDGE_INPUT__
var saved=window.__neoKnowledgeInput, target=knowledgeUploadInput();
return location.origin+location.pathname === args.url && !!saved && !!target &&
 saved.input === target.input && saved.input.isConnected &&
 saved.label === args.label && saved.input.getAttribute('aria-label') === args.label;
""".replace("__KNOWLEDGE_INPUT__", KNOWLEDGE_INPUT_JS)

RESTORE_KNOWLEDGE_INPUT = r"""
var saved=window.__neoKnowledgeInput;
if (!saved) return true;
var input=saved.input, unchanged=true;
if (input.isConnected) {
  if (input.getAttribute('aria-label') === saved.label) {
    if (saved.aria === null) input.removeAttribute('aria-label');
    else input.setAttribute('aria-label',saved.aria);
  } else unchanged=false;
  if (input.style.getPropertyValue('display') === 'block' &&
      input.style.getPropertyPriority('display') === 'important') {
    if (saved.display) input.style.setProperty('display',saved.display,saved.priority);
    else input.style.removeProperty('display');
  } else unchanged=false;
}
delete window.__neoKnowledgeInput;
return unchanged;
"""


def upload_files_neo(editor, paths):
    """Official Neo local-file upload; inventory verification still owns success."""
    if not isinstance(editor, OwnedEditor):
        raise UploadError("Knowledge upload requires an owned editor")
    paths = [os.path.abspath(p) for p in paths]
    if not paths or any(not os.path.isfile(p) for p in paths):
        raise UploadError("Knowledge upload source missing")
    _, identity = editor.position()
    label = "Knowledge bundle input " + uuid.uuid4().hex
    args = {"url": editor.url, "label": label}
    code = ("const page=browser.page(" + json.dumps(identity) + ");" +
        "const args=" + json.dumps(args) + ";" +
        "let exposed=false; try {" +
        "const setup=await page.evaluate((args)=>{" + EXPOSE_KNOWLEDGE_INPUT + "},args);" +
        "if(setup.value!==true) throw Error('Knowledge input exposure unconfirmed');" +
        "exposed=true; const snap=await page.snapshot();" +
        "const refs=snap.refs.filter(x=>x.name===args.label && x.role==='button');" +
        "if(refs.length!==1) throw Error('Knowledge input ref ambiguous');" +
        "const verified=await page.evaluate((args)=>{" + VERIFY_KNOWLEDGE_INPUT + "},args);" +
        "if(verified.value!==true) throw Error('Knowledge input identity changed');" +
        "await page.upload(refs[0].ref," + json.dumps(paths) + ");" +
        "return {upload_invoked:true,count:" + str(len(paths)) + "};" +
        "} finally { const restored=await page.evaluate(()=>{" + RESTORE_KNOWLEDGE_INPUT + "});" +
        "if(restored.value!==true) throw Error('Knowledge input presentation restore unconfirmed'); }")
    result = cb._run(code, timeout=60, operation="knowledge_upload")
    if result != {"upload_invoked": True, "count": len(paths)}:
        raise UploadError("Neo Knowledge upload outcome uncertain")


CLICK_UPDATE = r"""
(function(){
  var b = Array.from(document.querySelectorAll('button'))
    .filter(function(x){ return x.textContent.trim() === 'Update' && !x.disabled; });
  if (!b.length) return 'no-update-button';
  b[b.length-1].click();
  return 'clicked';
})()
"""


# Each Knowledge chip carries its own remove control, labelled with the exact
# filename: aria-label="Remove file: <name>". Matching on that rather than on
# grid position means a re-render between read and click cannot make us delete
# the wrong chip — worth the care, as this is the only operation here that
# destroys data the user cannot trivially regenerate.
REMOVE = r"""
(function(){
__REMOVE_NAME__
  var want = %s;
  var matches = Array.from(document.querySelectorAll('button'))
    .filter(function(x){ return knowledgeRemoveName(x) === want; });
  if (matches.length !== 1) return JSON.stringify({ok:false, err:'remove control ambiguous or missing'});
  var b = matches[0];
  if (b.disabled) return JSON.stringify({ok:false, err:'remove control disabled'});
  b.click();
  return JSON.stringify({ok:true});
})()
""".replace("__REMOVE_NAME__", REMOVE_NAME_JS)


def _wants_replace(replace, name):
    """`replace` is True for everything, or a collection of filenames to replace.

    A set is the common case: a sweep rebuilds every bundle but usually only one
    has new content, and re-sending an unchanged bundle creates unnecessary upload work.
    """
    if replace is True:
        return True
    return bool(replace) and name in replace


def remove_files(win, tab, names, log=print):
    """Confirm each exact deletion while preserving every other filename."""
    gone = []
    for name in names:
        state = probe(win, tab)
        before, config = inventory(state), configuration(state)
        if before[name] != 1:
            raise UploadError(f"expected one exact Knowledge file for removal: {name}")
        expected = before.copy()
        del expected[name]
        res = _run_js_json(win, tab, (REMOVE % json.dumps(name)).replace("\n", " "))
        if not isinstance(res, dict) or not res.get("ok"):
            raise UploadError(f"could not remove {name}")
        wait_inventory(win, tab, expected, config, timeout=30)
        gone.append(name)
    return gone


def attach_verified(editor, paths, expected, config):
    """Repair one dropped attachment without touching any surviving file.

    The live editor can accept a batch but persist only some of its files. Only
    caller-supplied missing names may be retried, after a stable partial reload.
    Extra names, changed settings, credentials, busy/error states and loss of an
    unrelated original still fail closed. No publication occurs here.
    """
    available = {os.path.basename(path): path for path in paths}
    pending = list(paths)
    for attempt in range(2):
        upload_files_neo(editor, pending)
        try:
            return wait_inventory(editor, None, expected, config, require_update=True)
        except UploadError as exc:
            if attempt or str(exc) != "exact Knowledge inventory did not stabilize; publication unconfirmed":
                raise
            state = probe(editor, None)
            current = inventory(state)
            missing = expected - current
            if (configuration(state) != config or state.get("busy") or state.get("uploadError")
                    or current - expected or not missing or not set(missing).issubset(available)):
                raise
            reload_verified(editor, current, config)
            pending = [available[name] for name in sorted(missing)]


def upload(course, gpt_id, paths, log=print, dry_run=False, replace=False):
    """Attach `paths` to one GPT's Knowledge and publish. Returns a result dict.

    With `replace`, a path whose filename is already in Knowledge has the old chip
    deleted and the new bytes uploaded instead of being skipped as a duplicate.
    Bundles need this: they keep a stable filename and change content, so the
    skip-if-present rule would otherwise pin the GPT to the first version forever.
    """
    paths = list(paths)
    if not paths:
        return {"course": course, "ok": True, "uploaded": [], "note": "nothing to do"}
    if any(not os.path.isfile(p) for p in paths):
        raise UploadError("a required Knowledge source file is missing")
    required = [os.path.basename(p) for p in paths]
    if len(required) != len(set(required)):
        raise UploadError("duplicate local Knowledge filenames")

    editor = OwnedEditor(gpt_id)
    win, tab = editor, None
    try:
        cb.wait_loaded(*editor.position(), timeout=45)
        initial = wait_ready(win, tab)
        original, config = inventory(initial), configuration(initial)
        # Establish a fresh persisted baseline before any edits. This also catches
        # stale clients and tab/editor drift before destructive replacement.
        state = reload_verified(editor, original, config)
        fresh, stale, skip = [], [], []
        for path in paths:
            name = os.path.basename(path)
            if name not in original:
                fresh.append(path)
            elif _wants_replace(replace, name):
                stale.append(path)
            else:
                skip.append(path)
        expected = original.copy()
        for name in required:
            expected[name] = 1
        if sum(expected.values()) > KNOWLEDGE_CAP:
            raise UploadError("required full Knowledge inventory exceeds file cap")
        fresh += stale
        if not fresh:
            # Even no-op success requires all caller-supplied bundle filenames to
            # survive a fresh reload. A draft marker is not a publication receipt.
            if state.get("pendingDraft"):
                raise UploadError("unpublished draft present; no-op publication unconfirmed")
            return {"course": course, "ok": True, "uploaded": [],
                    "skipped": required, "verified_inventory": sorted(expected),
                    "note": "full Knowledge inventory verified after reload"}
        bpath = backup(course, gpt_id, state, win, tab)
        if dry_run:
            return {"course": course, "ok": True, "uploaded": [],
                    "note": f"dry run — would upload {len(fresh)} file(s)"}
        # Recheck immediately before changing anything; external edits do not hold
        # the collector's lock and must never be silently absorbed into this run.
        wait_inventory(win, tab, original, config, timeout=30)
        if stale:
            remove_files(win, tab, [os.path.basename(p) for p in stale], log=log)
        log(f"{course}: phase=attachment_start files={len(fresh)}")
        attach_verified(editor, fresh, expected, config)
        log(f"{course}: phase=attachment_inventory_verified")
        # Chip appearance can precede durable draft persistence. Reload before
        # Update, then verify the entire inventory again before publication.
        log(f"{course}: phase=draft_reload_start")
        reload_verified(editor, expected, config, require_update=True)
        log(f"{course}: phase=draft_reload_verified")
        published = False
        for attempt in range(3):
            wait_inventory(win, tab, expected, config, timeout=30, require_update=True)
            log(f"{course}: phase=update_invoking")
            result = _run_js(win, tab, CLICK_UPDATE.replace("\n", " "), timeout=45)
            if result.strip() != "clicked":
                raise UploadError("Update was not enabled")
            log(f"{course}: phase=update_clicked")
            end = time.time() + 45
            while time.time() < end:
                destination = editor.publication_destination()
                if destination == "published":
                    editor.reopen_published_editor()
                    # Navigation alone is never sufficient. The final reload below
                    # still requires the full inventory and unchanged configuration.
                    published = True
                    break
                current = probe(win, tab)
                if not configuration_ready(current) or not current.get("ready"):
                    time.sleep(2)
                    continue
                if configuration(current) != config or inventory(current) != expected:
                    raise UploadError("Knowledge or configuration changed during Update")
                if current.get("updated"):
                    published = True
                    break
                time.sleep(2)
            if published:
                break
        if not published:
            raise UploadError("no GPT Updated confirmation; publication unconfirmed")
        log(f"{course}: phase=post_publication_reload_start")
        reload_verified(editor, expected, config)
        log(f"{course}: phase=post_publication_reload_verified")
        log(f"{course}: published and reloaded full {sum(expected.values())}-file inventory")
        return {"course": course, "ok": True,
                "uploaded": [os.path.basename(p) for p in fresh],
                "skipped": [os.path.basename(p) for p in skip],
                "verified_inventory": sorted(expected), "verification": "post_publish_reload",
                "backup": bpath}
    finally:
        editor.close()


def upload_many(by_course, log=print, dry_run=False, replace=False):
    """by_course: {COURSE: [text paths]} -> list of result dicts."""
    gpt_map = load_gpt_map()
    results = []
    for course in sorted(by_course):
        gpt_id = gpt_map.get(course)
        if not gpt_id:
            results.append({"course": course, "ok": False,
                            "error": f"no GPT id for {course} in gpts.json"})
            continue
        try:
            results.append(upload(course, gpt_id, by_course[course],
                                  log=log, dry_run=dry_run, replace=replace))
        except (UploadError, cb.ChromeError) as e:
            results.append({"course": course, "ok": False, "error": str(e)})
            log(f"{course}: upload failed - {e}")
    return results


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    dry = "--dry-run" in sys.argv
    if len(args) < 2:
        print("usage: gpt_upload.py COURSE FILE [FILE ...] [--dry-run]",
              file=sys.stderr)
        sys.exit(2)
    out = upload_many({args[0]: args[1:]}, dry_run=dry)
    print(json.dumps(out, indent=2))
    sys.exit(0 if all(r.get("ok") for r in out) else 1)
