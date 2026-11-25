import { activityOf } from '@beluga/ui/workspace-models.js';
import type { IssueStatus } from '@beluga/core/board/model.js';
import { CHECK_IN_CHAT, type InitiativeView, type Ticket, type TicketCategory, type TicketPr, initiativeChatChannel, subTasksOf, ticketGroups } from '@beluga/core/initiatives/model.js';
import { Button } from '../components/ui.js';
import { useApp } from '../lib/beluga.js';
import { openExternal } from '../lib/system.js';
import { useClock } from '../lib/window-active.js';
import { TonePill } from '../plans/marks.js';
import type { Tone } from '../plans/plans-model.js';
import { StatusIcon } from '../tasks/marks.js';
import { ago } from '../tasks/tasks-model.js';
import { CATEGORY_LABEL, PR_STATE_LABEL, prName, subTasksWords, ticketsWords } from './initiatives-model.js';
import { EpicLink, Section } from './InitiativeParts.js';
import { useInitiativeActions } from './use-initiatives.js';
import s from './initiatives.module.css';

const whenOf = (iso: string | undefined, now: number): string => {
  const at = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(at) ? ago(at, now) : '';
};

const PrLink = ({ pr }: { pr: TicketPr }) => (
  <button type="button" className={s.prLink} data-state={pr.state} onClick={() => void openExternal(pr.url)} title={pr.title ?? pr.url} aria-label={`Open pull request ${prName(pr)}${pr.repo ? ` in ${pr.repo}` : ''}: ${PR_STATE_LABEL[pr.state]}`}>
    {prName(pr)}
    <span className={s.prState}>{PR_STATE_LABEL[pr.state]}</span>
  </button>
);

const PrLinks = ({ prs }: { prs: readonly TicketPr[] }) => (
  <span className={s.prs}>
    {prs.map((pr) => (
      <PrLink key={pr.url} pr={pr} />
    ))}
  </span>
);

const TICKET_STATUS: Readonly<Record<TicketCategory, IssueStatus>> = { todo: 'todo', inProgress: 'in_progress', done: 'done' };

const TICKET_TONE: Readonly<Record<TicketCategory, Tone>> = { todo: 'neutral', inProgress: 'claude', done: 'ok' };

const TicketRow = ({ ticket, subTasks = [], nested = false, now }: { ticket: Ticket; subTasks?: readonly Ticket[]; nested?: boolean; now: number }) => {
  const url = ticket.url;
  const progress = subTasksWords(subTasks);
  const who = [ticket.assignee ?? 'Unassigned', whenOf(ticket.updated, now)].filter(Boolean).join(' · ');
  const handleOpen = (): void => {
    if (url) void openExternal(url);
  };
  return (
    <div role="listitem" className={s.ticket} data-ticket={ticket.key} data-category={ticket.statusCategory} data-sub-task={nested}>
      <button type="button" className={s.ticketMain} onClick={handleOpen} disabled={!url} aria-label={`Open ${ticket.key} in Jira: ${ticket.summary}`}>
        <StatusIcon status={TICKET_STATUS[ticket.statusCategory]} size={14} />
        <span className={s.ticketKey}>{ticket.key}</span>
        <span className={s.ticketSummary}>{ticket.summary}</span>
      </button>
      <span className={s.ticketEnd}>
        {ticket.prs.map((pr) => (
          <PrLink key={pr.url} pr={pr} />
        ))}
        {progress ? <span className={s.ticketSubTasks}>{progress}</span> : null}
        <span className={s.ticketWho}>{who}</span>
        <TonePill tone={TICKET_TONE[ticket.statusCategory]}>{ticket.status || CATEGORY_LABEL[ticket.statusCategory]}</TonePill>
      </span>
    </div>
  );
};

const TicketList = ({ tickets, all, name, now }: { tickets: readonly Ticket[]; all: readonly Ticket[]; name: string; now: number }) => (
  <div className={s.ticketList} role="list" aria-label={name}>
    {tickets.flatMap((ticket) => {
      const subTasks = subTasksOf(ticket.key, all);
      return [<TicketRow key={ticket.key} ticket={ticket} subTasks={subTasks} now={now} />, ...subTasks.map((sub) => <TicketRow key={sub.key} ticket={sub} nested now={now} />)];
    })}
  </div>
);

const emptyWords = (item: InitiativeView, fetching: boolean): string => {
  if (!item.epics.length) return 'No Jira epic linked: Edit… to add one, and its tickets show here.';
  if (fetching) return 'Reading the tickets from Jira: follow it in the Check-in chat.';
  if (!item.tickets) return 'No tickets read yet. Refresh reads them from Jira, and every check-in does too.';
  return `No tickets under ${item.epics.join(', ')} yet.`;
};

export const TicketsTable = ({ item }: { item: InitiativeView }) => {
  const a = useInitiativeActions();
  const now = useClock(true, 60_000);
  const fetching = useApp((st) => activityOf(st.log, initiativeChatChannel(item.slug, CHECK_IN_CHAT)).running);
  const groups = item.epics.length && item.tickets ? ticketGroups(item.tickets.tickets, item.epics) : [];
  const handleRefresh = (): void => void a.act(() => a.api.refreshTickets(item.slug), 'Reading the tickets: follow it in the Check-in chat');
  const read = item.tickets && groups.length ? `${ticketsWords(item.tickets)} · read ${whenOf(item.tickets.at, now) || 'earlier'}` : '';
  const aside = (
    <>
      <Button size="small" icon="refresh" onClick={handleRefresh} disabled={!item.epics.length || fetching} aria-label="Refresh the tickets from Jira">
        {fetching ? 'Refreshing…' : 'Refresh'}
      </Button>
    </>
  );
  return (
    <Section title="Tickets" aside={aside}>
      {read ? <span className={s.quiet}>{read}</span> : null}
      {groups.length ? (
        <div className={s.ticketGroups}>
          {groups.map((group) => (
            <div key={group.epic ?? 'other'} className={s.ticketGroup} data-epic={group.epic ?? 'other'}>
              {group.epic ? <EpicLink epic={group.epic} item={item} /> : groups.length > 1 ? <span className={s.epicName}>Other tickets</span> : null}
              <TicketList tickets={group.tickets} all={item.tickets?.tickets ?? []} name={group.epic ? `Tickets under ${group.epic}` : 'Tickets under the epic'} now={now} />
            </div>
          ))}
        </div>
      ) : (
        <span className={s.quiet} role="status">
          {emptyWords(item, fetching)}
        </span>
      )}
    </Section>
  );
};
