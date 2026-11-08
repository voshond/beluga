import type { View } from '../../../../src/core/store.js';

type LinkedKind = Exclude<View['kind'], 'draft' | 'draft_worktree'>;

const REQUIRED: Record<LinkedKind, readonly string[]> = {
  room: [],
  assistant: [],
  phone: [],
  files: [],
  overview: [],
  workspace: ['id', 'tab'],
  search: [],
  usage: [],
  terminal: [],
  shared: ['owner', 'id', 'tab'],
  conversation: ['id'],
  claude_code: [],
  project: ['id'],
  requests: [],
  notifications: [],
  tasks: [],
  task: ['id'],
  issues: [],
  gh_issue: ['projectId', 'number'],
  pulls: [],
  actions: [],
  gh_run: ['projectId', 'runId'],
  plans: [],
  plan: ['id'],
  team_plan: ['owner', 'id'],
  worktrees: [],
  sentinel: [],
  sentinel_page: ['id'],
  sentinel_run: ['runId'],
  dashboard: [],
  sentinel_chat: [],
};

const NUMERIC: ReadonlySet<string> = new Set(['gh_issue.number', 'gh_run.runId']);

const isLinked = (kind: string): kind is LinkedKind => Object.hasOwn(REQUIRED, kind);

export const viewToHash = (view: View): string | undefined => {
  if (!isLinked(view.kind)) return undefined;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(view)) {
    if (key === 'kind') continue;
    if (typeof value === 'string' || typeof value === 'number') params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `#/${view.kind}?${query}` : `#/${view.kind}`;
};

export const viewFromHash = (hash: string): View | undefined => {
  const match = /^#\/([a-z_]+)(?:\?(.*))?$/.exec(hash);
  const kind = match?.[1];
  if (!kind || !isLinked(kind)) return undefined;
  const fields: Record<string, string | number> = {};
  for (const [key, value] of new URLSearchParams(match?.[2] ?? '')) {
    if (key === 'kind') continue;
    if (!NUMERIC.has(`${kind}.${key}`)) {
      fields[key] = value;
      continue;
    }
    const number = Number(value);
    if (value === '' || !Number.isSafeInteger(number)) return undefined;
    fields[key] = number;
  }
  if (REQUIRED[kind].some((key) => !(key in fields))) return undefined;
  return { ...fields, kind } as View;
};
