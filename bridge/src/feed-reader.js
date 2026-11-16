// One bounded read contract for the status API and the health monitor. HTTP 200
// is not evidence of a calendar: providers can return login/error HTML with it.
export const MAX_FEED_BYTES = 2 * 1024 * 1024;
export const FEED_TIMEOUT_MS = 10000;

export async function calendarText(response, signal) {
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const reader = response.body?.getReader();
  let text;
  if (reader) {
    const chunks = []; let size = 0;
    const cancel = () => { void reader.cancel().catch(() => {}); };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      while (true) {
        signal?.throwIfAborted();
        const { done, value } = await reader.read();
        signal?.throwIfAborted();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_FEED_BYTES) throw new Error('calendar_too_large');
        chunks.push(value);
      }
      text = await new Blob(chunks).text();
    } catch (err) {
      await reader.cancel().catch(() => {});
      throw err;
    } finally {
      signal?.removeEventListener('abort', cancel);
      reader.releaseLock();
    }
  } else if (response.body === undefined && typeof response.text === 'function') {
    // Small fetch doubles used by the dependency-free Node test suite. A native
    // Response always has .body (possibly null), so this is not a network path.
    text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_FEED_BYTES) throw new Error('calendar_too_large');
  } else throw new Error('invalid_calendar');
  validateCalendar(text);
  return text;
}

export function validateCalendar(text) {
  const lines = text.replace(/^\uFEFF/, '').trim().split(/\r\n|\n|\r/);
  if (lines[0] !== 'BEGIN:VCALENDAR' || lines.at(-1) !== 'END:VCALENDAR') throw new Error('invalid_calendar');
  const stack = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line)) continue;
    if (line.startsWith('BEGIN:')) {
      const kind=line.slice(6);
      if ((!stack.length && kind!=='VCALENDAR') || (stack.length && kind==='VCALENDAR') ||
          (kind==='VEVENT' && stack.at(-1)!=='VCALENDAR')) throw new Error('invalid_calendar');
      stack.push(kind);
    }
    else if (line.startsWith('END:') && stack.pop() !== line.slice(4)) throw new Error('invalid_calendar');
  }
  if (stack.length) throw new Error('invalid_calendar');
}

export function feedError(err) {
  const message = String(err?.message || err);
  const http = /^HTTP (\d{3})$/.exec(message);
  if (http) return `HTTP ${http[1]}`;
  if (/timeout|abort/i.test(message) || ['AbortError', 'TimeoutError'].includes(err?.name)) return 'calendar_timeout';
  if (/calendar_too_large/.test(message)) return 'calendar_too_large';
  if (/invalid_calendar|invalid_event|Invalid time value/.test(message)) return 'invalid_calendar';
  // Exception strings sometimes contain a private subscription URL. Never echo it.
  return 'calendar_unavailable';
}
