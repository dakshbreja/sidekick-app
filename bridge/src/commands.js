// The slash-command directory the GPTs advertise, and the rule for how often they
// may call the bridge.
//
// Both ride along in the /status payload rather than living in each GPT's
// Instructions. That is not a stylistic choice: several of the GPTs are within a
// few dozen characters of ChatGPT's 8,000-character instruction cap (MGMT 5850 sits
// at 7,998), so there is nowhere to put this. Shipping it in the response means one
// edit here updates every GPT at once, with no editor work and no risk of pushing a
// GPT over the cap.

// Why the GPTs were told to call /status "at the start of every conversation":
// deadlines move and a stale answer is worse than a slow one. The cost is that a
// thread running for weeks re-read the whole payload on every turn — and bursts of
// /status are what tripped the Worker CPU limit before. Once per conversation, plus
// on demand, keeps the data fresh where it matters and stops the rest.
export const CALL_POLICY = [
  'Call getCourseStatus ONCE per conversation, on your first reply, and lead with `briefing`.',
  'Do not call it again on later turns just to re-check.',
  'Call it again only when: Daksh asks for an update or uses a slash command that needs one;',
  'he reports finishing something; or he asks about a specific date or deadline AND',
  '`local_time` from your earlier reading is a different calendar day from today.',
  'Everything you already read stays valid for the rest of the conversation — say',
  '"as of <local_time>" rather than silently refetching.',
].join(' ');

// Kept deliberately terse: this ships inside every /status response, so each entry
// pays for itself in bytes on every call.
export const COMMANDS = [
  { cmd: '/help', does: 'List these commands', op: null },
  { cmd: '/status', does: 'Re-read live state now', op: 'getCourseStatus' },
  { cmd: '/today', does: "Today's classes and what is due", op: 'getCourseStatus' },
  { cmd: '/due', does: 'Due this week, soonest first', op: 'getCourseStatus' },
  { cmd: '/overdue', does: 'Everything past its date', op: 'getCourseStatus' },
  { cmd: '/next', does: 'Next class: when and where', op: 'getCourseStatus' },
  { cmd: '/week', does: 'The week ahead across courses', op: 'getCourseStatus' },
  { cmd: '/optional', does: 'Ungraded readings and practice', op: 'getCourseStatus' },
  { cmd: '/changes', does: 'Deadlines that moved recently', op: 'getCourseStatus' },
  { cmd: '/notes', does: 'Recent class notes for this course', op: 'getCourseStatus' },
  { cmd: '/progress', does: 'What is done, started, blocked', op: 'getCourseStatus' },
  { cmd: '/done <item>', does: 'Mark an item finished', op: 'recordProgress' },
  { cmd: '/started <item>', does: 'Mark an item in progress', op: 'recordProgress' },
  { cmd: '/blocked <item>', does: 'Mark an item blocked', op: 'recordProgress' },
  { cmd: '/find <words>', does: 'Find an original in Drive', op: 'searchLibrary' },
  { cmd: '/read <words>', does: 'Read an original from Drive', op: 'getDocument' },
];

// The first wording was too soft. Asked for "/help", BUSN 5000 ignored this list
// entirely, described its own study/quiz modes from its Instructions, and offered
// "/quiz" and "/study" — commands that do not exist. A GPT's persona will win over
// a polite suggestion in a tool response every time, so this now states the one
// thing it must not do (invent commands) and the exact output for /help.
export const COMMAND_HELP =
  'COMMAND MODE. If Daksh sends exactly "/help" or "/commands", your entire reply is '
  + 'the `commands` list below — every entry, `cmd` then `does`, as a plain list, with '
  + 'no preamble. Do NOT describe your own modes and do NOT invent commands: the only '
  + 'commands that exist are the ones in `commands`. For any other message starting '
  + 'with "/", match its first word against `commands` and do only that, answering '
  + 'nothing else; if it matches no entry, show the list. Most commands are views of '
  + 'data you already hold from getCourseStatus — answer from that rather than calling '
  + 'again.';

/** What rides along in /status. Small on purpose — it ships on every call. */
export function agentGuide() {
  return {
    call_policy: CALL_POLICY,
    command_help: COMMAND_HELP,
    commands: COMMANDS.map(({ cmd, does }) => ({ cmd, does })),
  };
}
