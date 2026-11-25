export type MockKind = 'jira' | 'slack' | 'decision';

export type MockState = 'open' | 'approved' | 'decided' | 'dismissed';

export type ProofKind = 'slack' | 'jira' | 'chat' | 'pr';

export type MockProof = {
  readonly kind: ProofKind;
  readonly label: string;
  readonly url: string;
};

export type MockEvent = {
  readonly at: string;
  readonly text: string;
};

export type MockSuggestion = {
  readonly id: number;
  readonly kind: MockKind;
  readonly state: MockState;
  readonly headline: string;
  readonly text: string;
  readonly why: string;
  readonly refs: readonly string[];
  readonly createdAt: string;
  readonly resolvedAt?: string;
  readonly inChat?: boolean;
  readonly answer?: string;
  readonly outcome?: string;
  readonly proof: readonly MockProof[];
  readonly timeline: readonly MockEvent[];
};

export const MOCK_SUGGESTIONS: readonly MockSuggestion[] = [
  {
    id: 14,
    kind: 'slack',
    state: 'open',
    headline: 'Flag inverted checks to Steve',
    text: 'RUN-196/197 require end dates in the future while RUN-195 selects ones in the past, and RUN-205 allows rollback only for terminated MCs / non-FP owners.',
    why: 'As written, no item would ever be extended and rollbacks would only work in the cases they should be blocked.',
    refs: ['RUN-195', 'RUN-196', 'RUN-197', 'RUN-205'],
    createdAt: '2026-11-25T09:12:00Z',
    inChat: true,
    proof: [{ kind: 'chat', label: 'Clarified in chat · 4 messages', url: '#chat' }],
    timeline: [
      { at: '25 Nov 09:12', text: 'Suggested by the morning check-in' },
      { at: '25 Nov 10:40', text: 'You asked about it in the chat' },
    ],
  },
  {
    id: 13,
    kind: 'jira',
    state: 'open',
    headline: 'Answer Steve on RUN-89, add invoice rule to RUN-199',
    text: "Answer Steve's unanswered question on RUN-89 (16 Nov) and add Finance's separate-invoice requirement to RUN-199.",
    why: "Steve asked whether your screenshot is about the new extension charge; RUN-199 doesn't mention the separate invoice yet.",
    refs: ['RUN-89', 'RUN-199'],
    createdAt: '2026-11-25T09:12:00Z',
    proof: [],
    timeline: [{ at: '25 Nov 09:12', text: 'Suggested by the morning check-in' }],
  },
  {
    id: 12,
    kind: 'decision',
    state: 'open',
    headline: 'Define what a first-extension rollback reverts to',
    text: 'Define what a rollback of the first extension reverts to.',
    why: 'RUN-204/205 revert to previousExtension.contractEndDate, which is null for the first extension.',
    refs: ['RUN-204', 'RUN-205'],
    createdAt: '2026-11-25T09:12:00Z',
    proof: [],
    timeline: [{ at: '25 Nov 09:12', text: 'Suggested by the morning check-in' }],
  },
  {
    id: 11,
    kind: 'jira',
    state: 'approved',
    headline: 'Update RUN-203/204/205 to the decided rules',
    text: 'Only the latest extension, only during its duration, one extension per rollback; drop the 3-months-from-creation check.',
    why: 'The tickets still spec the old 3-month window, so the build would follow the wrong rule.',
    refs: ['RUN-203', 'RUN-204', 'RUN-205'],
    createdAt: '2026-11-24T09:05:00Z',
    resolvedAt: '2026-11-25T08:30:00Z',
    outcome: 'All three tickets rewritten; the 3-month check is gone from the acceptance criteria.',
    proof: [
      { kind: 'jira', label: 'RUN-203 · description edited', url: '#' },
      { kind: 'jira', label: 'RUN-204 · description edited', url: '#' },
      { kind: 'jira', label: 'RUN-205 · description edited', url: '#' },
    ],
    timeline: [
      { at: '24 Nov 09:05', text: 'Suggested by the morning check-in' },
      { at: '25 Nov 08:30', text: 'You approved it' },
      { at: '25 Nov 08:34', text: 'Agent edited RUN-203, RUN-204, RUN-205' },
    ],
  },
  {
    id: 9,
    kind: 'decision',
    state: 'decided',
    headline: 'How many extensions can one rollback undo?',
    text: 'Choose whether a rollback undoes only the latest extension or the whole chain.',
    why: 'Steve and Finance gave different answers in #run-extensions.',
    refs: ['RUN-204'],
    createdAt: '2026-11-20T09:00:00Z',
    resolvedAt: '2026-11-20T14:12:00Z',
    answer: 'Only the latest extension, one per rollback.',
    outcome: 'Posted to #run-extensions; Steve and Finance both acknowledged.',
    proof: [
      { kind: 'chat', label: 'Clarified in chat · 7 messages', url: '#chat' },
      { kind: 'slack', label: '#run-extensions · decision posted', url: '#' },
    ],
    timeline: [
      { at: '20 Nov 09:00', text: 'Suggested by the morning check-in' },
      { at: '20 Nov 11:20', text: 'You asked about it in the chat' },
      { at: '20 Nov 14:12', text: 'You decided: only the latest extension' },
      { at: '20 Nov 14:15', text: 'Agent posted the decision to #run-extensions' },
      { at: '20 Nov 15:02', text: 'Steve reacted ✅' },
    ],
  },
  {
    id: 7,
    kind: 'slack',
    state: 'dismissed',
    headline: 'Remind Finance about the invoice template',
    text: 'Ping Finance in #finance-ops for the separate-invoice template.',
    why: 'No template linked on RUN-199 yet.',
    refs: ['RUN-199'],
    createdAt: '2026-11-19T09:00:00Z',
    resolvedAt: '2026-11-19T09:40:00Z',
    outcome: 'Dismissed: Finance already shared it in a call.',
    proof: [],
    timeline: [
      { at: '19 Nov 09:00', text: 'Suggested by the morning check-in' },
      { at: '19 Nov 09:40', text: 'You dismissed it' },
    ],
  },
];

export const KIND_LABEL: Record<MockKind, string> = {
  jira: 'Jira',
  slack: 'Slack',
  decision: 'Decision',
};

export const STATE_LABEL: Record<MockState, string> = {
  open: 'Open',
  approved: 'Approved',
  decided: 'Decided',
  dismissed: 'Dismissed',
};

export const PROOF_LABEL: Record<ProofKind, string> = {
  slack: 'Slack',
  jira: 'Jira',
  chat: 'Chat',
  pr: 'PR',
};

export const openOf = (all: readonly MockSuggestion[]): readonly MockSuggestion[] => all.filter((m) => m.state === 'open');

export const historyOf = (all: readonly MockSuggestion[]): readonly MockSuggestion[] => all.filter((m) => m.state !== 'open');
