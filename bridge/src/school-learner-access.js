// Explicit extension of the ONE existing school connection. No new credential,
// renewal, project/Wispr access, owner API access or generic grant administration.
export const EXISTING_CLAUDE_SCHOOL_GRANT='631f3fe7b72998171c95274046f2b11a17b9d592484c663d6aedcd30b5266299';
export const LEARNER_APPROVAL='daksh-20261103-existing-school-learner-access';
export const SCHOOL_LEARNER_SCOPES=Object.freeze(['learner.practice:read','learner.practice:write','learner.hypotheses:read','learner.hypotheses:student-status','learner.reviews:read','learner.grades:read','learner.grades:write']);
export const SCHOOL_LEARNER_TOOL_SCOPES=Object.freeze({
  start_practice_item:['learner.practice:write'],answer_practice_item:['learner.practice:write'],read_practice_items:['learner.practice:read'],
  read_learner_profile:['learner.practice:read','learner.hypotheses:read','learner.reviews:read','learner.grades:read'],
  read_hypotheses:['learner.hypotheses:read'],set_hypothesis_status:['learner.hypotheses:student-status'],read_review_items:['learner.reviews:read'],
  read_grade_outcomes:['learner.grades:read'],save_grade_outcome:['learner.grades:write'],
});
export const learnerToolAllowed=(name,scopes)=>!!SCHOOL_LEARNER_TOOL_SCOPES[name]&&SCHOOL_LEARNER_TOOL_SCOPES[name].every(s=>scopes.includes(s));
