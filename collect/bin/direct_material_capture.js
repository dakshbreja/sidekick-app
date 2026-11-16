// Runs in the existing signed-in eLC tab. No cookies or native downloads leave it.
(function (request) {
  'use strict';
  const state = {result: 'pending', bytes: null, controller: new AbortController()};
  window[request.key] = state;
  // A killed caller cannot leave a fetch or private document in this page forever.
  const expiry = setTimeout(() => {
    state.controller.abort(); state.bytes = null; delete window[request.key];
  }, 150000);
  state.dispose = () => {
    clearTimeout(expiry); state.controller.abort(); state.bytes = null;
    delete window[request.key];
  };
  (async () => {
    if (location.origin !== 'https://uga.view.usg.edu' ||
        !location.pathname.startsWith('/d2l/') || document.querySelector('input[type="password"]'))
      throw new Error('session_required');
    const safePath = value => {
      if (typeof value !== 'string' || /[%](?:2f|5c|2e|00|25)/i.test(value) || value.includes('\\'))
        throw new Error('unsafe_source_path');
      const u = new URL(value, location.origin);
      if (u.origin !== location.origin || u.username || u.password || u.search || u.hash ||
          !new RegExp('^/content/enforced[0-9]*/' + request.org + '(?:-[^/]+)?/').test(u.pathname))
        throw new Error('unsafe_source_path');
      return u.pathname;
    };
    const timeout = setTimeout(() => state.controller.abort(), request.timeoutMs);
    try {
      const get = async path => {
        const r = await fetch(path, {credentials: 'same-origin', redirect: 'error',
          cache: 'no-store', signal: state.controller.signal});
        if (!r.ok) throw new Error('http_' + r.status);
        if (r.redirected || new URL(r.url).origin !== location.origin)
          throw new Error('source_unavailable');
        return r;
      };
      // Re-read the topic identity before fetching, rather than trusting a stale filename.
      const toc = await (await get('/d2l/api/le/1.67/' + request.org + '/content/toc')).json();
      const matches = [];
      let count = 0;
      const walk = (modules, hidden = false, depth = 0) => {
        if (depth > 30) throw new Error('inventory_limit');
        for (const m of modules || []) {
          if (++count > 2000) throw new Error('inventory_limit');
          const unavailable = hidden || m.IsHidden === true || m.IsLocked === true;
          for (const t of m.Topics || []) {
            if (++count > 2000) throw new Error('inventory_limit');
            if (String(t.TopicId) === request.topic) {
              if (unavailable || t.IsHidden === true || t.IsLocked === true || t.IsBroken === true ||
                  t.TypeIdentifier !== 'File') throw new Error('topic_unavailable');
              matches.push(t);
            }
          }
          walk(m.Modules, unavailable, depth + 1);
        }
      };
      walk(toc.Modules);
      if (matches.length !== 1 || safePath(matches[0].Url) !== safePath(request.path))
        throw new Error('source_identity_changed');
      const response = await get(request.path);
      if (Number(response.headers.get('content-length')) > request.maxBytes)
        throw new Error('source_too_large');
      const reader = response.body.getReader(), chunks = [];
      let length = 0;
      try {
        for (;;) {
          const {done, value} = await reader.read();
          if (done) break;
          length += value.length;
          if (length > request.maxBytes) throw new Error('source_too_large');
          chunks.push(value);
        }
      } finally { await reader.cancel(); }
      if (!length) throw new Error('empty_source');
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
        .map(x => x.toString(16).padStart(2, '0')).join('');
      state.bytes = bytes;
      state.result = {ok: true, topic: request.topic, org: request.org,
        path: request.path, size: length, sha256: hash};
    } finally { clearTimeout(timeout); }
  })().catch(error => {
    state.bytes = null;
    const allowed = /^(?:session_required|unsafe_source_path|source_unavailable|source_identity_changed|topic_unavailable|inventory_limit|source_too_large|empty_source|http_[45][0-9]{2})$/;
    state.result = {ok: false, reason: allowed.test(error?.message) ? error.message : 'direct_source_unconfirmed'};
  });
  return 'started';
})(__REQUEST__)
