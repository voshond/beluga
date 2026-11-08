import type { Field } from './shape.js';

/**
 * What `preview.open` answers (src/preview/manager.ts): where the frame loads the preview from
 * and what its props are, or why it can't be drawn, in plain words. Browser-safe: types and words.
 */

export type ProblemKind =
  /** Live previews are off (Settings › Experimental). */
  | 'off'
  /** The file isn't in the worktree, or may hold secrets. */
  | 'missing'
  | 'no-component'
  /** The project's packages aren't installed (no React to draw with). */
  | 'not-installed'
  | 'missing-package'
  | 'missing-import'
  /** The file doesn't read as code right now (Claude may be halfway through it). */
  | 'syntax'
  | 'build'
  /** Nothing answers at the page's address. */
  | 'not-running'
  /** The page says it may not be shown inside another app. */
  | 'no-frames'
  /** A drawing failed in the frame. */
  | 'render'
  /** It needs a provider (a router, theme, store) the preview didn't give it. */
  | 'provider'
  | 'elsewhere';

export interface PreviewProblem {
  readonly ok: false;
  readonly kind: ProblemKind;
  /** A calm headline, in plain words. */
  readonly title: string;
  /** One sentence on what to do. */
  readonly detail: string;
  /** The technical details, never shown: they go to Claude when you ask it to fix this. */
  readonly forClaude?: string;
}

export interface PreviewOpened {
  readonly ok: true;
  readonly id: string;
  /** What the frame loads. */
  readonly url: string;
  readonly kind: 'component' | 'html' | 'url';
  /** Changes with each new build. */
  readonly version: number;
  /** The component drawn, the others the file exports, and its props. */
  readonly component?: {
    readonly name: string;
    readonly exports: readonly string[];
    readonly props: readonly Field[];
    readonly framework?: 'react' | 'vue' | 'svelte';
    /** The wrapper its providers come from, from the project root. */
    readonly wrapper?: string;
  };
  /** Every component of the file with its own sample props (React files with more than one): Show All. */
  readonly gallery?: ReadonlyArray<{ readonly name: string; readonly label: string; readonly props: Readonly<Record<string, unknown>> }>;
  /** The props it starts with: Claude's, then samples from the types. */
  readonly props?: Readonly<Record<string, unknown>>;
}

export type PreviewResult = PreviewOpened | PreviewProblem;

export const problem = (kind: ProblemKind, title: string, detail: string, forClaude?: string): PreviewProblem => ({ ok: false, kind, title, detail, ...(forClaude ? { forClaude } : {}) });

/**
 * What a component that needs a provider says when it's drawn without one, and which provider:
 * the "useX must be used within XProvider" convention, React Router, Redux, React Query, and
 * contexts named in "could not find … context".
 */
const PROVIDERS: ReadonlyArray<readonly [RegExp, (m: RegExpExecArray) => string]> = [
  [/\bmust be used (?:with)?in(?:side)? (?:an? |the )?<?([A-Z][\w.]*)>?/, (m) => m[1]!],
  [/\buseNavigate\(\) may be used only in the context of a <Router>|\buse\w+\(\) may be used only in the context of a <(\w+)>/, (m) => m[1] ?? 'Router'],
  [/could not find react-redux context value/i, () => 'a Redux Provider'],
  [/No QueryClient set, use QueryClientProvider/i, () => 'QueryClientProvider'],
  [/could not find (?:the )?["'`]?([A-Z][\w.]*)["'`]? context/i, (m) => m[1]!],
  [/\b([A-Z][\w]*(?:Provider|Context))\b(?: is)? (?:missing|not found)/, (m) => m[1]!],
];

/** The provider a failure says the component needs, if it says one. */
export function providerNeeded(message: string): string | undefined {
  for (const [re, name] of PROVIDERS) {
    const m = re.exec(message);
    if (m) return name(m);
  }
  return undefined;
}

/** Where a project's previews get their providers (preview/project.ts WRAPPERS). */
export const WRAPPER_FILE = 'preview-wrapper.tsx';

/** A drawing that failed in the frame, worded for people; the error itself goes to Claude. */
export function renderProblem(name: string, message: string, stack: string): PreviewProblem {
  const provider = providerNeeded(message);
  if (provider) {
    return problem(
      'provider',
      `${name} needs to sit inside ${provider}`,
      `A ${WRAPPER_FILE} in the project gives every preview what it needs. Your agent can set one up.`,
      `${message}\n${stack}\n\nThe preview draws the component on its own. To give it ${provider}, create ${WRAPPER_FILE} at the project root (or src/) that default-exports a component wrapping {children} in the providers the app uses (router, theme, store, query client), with sample values. Beluga wraps every preview in it.`.trim(),
    );
  }
  const needs = /reading '([^']+)'|undefined is not an object \(evaluating '([^']+)'\)/.exec(message);
  const detail = needs ? 'It may need a prop these samples don’t have. Change one beside it, or ask your agent.' : 'Try other props beside it, or ask your agent to look.';
  return problem('render', `${name} stopped while drawing`, detail, `${message}\n${stack}`.trim());
}
