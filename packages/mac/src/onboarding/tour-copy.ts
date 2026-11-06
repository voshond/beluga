import type { IconName } from '../components/Icon.js';
import type { Step } from './onboarding-model.js';

/** The tour's words, one idea a step. Every line says what the app really does. */
export interface TourCopy {
  readonly eyebrow: string;
  readonly icon: IconName;
  readonly title: string;
  readonly body: string;
  readonly points: readonly string[];
}

export const TOUR_COPY: Readonly<Partial<Record<Step, TourCopy>>> = {
  parallel: {
    eyebrow: 'Parallel',
    icon: 'branch',
    title: 'Work on everything at once.',
    body: 'Every task gets its own worktree on its own branch, with an agent working in it. Run as many as you like, in one repository or across all of them.',
    points: ['Worktrees and branches made for you', 'Pull requests opened and followed on GitHub', 'Sub-agents for the pieces in between'],
  },
  agents: {
    eyebrow: 'Live',
    icon: 'eye',
    title: 'See every agent work. Steer any of them.',
    body: 'Steps arrive as your agent works: the files it reads, the commands it runs, the screenshots it takes, the sub-agents and background tasks it starts. Say something mid-run and it changes course.',
    points: ['Sub-agents and background commands, live', 'Screenshots, logs and test output in one place', 'Redirect a run, or queue what comes next'],
  },
  tables: {
    eyebrow: 'In the chat',
    icon: 'table',
    title: 'Answers you can sort, not just read.',
    body: 'Ask about your data and your agent finds the database, picks the way in (Postgres, SQLite, a file, a URL), connects and runs the query. The answer comes back as a live table in the conversation.',
    points: ['Headings sort, long tables search and page', 'A table turns into a chart in a click', 'File trees, JSON, terminal output and diagrams too'],
  },
  friends: {
    eyebrow: 'Together',
    icon: 'people',
    title: 'Your agent, and your friends’ agents.',
    body: 'Add friends and your agents work together. Yours asks theirs for what only their computer has: a file, an account, a page they’re signed in to. They allow it, the result comes back, and yours carries on. Computer to computer, end-to-end encrypted.',
    points: ['Files, screenshots and errands between computers', 'You approve, or trust a friend once', 'Invite to one project, or to everything'],
  },
  sentinel: {
    eyebrow: 'Sentinel',
    icon: 'sentinel',
    title: 'Say when. Say what. Beluga keeps watch.',
    body: 'A sentinel is work you describe once, in a sentence. It waits for its moment (seven in the morning, a failing test, a new error in Sentry, your site going quiet), then works through its steps in order and leaves you a report.',
    points: ['When: a schedule, GitHub, Sentry, a site, a webhook', 'Then: an agent, a script, a service, a pull request, a merge', 'Starts paused. You choose if the agent may look, work or ship'],
  },
  uses: {
    eyebrow: 'Sentinel at work',
    icon: 'pulse',
    title: 'Real work, done while you sleep.',
    body: 'A few of the sentinels people set up first. Tell Ask Sentinel what you want in your own words and your agent builds it, steps and all, ready for you to turn on.',
    points: ['A fix waiting for your merge by morning', 'Your numbers on a board, your desktop and your phone', 'Every run kept, with its report'],
  },
  archive: {
    eyebrow: 'Archive',
    icon: 'archive',
    title: 'Archive without a second thought.',
    body: 'Done with a worktree? Archive it. Its folder goes, node_modules and builds with it, so your disk stays light. The branch and the whole conversation stay.',
    points: ['Folders removed, branches kept', 'Every conversation kept', 'Restore checks the branch out again'],
  },
};
