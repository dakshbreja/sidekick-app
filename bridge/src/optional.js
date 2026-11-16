// Optional and ungraded coursework: readings, videos, podcasts, practice sets,
// and bonus-point items.
//
// None of this appears in any calendar feed — instructors only put graded
// deadlines in eLC — so it has to be transcribed from the syllabi. Without it
// the GPTs are blind to roughly half of what Daksh is actually supposed to do.
//
// `from`/`to` are inclusive local dates bounding the week the item belongs to.
// `kind`:
//   reading  — assigned text, optional or not separately graded
//   watch    — video
//   listen   — podcast or audio
//   practice — ungraded problem set whose real purpose is exam prep
//   bonus    — optional but carries points if done

export const OPTIONAL_ITEMS = [
  // ── BUSN 5000 (Cornwell) ────────────────────────────────────────────────
  // Source: cornwl.github.io/courses/busn5000/fall-2026/schedule.html
  // No texts are required; every reading below is genuinely optional.
  { course: 'BUSN5000', kind: 'reading', from: '2026-08-17', to: '2026-08-21', title: 'Healy ch. 2; the BUSN 5000 R orientation and getting-started guide; Békés–Kézdi ch. 1; Bueno de Mesquita & Fowler ch. 1', note: 'Week 0, Data Fundamentals. The R orientation guide is the one genuinely worth doing — it sets up the tooling the pre-Project exercise needs.' },
  { course: 'BUSN5000', kind: 'listen', from: '2026-08-17', to: '2026-08-21', title: 'IRL: "How Posit helped Redfin move data from spreadsheets to a reproducible data science environment"', note: 'Context only, never tested.' },
  { course: 'BUSN5000', kind: 'practice', from: '2026-08-17', to: '2026-08-21', title: 'Homework 1', note: 'Due Fri Aug 21. Ungraded — everyone is assigned 100 up front — but the Dailies are drawn from it, so skipping it turns a free 20% into a failed 50%.' },

  { course: 'BUSN5000', kind: 'reading', from: '2026-08-24', to: '2026-08-28', title: 'Békés–Kézdi chs. 2-3', note: 'Week 1, Beginning to Learn.' },
  { course: 'BUSN5000', kind: 'listen', from: '2026-08-24', to: '2026-08-28', title: 'IRL: "What Can Uber Teach Us About the Gender Pay Gap?", Freakonomics Radio ep. 317' },
  { course: 'BUSN5000', kind: 'practice', from: '2026-08-24', to: '2026-08-28', title: 'Homework 2', note: 'Due Fri Aug 28. Ungraded, but feeds the Dailies.' },

  { course: 'BUSN5000', kind: 'reading', from: '2026-08-31', to: '2026-09-04', title: 'Békés–Kézdi ch. 4; Bueno de Mesquita & Fowler chs. 2, 4', note: 'Week 2, Models for Exploration.' },
  { course: 'BUSN5000', kind: 'watch', from: '2026-08-31', to: '2026-09-04', title: 'IRL: Stanford Digital Economies Lab — Canaries Dashboard' },
  { course: 'BUSN5000', kind: 'practice', from: '2026-08-31', to: '2026-09-04', title: 'Homework 3', note: 'Due Fri Sep 4.' },

  { course: 'BUSN5000', kind: 'reading', from: '2026-09-07', to: '2026-09-11', title: 'Békés–Kézdi chs. 5-6; Bueno de Mesquita & Fowler ch. 6', note: 'Week 3, Making Inferences. No class Mon Sep 7, Labor Day.' },
  { course: 'BUSN5000', kind: 'reading', from: '2026-09-07', to: '2026-09-11', title: 'IRL: "The Cybernetic Teammate", One Useful Thing' },
  { course: 'BUSN5000', kind: 'practice', from: '2026-09-07', to: '2026-09-11', title: 'Homework 4', note: 'Due Fri Sep 11.' },

  { course: 'BUSN5000', kind: 'reading', from: '2026-09-14', to: '2026-09-18', title: 'Bueno de Mesquita & Fowler ch. 16', note: 'Week 4, Measurement Error, Sample Selection and Confounding.' },
  { course: 'BUSN5000', kind: 'reading', from: '2026-09-14', to: '2026-09-18', title: 'IRL: "Using internal CPS data to reevaluate trends in labor-earnings gaps", Monthly Labor Review' },
  { course: 'BUSN5000', kind: 'practice', from: '2026-09-14', to: '2026-09-18', title: 'Homework 5', note: 'Due Fri Sep 18 — the last practice before the Part I Exam on Sep 24.' },

  { course: 'BUSN5000', kind: 'reading', from: '2026-09-21', to: '2026-09-25', title: 'Bueno de Mesquita & Fowler ch. 15', note: 'Week 5, The Bayesian Approach. Part I Exam is Thu Sep 24.' },
  { course: 'BUSN5000', kind: 'watch', from: '2026-09-21', to: '2026-09-25', title: 'Video: "Bayes theorem, the geometry of changing beliefs", 3Blue1Brown', note: 'Twenty minutes, and the single best intuition-builder for the Bayesian material on the exam.' },
  { course: 'BUSN5000', kind: 'reading', from: '2026-09-21', to: '2026-09-25', title: 'IRL: "Using Bayesian Updating to Improve Decisions under Uncertainty", California Management Review' },

  { course: 'BUSN5000', kind: 'reading', from: '2026-09-28', to: '2026-10-09', title: 'Bueno de Mesquita & Fowler ch. 5; Békés–Kézdi chs. 7-10; Angrist & Pischke ch. 2', note: 'Weeks 6-7, Regression Fundamentals.' },
  { course: 'BUSN5000', kind: 'listen', from: '2026-09-28', to: '2026-10-09', title: 'IRL: "Anybody Can Win, but Everybody’s Gonna Lose", Against the Rules S4E10' },
  { course: 'BUSN5000', kind: 'bonus', from: '2026-09-28', to: '2026-10-02', title: 'Project Progress Check submission (optional, +5 bonus points)', note: 'Due Fri Oct 2. Free feedback plus five bonus points on the course that gates his Analytics emphasis. He should do this one.' },
  { course: 'BUSN5000', kind: 'practice', from: '2026-10-05', to: '2026-10-09', title: 'Homework 6', note: 'Due Fri Oct 9.' },

  { course: 'BUSN5000', kind: 'reading', from: '2026-10-12', to: '2026-10-16', title: 'Békés–Kézdi chs. 19-20; Bueno de Mesquita & Fowler chs. 3, 9-11; Angrist & Pischke ch. 1', note: 'Week 8, Potential Outcomes and Causal Inference.' },
  { course: 'BUSN5000', kind: 'reading', from: '2026-10-12', to: '2026-10-16', title: 'IRL: Dell’Acqua et al., "The Cybernetic Teammate", Organization Science 37(4), 2026' },
  { course: 'BUSN5000', kind: 'practice', from: '2026-10-12', to: '2026-10-16', title: 'Homework 7', note: 'Due Fri Oct 16.' },

  { course: 'BUSN5000', kind: 'reading', from: '2026-10-19', to: '2026-10-23', title: 'Bueno de Mesquita & Fowler ch. 12; Angrist & Pischke ch. 4', note: 'Week 9, Regression Discontinuity.' },
  { course: 'BUSN5000', kind: 'listen', from: '2026-10-19', to: '2026-10-23', title: 'IRL: "Tom Brady, A.D.H.D., and a Really Bad Headache", Freakonomics M.D. (companion paper: Layton et al., NEJM 2018)' },
  { course: 'BUSN5000', kind: 'practice', from: '2026-10-19', to: '2026-10-23', title: 'Homework 8', note: 'Due Fri Oct 23.' },

  { course: 'BUSN5000', kind: 'reading', from: '2026-10-26', to: '2026-10-30', title: 'Békés–Kézdi ch. 22; Bueno de Mesquita & Fowler ch. 13; Angrist & Pischke ch. 5', note: 'Week 10, Difference in Differences. Fall Break Fri Oct 30.' },
  { course: 'BUSN5000', kind: 'listen', from: '2026-10-26', to: '2026-10-30', title: 'IRL: "Is Facebook Bad for Your Mental Health?", Freakonomics M.D.' },
  { course: 'BUSN5000', kind: 'practice', from: '2026-10-26', to: '2026-11-02', title: 'Homework 9', note: 'Due Mon Nov 2 — pushed back by Fall Break.' },

  { course: 'BUSN5000', kind: 'reading', from: '2026-11-02', to: '2026-11-20', title: 'Békés–Kézdi chs. 13-14', note: 'Weeks 11-13, Introduction to Machine Learning.' },
  { course: 'BUSN5000', kind: 'reading', from: '2026-11-02', to: '2026-11-20', title: 'IRL: "In Defense of Zillow’s Besieged Data Scientists", Medium' },
  { course: 'BUSN5000', kind: 'practice', from: '2026-11-16', to: '2026-11-20', title: 'Homework 10', note: 'Due Fri Nov 20 — the last one before the Part II Exam.' },

  // ── MGMT 5850 (Guhde) ───────────────────────────────────────────────────
  // Source: MGMT5850 syllabus F26.docx weekly table. Gerhart, Compensation, 2026 ed.
  // Reading matters less here than class notes, which are the real exam source.
  { course: 'MGMT5850', kind: 'reading', from: '2026-08-18', to: '2026-08-21', title: 'Course syllabus (ch. 1 intro)', note: 'Week of Aug 18 & 20.' },
  { course: 'MGMT5850', kind: 'reading', from: '2026-08-25', to: '2026-08-28', title: 'Gerhart ch. 2 — Strategy: The Totality of Decisions' },
  { course: 'MGMT5850', kind: 'reading', from: '2026-09-01', to: '2026-09-04', title: 'Gerhart ch. 3 — Internal Alignment' },
  { course: 'MGMT5850', kind: 'reading', from: '2026-09-08', to: '2026-09-11', title: 'Legal considerations (ch. 17)', note: 'The syllabus row reads only "Legal con’t". Exam 1 covers chs. 1-6 and 17, so ch. 17 is the legal block. His weakest area — drill it as flashcards.' },
  { course: 'MGMT5850', kind: 'reading', from: '2026-09-15', to: '2026-09-18', title: 'Gerhart ch. 5 — Job-Based Structures' },
  { course: 'MGMT5850', kind: 'reading', from: '2026-09-22', to: '2026-09-25', title: 'Gerhart ch. 6 — Person-Based Structures', note: 'Last content week before Exam 1 on Tue Sep 29.' },
  { course: 'MGMT5850', kind: 'reading', from: '2026-10-06', to: '2026-10-09', title: 'Gerhart ch. 8 — Designing Pay Levels, Mix & Structure' },
  { course: 'MGMT5850', kind: 'reading', from: '2026-10-13', to: '2026-10-16', title: 'Gerhart ch. 9 — Pay-for-Performance' },
  { course: 'MGMT5850', kind: 'reading', from: '2026-10-20', to: '2026-10-23', title: 'Gerhart ch. 10 — Pay-for-Performance Plans', note: 'Exam 2 is Thu Oct 22 and covers chs. 7-10.' },
  { course: 'MGMT5850', kind: 'reading', from: '2026-10-27', to: '2026-10-30', title: 'Gerhart ch. 11 — Performance Appraisals' },
  { course: 'MGMT5850', kind: 'reading', from: '2026-11-03', to: '2026-11-06', title: 'Gerhart ch. 12 — Employee Benefits' },
  { course: 'MGMT5850', kind: 'reading', from: '2026-11-10', to: '2026-11-13', title: 'Gerhart ch. 13 — Benefit Options' },
  { course: 'MGMT5850', kind: 'reading', from: '2026-11-17', to: '2026-11-20', title: 'Gerhart ch. 14 — Compensation of Special Groups', note: 'Exam 3 covers chs. 11-15.' },

  // ── MGMT 4280 (Beil) ────────────────────────────────────────────────────
  // No textbook. Overview articles live in the eLC module for each topic and are
  // not separately graded. Topic weeks are anchored to the assignment due dates.
  { course: 'MGMT4280', kind: 'reading', from: '2026-08-18', to: '2026-08-23', title: 'Overview articles: Introduction to Business Analytics (eLC module)' },
  { course: 'MGMT4280', kind: 'reading', from: '2026-08-24', to: '2026-08-30', title: 'Overview articles: ERP, Data Export & MRP (eLC module)', note: 'Assignment on this topic is due Sun Aug 30.' },
  { course: 'MGMT4280', kind: 'reading', from: '2026-08-31', to: '2026-09-06', title: 'Overview articles: Database Analytics & SQL (eLC module)', note: 'Assignment due Sun Sep 6. Uses the W3Schools SQL server and the Northwind case data.' },
  { course: 'MGMT4280', kind: 'reading', from: '2026-09-07', to: '2026-09-20', title: 'Overview articles: Spreadsheet Analytics (eLC module, two weeks)', note: 'Excel with the Data Analysis ToolPak and Solver. Exam 1 follows on Sep 24.' },
  { course: 'MGMT4280', kind: 'reading', from: '2026-09-28', to: '2026-10-01', title: 'Overview articles: Data Visualization & Storytelling (eLC module)', note: 'Assignment due Thu Oct 1.' },
  { course: 'MGMT4280', kind: 'reading', from: '2026-10-05', to: '2026-10-16', title: 'Overview articles: Forecasting & Resource Planning, then Performance Measurement (eLC modules)' },
  { course: 'MGMT4280', kind: 'reading', from: '2026-10-26', to: '2026-11-08', title: 'Overview articles: Modeling & Tool Building, then Linear Optimization (eLC modules)', note: 'Solver work here maps directly onto the optimization he did in BUSN 4000.' },
  { course: 'MGMT4280', kind: 'reading', from: '2026-11-09', to: '2026-11-15', title: 'Overview articles: Regression Analysis (eLC module)', note: 'Assignment due Sun Nov 15.' },
  { course: 'MGMT4280', kind: 'reading', from: '2026-11-16', to: '2026-12-01', title: 'Overview articles: AI in Supply Chain Analytics (eLC modules, two weeks)' },
];

// Recurring expectations with no single date. Always surfaced for their course.
export const STANDING_OPTIONAL = {
  MGMT5560: [
    { kind: 'reading', title: 'Assigned chapters before every class', note: 'Hill posts the schedule on eLC and in the GLO-BUS portal rather than in the syllabus — check there. His sessions build on the reading instead of replacing it, and participation is 6% graded on his subjective observation.' },
    { kind: 'bonus', title: 'End-of-chapter quizzes in the GLO-BUS e-text', note: 'Multiple-choice, due at the times set in the portal. These carry EXTRA CREDIT calculated from the average — genuinely free points that are easy to forget.' },
    { kind: 'reading', title: 'Wall Street Journal, free through UGA', note: 'Only worth it insofar as it fuels class participation.' },
  ],
  MGMT5850: [
    { kind: 'practice', title: 'Rewrite the day’s class notes into the running exam-prep sheet', note: 'Guhde posts outlines only and will not share slides for a missed class. The verbal examples are the testable content, so same-day note capture is the highest-value optional habit in this course.' },
  ],
  MGMT4280: [
    { kind: 'practice', title: 'Rehearse under Respondus LockDown conditions before each exam', note: 'No notes, no second monitor, timed. All three exams run this way and he has no accommodation for a technology failure.' },
  ],
  BUSN5000: [
    { kind: 'practice', title: 'Work the current homework set even though it is ungraded', note: 'Everyone is assigned 100 up front, so it looks free. The Dailies are drawn from it and the exams are 50% of the grade.' },
  ],
};

// Courses whose optional material has not been transcribed, so the GPT can say so
// instead of implying there is nothing to do.
export const UNCOVERED = {
  LAND2510: 'The Fall 2026 syllabus has not been reviewed yet, so readings and lecture videos for this course are not tracked. Only the eLC quiz deadlines come through.',
  BUSN3040: 'Course runs Oct 7 - Dec 1 and the eLC shell opens around Oct 5. Nothing is tracked yet.',
};

function toDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return { y, m, d };
}

/** Inclusive date-only comparison, avoiding any timezone drift. */
function within(iso, startKey, endKey) {
  const n = Number(iso.replace(/-/g, ''));
  return n >= startKey && n <= endKey;
}

/**
 * Optional items overlapping the window [today, today + days], plus that course's
 * standing items. `todayKey`/`endKey` are YYYYMMDD integers in local time.
 */
export function optionalFor(course, todayKey, endKey) {
  const code = course ? course.code : null;

  const dated = OPTIONAL_ITEMS.filter((it) => {
    if (code && it.course !== code) return false;
    const from = Number(it.from.replace(/-/g, ''));
    const to = Number(it.to.replace(/-/g, ''));
    return from <= endKey && to >= todayKey; // window overlap
  }).map((it) => ({
    course: it.course,
    kind: it.kind,
    title: it.title,
    window: `${it.from} to ${it.to}`,
    note: it.note || '',
    graded: it.kind === 'bonus',
  }));

  const standing = code && STANDING_OPTIONAL[code]
    ? STANDING_OPTIONAL[code].map((it) => ({ course: code, kind: it.kind, title: it.title, window: 'ongoing', note: it.note || '', graded: false }))
    : [];

  return { dated, standing, uncovered: code ? UNCOVERED[code] || null : null };
}

export const _internals = { toDate, within };
