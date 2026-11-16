// OAuth configuration needs real, publicly readable information about the app.
// These pages are deliberately static: public requests never read credentials,
// calendar feeds, academic records or the private document library.

const PAGES = Object.freeze({
  '/about': {
    title: 'About Sidekick',
    body: `<p>Sidekick is a private workspace for one owner to organize school schedules, coursework progress and selected learning materials.</p>
<p>The private dashboard brings together the owner's existing Google Calendar, school calendar feeds, reported progress and course library. It presents a calendar and daily briefing, and supplies selected context to the owner's existing assistant integrations.</p>
<p>Original course systems and instructor communications remain authoritative for requirements, exam dates, submissions and grades. A progress report is distinct from independently verified submission evidence.</p>
<p>Workspace access requires the owner's authorized credentials. Public enrollment and payments are unavailable.</p>
<p>Read the <a href="/privacy">privacy information</a> and <a href="/terms">personal-use terms</a> for details.</p>`,
  },
  '/privacy': {
    title: 'Privacy information',
    body: `<p>This page describes the current one-owner Sidekick and its existing integrations.</p>
<h2>Google Calendar and Drive</h2>
<p>The Bridge reads the owner's configured Google Calendar feed and school calendar feeds to show schedules and deadlines. A separate local calendar writer uses the Google Calendar events permission to read, create and update its guarded GLO-BUS deadline events. That writer never deletes events.</p>
<p>Course-library retrieval reads the configured Google Drive library through a read-only service account, with a read-only OAuth integration available as a fallback. Existing local collection jobs also file selected course materials into the owner's Drive library.</p>
<h2>Records and assistant integrations</h2>
<p>Schedule metadata, reported coursework progress, notes and selected course materials are processed by the private workspace. Cloudflare hosts the Bridge and stores its progress records, selected notes or material extracts, and operational metadata. The local collection tools also keep working files on the owner's computer and in the configured Drive library.</p>
<p>Selected status, questions, notes and course materials may be sent to Anthropic or OpenAI through the owner's existing dashboard and assistant integrations to provide school assistance. Their handling of those requests is subject to the relevant provider's terms and settings.</p>
<p>Raw grade scores are prohibited from the Bridge's shared status records. Calendar feeds, credentials, private records and course-library contents are not included in these public informational pages. Credentials are kept in the existing private credential stores.</p>
<h2>Retention and control</h2>
<p>Stored records and selected materials may remain until the owner removes them. Some operational histories and snapshots have bounded retention; there is no single fixed retention period for every workspace record.</p>
<p>The owner can stop the integrations, remove stored records or materials through the existing workspace tools, and revoke Google OAuth access in the Google Account's connected-app settings. Revoking access does not itself remove copies already stored in the workspace. Calendar feed access can be disabled or reset in the source calendar settings.</p>
<p>Google authorization can expire or be revoked, including through account or administrator changes. The workspace cannot guarantee that consent will never be needed again.</p>`,
  },
  '/terms': {
    title: 'Personal-use terms',
    body: `<p>Sidekick is the owner's private school workspace. Access is limited to the owner and integrations the owner authorizes. This informational website does not offer public enrollment or paid services.</p>
<p>Use of Google and assistant integrations depends on the owner's authorization and the applicable providers' terms. The owner controls which sources are connected and may stop using the workspace or revoke access.</p>
<p>Calendar entries and assistant explanations can be incomplete or outdated. Original course systems, instructor communications and actual submission receipts remain authoritative. Reported progress does not by itself confirm a submission or grade.</p>
<p>Keep credentials and raw grade scores out of shared Bridge records. Review the <a href="/privacy">privacy information</a> for the current handling of workspace data.</p>`,
  },
});

function pageHtml(page) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${page.title} · Sidekick</title>
<style>
:root{color-scheme:light dark;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.65}
body{margin:0;background:#f6f7fa;color:#202737}
main{max-width:48rem;margin:3rem auto;padding:2rem;background:#fff;border:1px solid #dfe4ed;border-radius:1rem}
nav{display:flex;flex-wrap:wrap;gap:1.25rem;border-bottom:1px solid #dfe4ed;padding-bottom:1rem;margin-bottom:2rem}
a{color:#235cc5;text-underline-offset:.18em}a:focus-visible{outline:3px solid #4876d7;outline-offset:4px;border-radius:2px}
h1{font-size:clamp(1.8rem,5vw,2.5rem);line-height:1.2;margin:0 0 1.5rem}h2{font-size:1.2rem;line-height:1.4;margin-top:2rem}
p{margin:0 0 1.1rem}.label{font-size:.85rem;color:#606b7e;margin-bottom:.6rem}footer{border-top:1px solid #dfe4ed;padding-top:1rem;margin-top:2rem;font-size:.9rem;color:#606b7e}
@media(max-width:52rem){main{margin:1rem;padding:1.4rem}}
@media(prefers-color-scheme:dark){body{background:#111722;color:#e5e9f0}main{background:#192232;border-color:#344055}nav,footer{border-color:#344055}a{color:#9cbcff}.label,footer{color:#b3bdcd}}
</style>
</head>
<body><main>
<nav aria-label="Information"><a href="/about">About</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/app">Private workspace</a></nav>
<p class="label">Sidekick</p>
<h1>${page.title}</h1>
${page.body}
<footer>One-owner personal workspace · Information updated October 10, 2026</footer>
</main></body>
</html>`;
}

export function publicInfoResponse(request, path) {
  if (!['GET', 'HEAD'].includes(request.method) || !Object.hasOwn(PAGES, path)) return null;
  return new Response(request.method === 'HEAD' ? null : pageHtml(PAGES[path]), {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    },
  });
}
