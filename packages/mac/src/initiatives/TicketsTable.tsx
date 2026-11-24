import { activityOf } from '@beluga/ui/workspace-models.js';
import { CHECK_IN_CHAT, type InitiativeView, type Ticket, type TicketPr, initiativeChatChannel, ticketGroups } from '@beluga/core/initiatives/model.js';
import { Button } from '../components/ui.js';
import { useApp } from '../lib/beluga.js';
import { openExternal } from '../lib/system.js';
import { useClock } from '../lib/window-active.js';
import { ago } from '../tasks/tasks-model.js';
import { CATEGORY_LABEL, PR_STATE_LABEL, prName, ticketsWords } from './initiatives-model.js';
import { Section } from './InitiativeParts.js';
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

const TicketRow = ({ ticket, now }: { ticket: Ticket; now: number }) => {
  const url = ticket.url;
  const who = ticket.assignee ?? 'Unassigned';
  const when = whenOf(ticket.updated, now);
  return (
    <tr data-ticket={ticket.key} data-category={ticket.statusCategory}>
      <td className={s.ticketKey}>
        {url ? (
          <button type="button" className={s.ticketLink} onClick={() => void openExternal(url)} aria-label={`Open ${ticket.key} in Jira`}>
            {ticket.key}
          </button>
        ) : (
          ticket.key
        )}
      </td>
      <td className={s.ticketSummary}>
        {ticket.summary}
        <span className={s.ticketMeta}>
          <span>{[who, when].filter(Boolean).join(' · ')}</span>
          {ticket.prs.length ? <PrLinks prs={ticket.prs} /> : null}
        </span>
      </td>
      <td>
        <span className={s.status} data-category={ticket.statusCategory} title={CATEGORY_LABEL[ticket.statusCategory]}>
          {ticket.status || CATEGORY_LABEL[ticket.statusCategory]}
        </span>
      </td>
      <td className={s.ticketWide}>{who}</td>
      <td className={s.ticketWide}>{when}</td>
      <td className={s.ticketWide}>
        <PrLinks prs={ticket.prs} />
      </td>
    </tr>
  );
};

const Table = ({ tickets, caption, now }: { tickets: readonly Ticket[]; caption: string; now: number }) => (
  <table className={s.tickets}>
    <caption className={s.ticketsCaption}>{caption}</caption>
    <thead>
      <tr>
        <th scope="col">Key</th>
        <th scope="col">Summary</th>
        <th scope="col">Status</th>
        <th scope="col" className={s.ticketWide}>
          Assignee
        </th>
        <th scope="col" className={s.ticketWide}>
          Updated
        </th>
        <th scope="col" className={s.ticketWide}>
          Pull requests
        </th>
      </tr>
    </thead>
    <tbody>
      {tickets.map((ticket) => (
        <TicketRow key={ticket.key} ticket={ticket} now={now} />
      ))}
    </tbody>
  </table>
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
              {groups.length > 1 || group.epic ? <span className={s.epicName}>{group.epic ?? 'Other tickets'}</span> : null}
              <Table tickets={group.tickets} caption={group.epic ? `Tickets under ${group.epic}` : 'Tickets under the epic'} now={now} />
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
