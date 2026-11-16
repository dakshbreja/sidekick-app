// Synthetic feeds that mirror the exact shapes the real sources emit.
// The D2L block is modelled on the actual LAND 2510E and MGMT 4280 events
// observed in the imported feed on 2026-08-19.

export const D2L_FEED = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//D2L//Brightspace//EN
BEGIN:VEVENT
UID:d2l-land-q1-avail
SUMMARY:Quiz 01 _Origins - Available
LOCATION:LAND2510E History Built Environ I Landsc Fall 2026 59734
DTSTART:20260817T040100Z
DTEND:20260817T040100Z
END:VEVENT
BEGIN:VEVENT
UID:d2l-land-q1-ends
SUMMARY:Quiz 01 _Origins - Availability Ends
LOCATION:LAND2510E History Built Environ I Landsc Fall 2026 59734
DTSTART:20260823T035959Z
DTEND:20260823T035959Z
END:VEVENT
BEGIN:VEVENT
UID:d2l-land-q1-due
SUMMARY:Quiz 01 _Origins - Due
LOCATION:LAND2510E History Built Environ I Landsc Fall 2026 59734
DESCRIPTION:Quizzes:\\nQuiz 01 _Origins - https://uga.view.usg.edu/d2l/lms/quizzing/quizzing.d2l?ou=3962245
DTSTART:20260823T035959Z
DTEND:20260823T035959Z
END:VEVENT
BEGIN:VEVENT
UID:d2l-land-q2-due
SUMMARY:Quiz 02_ Western Asia to Muslim Conquest - Due
LOCATION:LAND2510E History Built Environ I Landsc Fall 2026 59734
DTSTART:20260823T035959Z
DTEND:20260823T035959Z
END:VEVENT
BEGIN:VEVENT
UID:d2l-land-q3-due
SUMMARY:Quiz 03 Islam - Western Asia - Due
LOCATION:LAND2510E History Built Environ I Landsc Fall 2026 59734
DTSTART:20260823T035959Z
DTEND:20260823T035959Z
END:VEVENT
BEGIN:VEVENT
UID:d2l-4280-start-quiz
SUMMARY:Semester Start Quiz - Requires Respondus LockDown Browser + Webcam - Due
LOCATION:XLS GP_MGMT4280 Supply Chain Analytics Fall 2026
DTSTART:20260824T035959Z
DTEND:20260824T035959Z
END:VEVENT
BEGIN:VEVENT
UID:d2l-5000-hw1-avail
SUMMARY:HW1 - Link 1 (Last Names A-L) - Available
LOCATION:XLS GP_BUSN5000 Intro to Data Science for Busn Fall 2026
DTSTART:20260818T040100Z
DTEND:20260818T040100Z
END:VEVENT
END:VCALENDAR`;

// Google Calendar block: recurring class meetings with TZID, all-day deadlines,
// one EXDATE cancellation and one RECURRENCE-ID override.
export const GOOGLE_FEED = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Google Inc//Google Calendar 70.9054//EN
BEGIN:VTIMEZONE
TZID:America/New_York
END:VTIMEZONE
BEGIN:VEVENT
UID:class-busn5000
SUMMARY:BUSN 5000 — Intro to Data Science for Business (Cornwell)
LOCATION:Amos Hall B010\\, Athens\\, GA
DTSTART;TZID=America/New_York:20260818T113500
DTEND;TZID=America/New_York:20260818T125500
RRULE:FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=20261202T045959Z
END:VEVENT
BEGIN:VEVENT
UID:class-mgmt5850
SUMMARY:MGMT 5850 — Performance Mgmt & Compensation (Guhde)
LOCATION:Room 101\\, Orkin Hall\\, Athens\\, GA
DTSTART;TZID=America/New_York:20260818T095500
DTEND;TZID=America/New_York:20260818T111500
RRULE:FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=20261202T045959Z
EXDATE;TZID=America/New_York:20260901T095500
END:VEVENT
BEGIN:VEVENT
UID:class-mgmt5560
SUMMARY:MGMT 5560 — International Strategic Management (Hill)
LOCATION:Journalism Building\\, Room 0508\\, Athens\\, GA
DTSTART;TZID=America/New_York:20260819T145500
DTEND;TZID=America/New_York:20260819T161500
RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261202T045959Z
END:VEVENT
BEGIN:VEVENT
UID:class-mgmt5560
RECURRENCE-ID;TZID=America/New_York:20260824T145500
SUMMARY:MGMT 5560 — GUEST SPEAKER (mandatory attendance)
LOCATION:Journalism Building\\, Room 0508\\, Athens\\, GA
DTSTART;TZID=America/New_York:20260824T145500
DTEND;TZID=America/New_York:20260824T161500
END:VEVENT
BEGIN:VEVENT
UID:dropadd
SUMMARY:⚠️ LAST DAY TO DROP/ADD — Fall 2026
DTSTART;VALUE=DATE:20260821
DTEND;VALUE=DATE:20260822
END:VEVENT
BEGIN:VEVENT
UID:busn5000-preproject
SUMMARY:BUSN 5000 — pre-Project exercise DUE (hard deadline)
DESCRIPTION:Set up R workflow\\, knit an R Markdown deck\\, export PDF. Worth 5% of the Project grade. Late submissions are NOT accepted\\, period.
DTSTART;VALUE=DATE:20260826
DTEND;VALUE=DATE:20260827
END:VEVENT
BEGIN:VEVENT
UID:globus-code
SUMMARY:MGMT 5560 — get your GLO-BUS registration code from Prof. Hill
DTSTART;VALUE=DATE:20260824
DTEND;VALUE=DATE:20260825
END:VEVENT
BEGIN:VEVENT
UID:mgmt5850-exam1
SUMMARY:MGMT 5850 — Exam 1 (ch. 1-6, 17)
DTSTART;TZID=America/New_York:20260929T095500
DTEND;TZID=America/New_York:20260929T111500
END:VEVENT
BEGIN:VEVENT
UID:cancelled-thing
SUMMARY:BUSN 5000 — cancelled session
STATUS:CANCELLED
DTSTART;TZID=America/New_York:20260820T113500
DTEND;TZID=America/New_York:20260820T125500
END:VEVENT
END:VCALENDAR`;

// A feed built for the completion-matching rules specifically: one title shared
// across two courses, one title reused twice inside a single course, and one
// deadline that belongs to no course at all. Every one of those cases used to
// resolve the wrong way — the cross-course pair cleared together, the reused
// title cleared both, and a report with no course matched anything anywhere.
export const DUP_TITLE_FEED = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//D2L//Brightspace//EN
BEGIN:VEVENT
UID:dup-busn-hw2
SUMMARY:Homework 2 - Due
LOCATION:XLS GP_BUSN5000 Intro to Data Science for Busn Fall 2026
DTSTART:20260817T035959Z
DTEND:20260817T035959Z
END:VEVENT
BEGIN:VEVENT
UID:dup-busn-quiz1
SUMMARY:Quiz 1 - Due
LOCATION:XLS GP_BUSN5000 Intro to Data Science for Busn Fall 2026
DTSTART:20260821T035959Z
DTEND:20260821T035959Z
END:VEVENT
BEGIN:VEVENT
UID:dup-mgmt-quiz1
SUMMARY:Quiz 1 - Due
LOCATION:XLS GP_MGMT4280 Supply Chain Analytics Fall 2026
DTSTART:20260822T035959Z
DTEND:20260822T035959Z
END:VEVENT
BEGIN:VEVENT
UID:dup-busn-log-a
SUMMARY:Weekly Log - Due
LOCATION:XLS GP_BUSN5000 Intro to Data Science for Busn Fall 2026
DTSTART:20260824T035959Z
DTEND:20260824T035959Z
END:VEVENT
BEGIN:VEVENT
UID:dup-busn-log-b
SUMMARY:Weekly Log - Due
LOCATION:XLS GP_BUSN5000 Intro to Data Science for Busn Fall 2026
DTSTART:20260831T035959Z
DTEND:20260831T035959Z
END:VEVENT
BEGIN:VEVENT
UID:dup-busn-hw3
SUMMARY:Homework 3 - Due
LOCATION:XLS GP_BUSN5000 Intro to Data Science for Busn Fall 2026
DTSTART:20260826T035959Z
DTEND:20260826T035959Z
END:VEVENT
BEGIN:VEVENT
UID:dup-general-advisor
SUMMARY:Advisor meeting
DTSTART:20260825T150000Z
DTEND:20260825T153000Z
END:VEVENT
END:VCALENDAR`;

/** A feed that always fails, to exercise the degraded-data path. */
export const BROKEN_FEED_URL = 'https://feed.invalid/does-not-exist.ics';

export function makeFetchStub(map) {
  return async (url) => {
    if (!(url in map)) return { ok: false, status: 404, text: async () => '' };
    const body = map[url];
    if (body instanceof Error) throw body;
    return { ok: true, status: 200, text: async () => body };
  };
}

// --- keeping the fixtures inside the live fetch window -----------------------
//
// The feeds above carry absolute dates, modelled on what the real sources emitted
// on FIXTURE_ANCHOR. Tests that pin `now` themselves (status.test.mjs) use them as
// written. Tests that drive the Worker cannot: `worker.fetch` reads the system
// clock and only loads events inside LOOKBACK/LOOKAHEAD of it, so once real time
// moved past the fixture the feeds arrived empty and every completion- and
// change-detection test failed on "fixture should provide at least one deadline".
//
// So those tests shift the whole feed forward instead. The shift is a whole number
// of WEEKS, never days: the Google block carries RRULE;BYDAY=TU,TH plus an EXDATE
// and a RECURRENCE-ID override, and shifting by anything else slides the events off
// the weekdays their recurrence rules name.
//
// Only the date half of each timestamp moves. Times of day and TZID stay untouched,
// so no arithmetic crosses a DST boundary.

export const FIXTURE_ANCHOR = Date.UTC(2026, 7, 19); // 2026-08-19

const DAY_MS = 86400000;
const pad = (n) => String(n).padStart(2, '0');

function shiftDate(token, days) {
  const at = new Date(Date.UTC(+token.slice(0, 4), +token.slice(4, 6) - 1, +token.slice(6, 8)) + days * DAY_MS);
  return `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}`;
}

/** Whole weeks between the fixture anchor and `now`, so the feed lands in-window. */
export function weeksSinceAnchor(now = Date.now()) {
  return Math.round((now - FIXTURE_ANCHOR) / (7 * DAY_MS)) * 7;
}

/** Move every date in an ICS feed by `days`, leaving times of day alone. */
export function shiftFeed(ics, days) {
  if (!days) return ics;
  return ics
    .replace(/^(DTSTART|DTEND|EXDATE|RECURRENCE-ID)([^:\n]*):(\d{8})/gm,
             (_, prop, params, date) => `${prop}${params}:${shiftDate(date, days)}`)
    .replace(/UNTIL=(\d{8})/g, (_, date) => `UNTIL=${shiftDate(date, days)}`);
}
