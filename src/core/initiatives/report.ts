import os from 'node:os';
import path from 'node:path';
import type { InitiativeReportTools } from '../../agent/types.js';
import type { Initiatives } from './initiatives.js';
import { type InitiativeView, initiativeOfTicket, ticketKeyIn } from './model.js';

/** Your own run's worktree, as report_to_initiative sees it (core/workbench worktreeForRun). */
export type ReportingWorktree = {
  readonly name: string;
  readonly path: string;
  readonly ticket?: string;
  readonly branch?: string;
  readonly project?: string;
};

type Linked = { readonly item: InitiativeView; readonly ticket: string };

const TOOL = 'mcp__beluga_initiatives__report_to_initiative';

/** The initiative this worktree works for: its ticket, or a ticket key in its branch or name. */
export const linkedInitiative = (items: readonly InitiativeView[], ws: ReportingWorktree): Linked | undefined => {
  const keys = [ws.ticket, ticketKeyIn(ws.branch), ticketKeyIn(ws.name)].filter((k): k is string => Boolean(k));
  for (const ticket of keys) {
    const item = initiativeOfTicket(items, ticket);
    if (item) return { item, ticket: ticket.toUpperCase() };
  }
  return undefined;
};

const named = (items: readonly InitiativeView[], said: string): InitiativeView | undefined => {
  const wanted = said.trim().toLowerCase();
  return items.find((i) => i.slug === wanted) ?? items.find((i) => i.name.toLowerCase() === wanted);
};

const listed = (items: readonly InitiativeView[]): string => items.map((i) => `“${i.name}” (${i.slug})`).join(', ');

export const buildInitiativeReportAppend = (linked: { readonly name: string; readonly ticket: string } | undefined, others: readonly string[]): string =>
  linked
    ? `This worktree works on ${linked.ticket}, a ticket of the initiative “${linked.name}”: an effort the user drives, with its own page in Beluga. When the work makes something that initiative should keep (a report, test or validation output, a screenshot as proof, a generated spec or sample), send it there with ${TOOL}: the file, a short title and one line on why it matters. Only what is worth keeping, never every scratch file; and whenever the user asks you to.`
    : `The user drives initiatives in Beluga (${others.join(', ')}). When they ask you to send something this work made to one, use ${TOOL} with its name.`;

const fullPath = (file: string, cwd: string): string => {
  const home = file === '~' || file.startsWith('~/') ? path.join(os.homedir(), file.slice(1)) : file;
  return path.resolve(cwd, home);
};

/** report_to_initiative for your own run in this worktree. Undefined: there are no initiatives to send to. */
export const initiativeReportFor = (initiatives: Initiatives, items: readonly InitiativeView[], ws: ReportingWorktree): InitiativeReportTools | undefined => {
  const open = items.filter((i) => i.status !== 'archived');
  if (!open.length) return undefined;
  const linked = linkedInitiative(open, ws);
  return {
    brief: buildInitiativeReportAppend(linked ? { name: linked.item.name, ticket: linked.ticket } : undefined, open.map((i) => `“${i.name}”`)),
    report: (input) => {
      const target = input.initiative ? named(open, input.initiative) : linked?.item;
      if (!target) return Promise.reject(new Error(input.initiative ? `There is no initiative “${input.initiative}”. These are: ${listed(open)}.` : `This worktree isn't linked to an initiative by its ticket: name one of ${listed(open)}.`));
      const ticket = linked?.item.slug === target.slug ? linked.ticket : ws.ticket;
      return initiatives.reportArtifact(target.slug, {
        file: fullPath(input.file, ws.path),
        title: input.title,
        ...(input.why ? { why: input.why } : {}),
        ...(ticket ? { ticket } : {}),
        worktree: ws.name,
        ...(ws.project ? { project: ws.project } : {}),
      });
    },
  };
};
