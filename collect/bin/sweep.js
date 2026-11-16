// Run inside a logged-in eLC tab. Returns a compact inventory of every course's
// content tree. Deliberately omits topic Urls: they carry session query strings,
// and returning them trips the browser tool's cookie filter.
(function () {
  window.__sweep = 'pending';
  var COURSES = {
    MGMT5850: 3948871, LAND2510: 3962245, MGMT5560: 3963225,
    MGMT4280: 4001788, BUSN5000: 4048786,
  };
  var out = {};
  Promise.all(Object.keys(COURSES).map(function (code) {
    return fetch('/d2l/api/le/1.67/' + COURSES[code] + '/content/toc', { credentials: 'include' })
      .then(function (r) { return r.ok ? r.json() : Promise.reject('HTTP ' + r.status); })
      .then(function (j) {
        var items = [];
        (function walk(mods, path) {
          (mods || []).forEach(function (m) {
            var p = path ? path + ' > ' + m.Title : m.Title;
            (m.Topics || []).forEach(function (tp) {
              var u = String(tp.Url || '').split('?')[0];
              var ext = (u.match(/\.([a-z0-9]{2,5})$/i) || [, ''])[1] || tp.TypeIdentifier;
              items.push({ id: tp.TopicId, title: String(tp.Title || '').slice(0, 90), ext: ext, unit: p.slice(0, 60) });
            });
            walk(m.Modules, p);
          });
        })(j.Modules, '');
        out[code] = items;
      })
      .catch(function (e) { out[code] = 'ERR ' + e; });
  })).then(function () { window.__sweep = out; });
  return 'sweeping';
})()
