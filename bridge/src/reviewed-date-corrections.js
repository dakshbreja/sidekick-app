// Exact, original-source observations reviewed by Codex. Keep academic date
// authority separate from progress/submission evidence. Add a correction only
// after checking the instructor source and the matching live calendar UID.
export const reviewedDateCorrections = [{
  id: 'mgmt5560-test-two-2026-10-05-announcement',
  term_id: 'fall-2026', course_code: 'MGMT5560', source: 'eLC (D2L)',
  uid: '6637-21909747@uga.view.usg.edu', recurrence_anchor: '', title: 'Test Two Administered',
  original: { start_iso: '2026-10-14T17:15:00.000Z', end_iso: '2026-10-14T18:35:00.000Z', all_day: false },
  // Hill's announcement confirms October 19 but gives no clock time. An all-day
  // display is a date anchor, explicitly not a claim about the exam's duration.
  effective: { start_iso: '2026-10-19T04:00:00.000Z', end_iso: '2026-10-20T04:00:00.000Z', all_day: true },
  authority: { kind: 'instructor_announcement', verified: true, precision: 'date',
    title: 'October 5 MGMT5560 announcement — Test 2 moved to October 19',
    url: 'https://uga.view.usg.edu/d2l/le/news/3963225/7098040/view?ou=3963225',
    published_at: '2026-10-05T18:29:00.000Z', observed_at: '2026-10-11T00:04:18.000Z' },
}];
