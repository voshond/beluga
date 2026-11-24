import { type InitiativeView, type MeetingRef, type SlackRef, linkOf, meetingKindOf, slackKindOf } from '@beluga/core/initiatives/model.js';
import { Icon, type IconName } from '../components/Icon.js';
import { openExternal } from '../lib/system.js';
import { Section } from './InitiativeParts.js';
import s from './initiatives.module.css';

const SLACK_KIND: Readonly<Record<ReturnType<typeof slackKindOf>, string>> = { channel: 'Channel', thread: 'Thread', conversation: 'Conversation' };

const MEETING_KIND: Readonly<Record<ReturnType<typeof meetingKindOf>, string>> = { event: 'One event', title: 'Title has' };

type FollowRowProps = {
  readonly icon: IconName;
  readonly kind: string;
  readonly name: string;
  readonly detail?: string;
  readonly link?: string;
  readonly opens: string;
};

const FollowRow = ({ icon, kind, name, detail, link, opens }: FollowRowProps) => (
  <li className={s.follow}>
    <Icon name={icon} size={12} />
    <span className={s.followKind}>{kind}</span>
    {link ? (
      <button type="button" className={s.ticketLink} onClick={() => void openExternal(link)} aria-label={`Open ${name} in ${opens}`}>
        {name}
      </button>
    ) : (
      <span className={s.followName}>{name}</span>
    )}
    {detail ? <span className={s.followDetail}>{detail}</span> : null}
  </li>
);

const SlackRow = ({ entry }: { entry: SlackRef }) => {
  const link = linkOf(entry.ref);
  return <FollowRow icon="chat" kind={SLACK_KIND[slackKindOf(entry.ref)]} name={entry.label ?? entry.ref} {...(entry.label ? { detail: entry.ref } : {})} {...(link ? { link } : {})} opens="Slack" />;
};

const MeetingRow = ({ entry }: { entry: MeetingRef }) => {
  const link = linkOf(entry.match);
  const kind = meetingKindOf(entry.match);
  const name = entry.label ?? (kind === 'title' ? `“${entry.match}”` : entry.match);
  const detail = entry.label ? (kind === 'title' ? `“${entry.match}”` : entry.match) : undefined;
  return <FollowRow icon="calendar" kind={MEETING_KIND[kind]} name={name} {...(detail ? { detail } : {})} {...(link ? { link } : {})} opens="the calendar" />;
};

export const Follows = ({ item }: { item: InitiativeView }) => (
  <>
    {item.slack.length ? (
      <Section title="Slack conversations">
        <ul className={s.follows}>
          {item.slack.map((entry) => (
            <SlackRow key={entry.ref} entry={entry} />
          ))}
        </ul>
      </Section>
    ) : null}
    {item.meetings.length ? (
      <Section title="Meetings">
        <ul className={s.follows}>
          {item.meetings.map((entry) => (
            <MeetingRow key={entry.match} entry={entry} />
          ))}
        </ul>
      </Section>
    ) : null}
  </>
);
