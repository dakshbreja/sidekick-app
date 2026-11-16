// Fall 2026 course registry.
//
// `aiPolicy` is load-bearing, not documentation: MGMT 5850 and MGMT 5560 both
// forbid AI-generated work on assignments, so their briefings must point at
// studying rather than offer to draft the deliverable.

export const TERM = { name: 'Fall 2026', start: '2026-08-17', end: '2026-12-01' };

export const COURSES = [
  {
    code: 'BUSN5000',
    label: 'BUSN 5000',
    title: 'Introduction to Data Science for Business and Economics',
    instructor: 'Cornwell',
    gpt: 'Business 5000',
    priority: 1,
    aiPolicy: 'encouraged',
    aiNote: 'Cornwell encourages AI on homework and the project. No AI on the in-class exams.',
  },
  {
    code: 'MGMT4280',
    label: 'MGMT 4280',
    title: 'Supply Chain Analytics',
    instructor: 'Beil',
    gpt: 'Management 4280',
    priority: 2,
    aiPolicy: 'encouraged',
    aiNote: 'Beil\'s syllabus: AI is permitted and encouraged for assignments, projects and case studies — but not on quizzes or exams, which run under Respondus LockDown.',
  },
  {
    code: 'MGMT5560',
    label: 'MGMT 5560',
    title: 'International Strategic Management',
    instructor: 'Hill',
    gpt: 'Management 5560',
    priority: 3,
    aiPolicy: 'banned-on-assignments',
    aiNote: 'Hill bans AI-generated responses for student and group assignments unless he permits it in an eLC announcement. Study and exam prep only.',
  },
  {
    code: 'MGMT5850',
    label: 'MGMT 5850',
    title: 'Performance Management and Compensation',
    instructor: 'Guhde',
    gpt: 'Performance and Comp Management (5850)',
    priority: 4,
    aiPolicy: 'banned-on-assignments',
    aiNote: 'Guhde treats AI-generated assignment responses as unauthorized assistance. Study and exam prep only.',
  },
  {
    code: 'LAND2510',
    label: 'LAND 2510E',
    title: 'History of the Built Environment I',
    instructor: 'Riggs',
    gpt: 'Land 2510',
    priority: 5,
    aiPolicy: 'unconfirmed',
    aiNote: 'Fall syllabus not yet reviewed. Treat the policy as unconfirmed.',
  },
  {
    code: 'BUSN3040',
    label: 'BUSN 3040E',
    title: 'R Programming for Business Analytics I',
    instructor: 'Jetha',
    gpt: 'Business 3040',
    priority: 6,
    aiPolicy: 'unconfirmed',
    aiNote: 'Course runs Oct 7 - Dec 1. Syllabus not yet published.',
  },
];

const BY_CODE = new Map(COURSES.map((c) => [c.code, c]));
const TITLE_PREFIXES = COURSES.map(course => {
  const [, subject, number] = /^([A-Z]+)(\d+)$/.exec(course.code);
  return [course, new RegExp(`^\\s*${subject}\\s*[-_]?\\s*${number}(?:E)?(?=$|[^A-Z0-9])`, 'i')];
});

/** Loose normalisation so "MGMT 5560", "MGMT5560" and "GP_MGMT5560" all match. */
function normalize(s) {
  return (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Resolve a user-supplied course identifier ("busn 5000", "BUSN5000") to a course. */
export function resolveCourse(input) {
  if (!input) return null;
  const n = normalize(input);
  if (BY_CODE.has(n)) return BY_CODE.get(n);
  // Accept the bare number too, e.g. "5000".
  const numeric = COURSES.filter((c) => normalize(c.code).endsWith(n));
  return numeric.length === 1 ? numeric[0] : null;
}

/**
 * An explicit leading course label owns the event. Descriptions often mention
 * competing deadlines in other courses; registry order must not reassign a
 * MGMT5560 event just because its note also names MGMT4280. Unlabelled eLC titles
 * still need the original location/description fallback.
 */
export function courseForEvent(event) {
  const labelled = TITLE_PREFIXES.find(([, pattern]) => pattern.test(String(event.summary || '')));
  if (labelled) return labelled[0];
  const haystack = normalize(`${event.summary} ${event.location} ${event.description}`);
  for (const c of COURSES) {
    if (haystack.includes(normalize(c.code))) return c;
  }
  return null;
}
