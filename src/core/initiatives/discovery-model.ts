import { z } from 'zod';
import type { Artifact } from './model.js';

/** The discovery stage (BLG-142): what the agent keeps while an idea is worked out, before epics exist. */

export const DISCOVERY_FILES = ['problem.md', 'evidence.md', 'prd.md', 'demo.json', 'proposal.json'] as const;

/** Where the agent writes a sizing finding; Beluga moves each file there into artifacts/ when its turn ends. */
export const SIZING_DIR = 'sizing';

export const DISCOVERY_TEXT_MAX = 24_000;

const JIRA_KEY = /^[A-Z][A-Z0-9_]{0,19}-\d{1,7}$/;

const maybe = (max: number) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((value) => value?.trim() || undefined);

const jiraKey = z
  .string()
  .max(40)
  .nullish()
  .transform((value) => {
    const key = value?.trim().toUpperCase();
    return key && JIRA_KEY.test(key) ? key : undefined;
  });

export const DEMO_STATES = ['drafted', 'started', 'done'] as const;
export type DemoState = (typeof DEMO_STATES)[number];

/** demo.json: the throwaway demo's task in a linked repo, as the agent made it. */
export const DemoSchema = z.object({
  repo: maybe(120),
  task: maybe(40).transform((key) => key?.toUpperCase()),
  title: maybe(300),
  state: z.enum(DEMO_STATES).catch('drafted'),
});
export type Demo = z.infer<typeof DemoSchema>;

const StorySchema = z.object({
  title: z.string().trim().min(1).max(300),
  key: jiraKey,
});

const ProposedEpicSchema = z.object({
  title: z.string().trim().min(1).max(300),
  why: maybe(1000),
  key: jiraKey,
  stories: z.array(StorySchema).max(50).default([]),
});
export type ProposedEpic = z.infer<typeof ProposedEpicSchema>;

/** proposal.json: the epics and stories the agent proposes; each gets its key once created in Jira. */
export const ProposalSchema = z.object({
  at: maybe(40),
  epics: z.array(ProposedEpicSchema).max(20).default([]),
});
export type Proposal = z.infer<typeof ProposalSchema>;

export type DiscoveryText = {
  readonly text: string;
  readonly cut: boolean;
};

export type Discovery = {
  readonly problem?: DiscoveryText;
  readonly evidence?: DiscoveryText;
  readonly prd?: DiscoveryText;
  readonly demo?: Demo;
  readonly proposal?: Proposal;
  readonly trouble?: string;
};

export const DiscoveryStepSchema = z.discriminatedUnion('step', [
  z.object({ step: z.literal('problem') }),
  z.object({ step: z.literal('size'), question: z.string().trim().min(1).max(1000) }),
  z.object({ step: z.literal('prd') }),
  z.object({ step: z.literal('confluence') }),
  z.object({ step: z.literal('demo'), repo: z.string().trim().min(1).max(120) }),
  z.object({ step: z.literal('propose') }),
]);
export type DiscoveryStep = z.infer<typeof DiscoveryStepSchema>;

export const ARTIFACT_ABOUT = ['sizing', 'demo'] as const;
export type ArtifactAbout = (typeof ARTIFACT_ABOUT)[number];

/** Newest first. */
export const artifactsAbout = (artifacts: readonly Artifact[], about: ArtifactAbout): Artifact[] => artifacts.filter((a) => a.about === about).sort((a, b) => b.id - a.id);

/** The keys of the proposed epics already created in Jira. */
export const proposedEpicKeys = (proposal: Proposal | undefined): string[] => (proposal?.epics ?? []).map((e) => e.key).filter((key): key is string => Boolean(key));
