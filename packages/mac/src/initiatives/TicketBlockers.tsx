import { type Blocker, blockersOf } from '@beluga/core/initiatives/risks.js';
import { type EpicTickets, type Ticket, ticketUrlOf } from '@beluga/core/initiatives/model.js';
import { Icon } from '../components/Icon.js';
import { openExternal } from '../lib/system.js';
import { CATEGORY_LABEL } from './initiatives-model.js';
import s from './initiatives.module.css';

const blockerWords = (blocker: Blocker): string => `Blocked by ${blocker.key}${blocker.outside ? ' (outside the initiative)' : ''}: ${blocker.status || CATEGORY_LABEL[blocker.statusCategory]}`;

const BlockerChip = ({ blocker, tickets }: { blocker: Blocker; tickets: EpicTickets }) => {
  const url = blocker.url ?? ticketUrlOf(blocker.key, tickets);
  const handleOpen = (): void => {
    if (url) void openExternal(url);
  };
  return (
    <button type="button" className={s.blocker} data-blocker={blocker.key} data-outside={blocker.outside} data-category={blocker.statusCategory} onClick={handleOpen} disabled={!url} title={blocker.summary ?? blocker.key} aria-label={blockerWords(blocker)}>
      <Icon name="alert" size={11} />
      {blocker.key}
      <span className={s.blockerState}>{blocker.status || CATEGORY_LABEL[blocker.statusCategory]}</span>
    </button>
  );
};

/** What blocks a ticket, each blocker with its status; one outside the epics is marked. */
export const TicketBlockers = ({ ticket, tickets }: { ticket: Ticket; tickets: EpicTickets }) => {
  const blockers = blockersOf(ticket, tickets.tickets);
  if (!blockers.length) return null;
  return (
    <span className={s.blockers}>
      {blockers.map((blocker) => (
        <BlockerChip key={blocker.key} blocker={blocker} tickets={tickets} />
      ))}
    </span>
  );
};
