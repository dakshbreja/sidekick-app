/**
 * ask.js — the dashboard's embedded assistant.
 *
 * One call to the Messages API, grounded in the live /status payload so answers
 * come from the current feeds rather than a stale idea of the semester. The
 * Worker has no npm dependencies by design (see wrangler.toml), so this uses
 * fetch rather than @anthropic-ai/sdk.
 */

const API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-opus-5';

// Opus 5 defaults to long, well-structured prose and expands scope unless told
// not to. Both are wrong for a chat bubble, so both are addressed here.
export const SYSTEM = `You are the assistant embedded in Daksh's coursework dashboard.

Answer only from the JSON status payload in the user message. It is the live
state of his Fall 2026 semester, pulled from eLC (D2L) and Google Calendar at
the moment he asked. If the payload does not contain the answer, say so — never
fill the gap from memory or guesswork, and never invent a deadline.

Keep responses focused, brief, and concise. Two or three sentences is usually
right; a short list when he asks what to do next. No preamble, no headers, no
restating the question. Lead with the answer.

Read "actionable" first. It is the one view the dashboard, the briefing and the
class GPTs all count from, so answering from it is what keeps them agreeing.
"actionable.outstanding" is what is genuinely left, each row tagged with its
bucket; "actionable.counts" are the numbers to quote. Do not re-derive either
from the raw lists.

The raw "overdue", "due_today", "due_this_week" and "upcoming" lists are the
historical record and still contain work he has reported done, flagged
"completed: true". Never chase him about those, and never count them.

Finishing something and the system having seen it arrive are different claims.
"submission_verification" is "verified" only when an original submitted/completed receipt was
actually observed; "reported" means he said so and nothing was checked; and
"not_required" is work with nothing to submit. Say "you reported it done", never
"it is confirmed submitted", for anything in
"actionable.awaiting_verification". "match_method" says which deadline a report
referred to and is not evidence of submission.

Warnings outrank everything. If "data_warning" is set, or
"actionable.coverage.feeds_status" is "degraded" or "unknown", say so before you
answer — especially before saying nothing is due. Unknown coverage is not a
clear week. Describe submission coverage from the returned evidence; original
source receipts may be verified while other portals or individual items remain
unconfirmed. "coverage.submission_sources_checked" describes aggregate coverage,
not proof that every assignment was submitted; rely on each returned receipt.
Grades, attempted/viewed content and expired dates do not establish
submission. For calendar health, use feed_health and coverage; use local_time
for the date of this live response.

"recent_changes" includes source deadline changes and explicitly labeled Bridge
classification corrections. A reclassified course module remains on the source
calendar; do not call it deleted, completed, or an instructor date change. A
to_date with to_time_verification="unconfirmed" confirms only the date, never a
midnight exam time. "completion_ambiguous" is a
report that matched several items and cleared none — ask which he meant.
"optional_*" is ungraded work that no calendar carries, so it is easy for him to
miss. "ai_policy" per course matters: where AI is banned, steer him to studying
rather than drafting.

Deliver what he asked, at the scope he asked. Don't add adjacent advice he
didn't request.`;

/**
 * @returns {Promise<{ok: true, text: string} | {ok: false, error: string}>}
 */
export async function askClaude(env, question, status) {
  let res;
  try {
    res = await fetch(API, {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        // Server-side fallback: if a safety classifier declines, the API reruns
        // the request on the recommended model instead of handing back a
        // refusal. Recommended default for Opus 5 and free when it never fires.
        'anthropic-beta': 'server-side-fallback-2026-07-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4000, // caps thinking + reply together on Opus 5
        system: SYSTEM,
        fallbacks: 'default',
        output_config: { effort: 'low' }, // plenty for lookup-and-summarise
        messages: [
          {
            role: 'user',
            content:
              `Live status payload:\n\`\`\`json\n${JSON.stringify(status)}\n\`\`\`\n\n` +
              `His question: ${question}`,
          },
        ],
      }),
    });
  } catch (e) {
    return { ok: false, error: 'assistant_unreachable' };
  }

  if (!res.ok) {
    // Collapsing every failure into one code hides the single thing that would
    // fix it — a rejected key, an unfunded account and a transient outage each
    // need a different response. Pass the upstream reason through; Anthropic's
    // error bodies carry a type and message and never echo the key.
    const detail = await res.json().catch(() => null);
    return {
      ok: false,
      error:
        res.status === 401
          ? 'assistant_key_rejected'
          : res.status === 400 && /credit|billing|balance/i.test(detail?.error?.message || '')
            ? 'assistant_no_credit'
            : 'assistant_error',
      status: res.status,
      detail: detail?.error?.message || null,
    };
  }

  const body = await res.json().catch(() => null);
  if (!body) return { ok: false, error: 'assistant_bad_response' };

  // Check stop_reason before reading content: on a refusal, content is empty
  // (declined before output) or partial (declined mid-stream). Indexing
  // content[0] blindly is the documented way to break here.
  if (body.stop_reason === 'refusal') return { ok: false, error: 'assistant_declined' };

  const text = (body.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();

  return text ? { ok: true, text } : { ok: false, error: 'assistant_empty' };
}
