export type MockKind = 'jira' | 'slack' | 'decision';

export type ClarifyMessage = {
  readonly from: 'me' | 'agent';
  readonly text: string;
};

export type MockSuggestion = {
  readonly id: number;
  readonly kind: MockKind;
  readonly headline: string;
  readonly text: string;
  readonly why: string;
  readonly refs: readonly string[];
  readonly thread: readonly ClarifyMessage[];
};

export const MOCK_SUGGESTIONS: readonly MockSuggestion[] = [
  {
    id: 1,
    kind: 'slack',
    headline: 'Flag inverted checks to Steve',
    text: 'RUN-196/197 require end dates in the future while RUN-195 selects ones in the past, and RUN-205 allows rollback only for terminated MCs / non-FP owners.',
    why: 'As written, no item would ever be extended and rollbacks would only work in the cases they should be blocked.',
    refs: ['RUN-195', 'RUN-196', 'RUN-197', 'RUN-205'],
    thread: [
      { from: 'me', text: 'What exactly is inverted in RUN-196? I thought future end dates were the point.' },
      {
        from: 'agent',
        text: 'RUN-196 says "only extend items whose end date is in the future", but RUN-195 (the selector) only returns items whose end date already passed. Chained together, the set is always empty. One of the two has to flip.',
      },
    ],
  },
  {
    id: 2,
    kind: 'jira',
    headline: 'Answer Steve on RUN-89, add invoice rule to RUN-199',
    text: "Answer Steve's unanswered question on RUN-89 (16 Nov) and add Finance's separate-invoice requirement to RUN-199.",
    why: "Steve asked whether your screenshot is about the new extension charge; RUN-199 doesn't mention the separate invoice yet.",
    refs: ['RUN-89', 'RUN-199'],
    thread: [],
  },
  {
    id: 3,
    kind: 'decision',
    headline: 'Define what a first-extension rollback reverts to',
    text: 'Define what a rollback of the first extension reverts to.',
    why: 'RUN-204/205 revert to previousExtension.contractEndDate, which is null for the first extension.',
    refs: ['RUN-204', 'RUN-205'],
    thread: [],
  },
  {
    id: 4,
    kind: 'jira',
    headline: 'Update RUN-203/204/205 to the decided rules',
    text: 'Only the latest extension, only during its duration, one extension per rollback; drop the 3-months-from-creation check.',
    why: 'The tickets still spec the old 3-month window, so the build would follow the wrong rule.',
    refs: ['RUN-203', 'RUN-204', 'RUN-205'],
    thread: [],
  },
];

export const KIND_LABEL: Record<MockKind, string> = {
  jira: 'Jira',
  slack: 'Slack',
  decision: 'Decision',
};

export const MOCK_AGENT_REPLY =
  'Good question. In short: the tickets were written before the decision on 20 Nov, so they still describe the old flow. Want me to reword the suggestion with that context before you approve?';
