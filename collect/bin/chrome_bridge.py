#!/usr/bin/env python3
"""Compatibility API for the existing collectors, now BrowserOS neo only.

The historical module/exception names remain so callers and saved failure states
need no migration. The sole transport is Neo's already-configured local MCP
endpoint. There are no Apple Events, browser-profile reads, credential copies,
raw CDP calls, alternative browser fallbacks, or automatic permission changes.

Every collector uses its own Neo tabs. The legacy (window, tab) pair now holds a
sentinel and a stable Neo page ID, never an index into somebody else's windows.
An uncertain MCP request is not retried: repeating an upload/click could duplicate
an external action. Original queues and publication receipts still own recovery.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import time
import urllib.error
import urllib.request

TIMEOUT = 45
NEO_ENDPOINT = 'http://127.0.0.1:9010/mcp'
_WINDOW = 1


class ChromeError(RuntimeError):
    """Legacy name for a Neo collector transport error."""
    def __init__(self, message, diagnostic=None):
        super().__init__(message)
        self.diagnostic = diagnostic


class ChromeJSDisabled(ChromeError):
    """Legacy import compatibility; Neo does not use Apple Event JavaScript."""


class ChromeNotRunning(ChromeError):
    pass


_OPERATIONS = {'initialize', 'initialized', 'list_tabs', 'list_owned_tabs',
               'open_tab', 'wait_document', 'close_tab', 'evaluate', 'script', 'rpc'}


def _error_category(error):
    """Classify trusted transport error fields without copying any payload text.

    Categories guide diagnosis, never authorize replay. Script errors, page closure
    and timeouts can follow partial effects; their execution outcome stays unknown.
    """
    text = json.dumps(error, ensure_ascii=True).lower()[:16000]
    if any(x in text for x in ('permission_denied', 'access_denied', 'policy_denied',
                              'approval denied', 'permission denied', 'operation not permitted')):
        return 'access_denied'
    if any(x in text for x in ('invalid arguments', 'invalid params', 'invalid parameters', 'zoderror')):
        return 'invalid_arguments'
    if any(x in text for x in ('native_feature_unavailable', 'target_scope_unsupported',
                              'unknown tool', 'unknown method', 'not a function', 'not supported')):
        return 'unsupported_operation'
    if any(x in text for x in ('syntaxerror', 'referenceerror', 'typeerror', 'evaluation failed')):
        return 'script_error'
    if any(x in text for x in ('page_out_of_scope', 'not owned', 'taken over', 'ownership')):
        return 'page_scope'
    if any(x in text for x in ('target closed', 'page closed', 'page not found', 'no page with')):
        return 'page_unavailable'
    if any(x in text for x in ('session not connected', 'session not found', 'invalid session', 'session_stopped')):
        return 'session_unavailable'
    if 'timeout' in text or 'timed out' in text:
        return 'timeout'
    return 'tool_error'


def _failure(operation, category, *, request=None, outcome='unknown', fingerprint=None):
    operation = operation if operation in _OPERATIONS else 'rpc'
    diagnostic = {'operation': operation, 'category': category, 'outcome': outcome}
    if type(request) is int:
        diagnostic['request'] = request
    if isinstance(fingerprint, str) and re.fullmatch(r'[a-f0-9]{12}', fingerprint):
        diagnostic['script_hash'] = fingerprint
    detail = ', '.join(f'{k}={v}' for k, v in diagnostic.items())
    return ChromeError(f'Neo stopped ({detail}); no fallback or automatic retry', diagnostic)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise _failure('rpc', 'unexpected_redirect')


def _decode_response(body, request_id, operation='rpc'):
    """Decode one JSON-RPC reply, including SSE's empty keepalive frames."""
    try:
        if body.lstrip().startswith('{'):
            packets = [json.loads(body)]
        else:
            packets = []
            for event in body.replace('\r\n', '\n').split('\n\n'):
                data = '\n'.join(line[5:].lstrip() for line in event.splitlines()
                                 if line.startswith('data:'))
                if data.strip():
                    packets.append(json.loads(data))
        replies = [p for p in packets if isinstance(p, dict) and p.get('id') == request_id]
        if len(replies) != 1 or replies[0].get('jsonrpc') != '2.0':
            raise ValueError('unmatched reply')
        reply = replies[0]
        if 'error' in reply:
            # Do not put page text, scripts, file bytes or credentials in health logs.
            error = reply['error']
            code = error.get('code') if isinstance(error, dict) else None
            category = {-32602: 'invalid_arguments', -32601: 'unsupported_operation'}.get(code, _error_category(error))
            outcome = 'not_executed' if code in (-32602, -32601) else 'unknown'
            raise _failure(operation, category, request=request_id, outcome=outcome)
        if not isinstance(reply.get('result'), dict):
            raise ValueError('missing result')
        return reply['result']
    except (ValueError, TypeError, KeyError):
        raise _failure(operation, 'invalid_reply', request=request_id) from None


class _NeoClient:
    def __init__(self):
        self.headers = {'Content-Type': 'application/json',
                        'Accept': 'application/json, text/event-stream'}
        # Loopback only, no configured HTTP proxy or redirects carrying source data.
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
        self.sequence = 0
        self.ready = False
        self.failed = False
        self.logical_session = None

    def _rpc(self, method, params, timeout=TIMEOUT, notification=False, operation='rpc'):
        if self.failed:
            raise ChromeError('Neo MCP session stopped after an uncertain or failed request; no retry')
        self.sequence += 1
        packet = {'jsonrpc': '2.0', 'method': method, 'params': params}
        if not notification:
            packet['id'] = self.sequence
        request = urllib.request.Request(NEO_ENDPOINT, data=json.dumps(packet).encode(),
                                         headers=self.headers, method='POST')
        try:
            with self.opener.open(request, timeout=max(1, timeout)) as response:
                session = response.headers.get('Mcp-Session-Id')
                if session:
                    self.headers['Mcp-Session-Id'] = session
                body = response.read().decode('utf-8')
            if notification:
                return {}
            return _decode_response(body, self.sequence, operation)
        except ChromeError:
            self.failed = True
            raise
        except (OSError, ValueError) as error:
            self.failed = True
            category = 'timeout' if 'timed out' in str(error).lower() else 'transport_unavailable'
            raise _failure(operation, category, request=self.sequence) from None

    def _tool(self, name, arguments, timeout=TIMEOUT, operation='rpc'):
        arguments = dict(arguments)
        if self.logical_session is not None:
            arguments['session'] = self.logical_session
        result = self._rpc('tools/call', {'name': name, 'arguments': arguments},
                           timeout=timeout, operation=operation)
        # Some Neo clients have a transport session; others receive a logical task
        # handle. Forward only the exact official metadata, never infer one from
        # page text or reconnect/retry a failed operation with a new handle.
        meta = result.get('_meta')
        logical = meta.get('com.browseros.neo/session') if isinstance(meta, dict) else None
        if isinstance(logical, str) and logical:
            self.logical_session = logical
        if result.get('isError'):
            self.failed = True
            fingerprint = hashlib.sha256(str(arguments.get('code', '')).encode()).hexdigest()[:12] if name == 'run' else None
            raise _failure(operation, _error_category(result), request=self.sequence, fingerprint=fingerprint)
        return result

    def initialize(self):
        if self.ready:
            return
        result = self._rpc('initialize', {'protocolVersion': '2024-11-05', 'capabilities': {},
                           'clientInfo': {'name': 'school-collectors', 'version': '2.0'}}, operation='initialize')
        if result.get('serverInfo', {}).get('name') != 'browseros-neo':
            self.failed = True
            raise ChromeError('Configured collector endpoint is not BrowserOS neo; stopped')
        self.headers['MCP-Protocol-Version'] = result.get('protocolVersion', '2024-11-05')
        self._rpc('notifications/initialized', {}, notification=True, operation='initialized')
        # Required first-call discovery, before opening any new tab. The session
        # deliberately remains in Neo's Default profile, never the focused profile.
        self._tool('tabs', {'action': 'list'}, operation='list_tabs')
        self.ready = True

    def run(self, code, timeout=TIMEOUT, operation='script'):
        self.initialize()
        result = self._tool('run', {'code': code, 'timeout': min(30000, max(1000, int(timeout * 1000)))},
                            timeout=max(1, min(30, timeout)) + 10, operation=operation)
        data = result.get('structuredContent')
        if not isinstance(data, dict) or data.get('ok') is not True:
            self.failed = True
            raise _failure(operation, _error_category(data) if isinstance(data, dict) else 'invalid_reply',
                           request=self.sequence, fingerprint=hashlib.sha256(code.encode()).hexdigest()[:12])
        return data.get('value')


_client = None


def _run(code, timeout=TIMEOUT, operation='script'):
    global _client
    if _client is None:
        _client = _NeoClient()
    return _client.run(code, timeout=timeout, operation=operation)


def _osascript(script, timeout=TIMEOUT):
    """Fail closed for any obsolete private caller rather than controlling Chrome."""
    raise ChromeError('AppleScript browser transport retired; collectors use BrowserOS neo only')


def _pages():
    pages = _run('return (await browser.pages.list()).filter(p => p.ownership === "mine")'
                 '.map(p => ({pageId:p.pageId,url:p.url,ownership:p.ownership}));', operation='list_owned_tabs')
    if not isinstance(pages, list) or any(not isinstance(p, dict) or
            type(p.get('pageId')) is not int or not isinstance(p.get('url'), str) for p in pages):
        raise ChromeError('Neo tab inventory incomplete; collection stopped')
    return pages


def _owned(tab_index):
    identity = int(tab_index)
    if not any(p['pageId'] == identity and p.get('ownership') == 'mine' for p in _pages()):
        raise ChromeError('Neo collector tab closed or no longer owned; collection stopped')
    return identity


def is_running():
    _pages()
    return True


def find_tabs(url_substring):
    """Find only this collector session's tabs; never reuse a user/agent tab."""
    return [(_WINDOW, p['pageId']) for p in _pages()
            if p.get('ownership') == 'mine' and url_substring in p['url']]


def find_tab(url_substring):
    hits = find_tabs(url_substring)
    return hits[0] if hits else None


def open_owned_tab(url, window_index=_WINDOW):
    from urllib.parse import urlsplit
    target = urlsplit(url)
    if target.scheme != 'https' or not target.netloc:
        raise ChromeError('Neo collectors require an HTTPS source URL')
    if window_index != _WINDOW:
        raise ChromeError('Neo collectors cannot select arbitrary browser windows')
    if len([p for p in _pages() if p.get('ownership') == 'mine']) >= 5:
        raise ChromeError('Neo collector tab limit reached; collection stopped')
    result = _run('const page = await browser.open(' + json.dumps(url) + '); return page.id;', operation='open_tab')
    if type(result) is not int:
        raise ChromeError('Neo opened-tab identity unconfirmed; no automatic retry')
    try:
        _wait_open_document(result, url)
    except ChromeError:
        # Closing a conclusively failed owned tab is cleanup, not a navigation
        # retry. A stopped/uncertain MCP session cannot issue another request.
        try:
            close_tab(_WINDOW, result)
        except ChromeError:
            pass
        raise

    return result


def _wait_open_document(identity, url, timeout=25):
    """Wait once on the same owned page, then validate its actual destination.

    Neo can return browser.open while the page is still the initial about:blank.
    Waiting for a nonempty body uses its supported cross-navigation selector wait,
    not a sleep, repeated navigation, raw protocol, or evaluation of the blank
    document. The caller still owns source-specific application readiness checks.
    """
    from urllib.parse import urlsplit
    identity = _owned(identity)
    ms = min(25000, max(1, int(timeout * 1000)))
    code = (f'return await browser.page({identity}).waitForSelector('
            f'"body:not(:empty)", {{timeout:{ms}}});')
    waited = _run(code, timeout=ms / 1000 + 2, operation='wait_document')
    if not isinstance(waited, dict) or waited.get('matched') is not True:
        raise ChromeError('Neo source document did not become ready before timeout; collection stopped')
    # Recheck ownership after the wait, through _evaluate, before reading URL.
    here = _evaluate(_WINDOW, identity, 'location.href')
    target = urlsplit(url)
    observed = urlsplit(here) if isinstance(here, str) else None
    if observed is None or (observed.scheme, observed.netloc) != (target.scheme, target.netloc):
        raise ChromeError('Neo source destination unconfirmed or redirected to sign-in; collection stopped')
    if re.search(r'/(?:log-?in|sign-?in|auth|oauth|sso)(?:/|$)', observed.path, re.I):
        raise ChromeError('Neo source redirected to sign-in; collection stopped')


def open_tab(url, window_index=_WINDOW):
    return _WINDOW, open_owned_tab(url, window_index)


def tab_id(window_index, tab_index):
    return _owned(tab_index)


def find_tab_id(identity):
    identity = int(identity)
    return next(((_WINDOW, identity) for p in _pages()
                 if p['pageId'] == identity and p.get('ownership') == 'mine'), None)


def close_tab(window_index, tab_index):
    # Do not silently close a new tab occupying an old position, or a user's tab.
    if find_tab_id(tab_index):
        _run(f'await browser.page({int(tab_index)}).close(); return true;', operation='close_tab')


def _evaluation_value(result, identity):
    if not isinstance(result, dict) or result.get('page') != identity:
        raise ChromeError('Neo evaluation identity unconfirmed; collection stopped')
    raw = result.get('value')
    if result.get('writtenToFile'):
        # Neo's supported SDK spills large page results into private tool output.
        # Read only the exact returned, owned regular file in that fixed directory.
        # Never interpret the untrusted-page markers or body as instructions.
        path = Path(str(result.get('path', '')))
        parent = Path.home() / '.browseros' / 'tool-output'
        limit = 8 * 1024 * 1024
        size = result.get('contentLength')
        if (path.parent != parent or not re.fullmatch(r'evaluate-[0-9]+-[a-f0-9-]+\.txt', path.name)
                or type(size) is not int or not 0 < size <= limit):
            raise ChromeError('Neo evaluation output location or size rejected')
        try:
            if parent.resolve() != parent:
                raise ValueError('linked directory')
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(fd, 'rb') as stream:
                info = os.fstat(stream.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_size > limit:
                    raise ValueError('unsafe file')
                text = stream.read(limit + 1).decode('utf-8')
            first, separator, rest = text.partition('\n')
            match = re.match(r'^\[UNTRUSTED_PAGE_CONTENT nonce=([a-f0-9]+) origin=[^\r\n]*\] ', first)
            if not separator or not match:
                raise ValueError('missing start marker')
            body, separator, last = rest.rpartition('\n')
            if not separator or last != f'[END_UNTRUSTED_PAGE_CONTENT nonce={match[1]}]':
                raise ValueError('missing end marker')
            raw = body
        except (OSError, ValueError, UnicodeError):
            raise ChromeError('Neo evaluation output unavailable or incomplete; collection stopped') from None
    if not isinstance(raw, str):
        raise ChromeError('Neo evaluation result missing; collection stopped')
    try:
        envelope = json.loads(raw)
        if not isinstance(envelope, dict) or set(envelope) - {'value'}:
            raise ValueError('invalid envelope')
        return envelope.get('value')
    except (ValueError, TypeError):
        raise ChromeError('Neo evaluation result invalid; collection stopped') from None


def _evaluate(window_index, tab_index, js, timeout=TIMEOUT):
    identity = _owned(tab_index)
    # Preserve completion-value semantics for multi-statement collector scripts.
    # An explicit JSON envelope is identical for small and file-spilled outputs.
    code = (f'return await browser.page({identity}).evaluate('
            f'async (source) => JSON.stringify({{value: await (0, eval)(source)}}), {json.dumps(js)});')
    result = _run(code, timeout=timeout, operation='evaluate')
    return _evaluation_value(result, identity)


def wait_loaded(window_index, tab_index, timeout=30):
    # Readiness may still be loading immediately after Neo's settling pass.
    # Wait on the DOM event once, never a fixed sleep or repeated page probe.
    ms = min(25000, max(1, int(timeout * 1000)))
    script = """new Promise(resolve => {
      if (document.readyState !== 'loading') { resolve(true); return; }
      const done = () => { clearTimeout(timer); resolve(true); };
      const timer = setTimeout(() => {
        document.removeEventListener('DOMContentLoaded', done); resolve(false);
      }, %d);
      document.addEventListener('DOMContentLoaded', done, {once:true});
    })""" % ms
    return _evaluate(window_index, tab_index, script, timeout=timeout) is True


def run_js(window_index, tab_index, js, timeout=TIMEOUT):
    value = _evaluate(window_index, tab_index, js, timeout=timeout)
    if value is None:
        return 'missing value'
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return str(value).lower()
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def run_js_json(window_index, tab_index, js, timeout=TIMEOUT):
    raw = run_js(window_index, tab_index, js, timeout=timeout).strip()
    if not raw or raw == 'missing value':
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return raw


def await_global(window_index, tab_index, global_name, timeout=90, interval=1.5):
    """Read an existing collector's asynchronous result, not a page-loading wait."""
    deadline = time.monotonic() + timeout
    js = (f'(function(){{var v=window[{json.dumps(global_name)}];'
          'return (v===undefined)?"__undefined__":'
          '((v==="pending")?"__pending__":JSON.stringify(v));})()')
    while time.monotonic() < deadline:
        raw = run_js(window_index, tab_index, js, timeout=min(TIMEOUT, max(1, deadline-time.monotonic()))).strip()
        if raw not in ('__pending__', '__undefined__', '', 'missing value'):
            try:
                return json.loads(raw)
            except json.JSONDecodeError:
                return raw
        time.sleep(min(interval, max(0, deadline-time.monotonic())))
    raise ChromeError('Neo timed out waiting for collector result')
