import { useState } from 'react';
import { Icon } from '../components/Icon.js';
import { Badge, IconButton, cx } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useApp } from '../lib/beluga.js';
import { sameDeep } from '../lib/stable.js';
import { Row, Section } from '../layout/sidebar-parts.js';
import { type SidebarInitiative, isQuietInitiative, openSuggestionTotal, sidebarInitiatives } from './initiatives-sidebar.js';
import { NewInitiativeSheet } from './NewInitiativeSheet.js';
import sidebar from '../layout/Sidebar.module.css';
import s from './InitiativesSection.module.css';

type InitiativeRowProps = {
  readonly item: SidebarInitiative;
  readonly selected: boolean;
};

const InitiativeRow = ({ item, selected }: InitiativeRowProps) => {
  const actions = useActions();
  const handleOpen = (): void => actions.run({ type: 'view', view: { kind: 'initiative_page', slug: item.slug, chat: item.chat } });
  return (
    <Row
      icon={<Icon name="flag" size={14} />}
      label={item.name}
      detail={item.detail}
      selected={selected}
      onClick={handleOpen}
      aria-current={selected ? 'page' : undefined}
      className={cx(isQuietInitiative(item.status) && s.quiet)}
      data-initiative-row={item.slug}
      data-status={item.status}
      trailing={
        <>
          <span className={s.bar} aria-hidden="true">
            <span className={s.fill} data-part="done" style={{ width: `${item.done}%` }} />
            <span className={s.fill} data-part="inProgress" style={{ width: `${item.inProgress}%` }} />
          </span>
          <Badge count={item.asks} />
        </>
      }
    />
  );
};

export const InitiativesSection = () => {
  const actions = useActions();
  const enabled = useApp((st) => st.initiatives.enabled);
  const rows = useApp((st) => sidebarInitiatives(st.initiatives.items), sameDeep);
  const view = useApp((st) => st.view, sameDeep);
  const [making, setMaking] = useState(false);
  if (!enabled) return null;
  const openSlug = view.kind === 'initiative_page' ? view.slug : undefined;
  const asks = openSuggestionTotal(rows);
  const listOpen = view.kind === 'initiatives';
  const handleNew = (): void => setMaking(true);
  const handleClose = (): void => setMaking(false);
  const handleOpenList = (): void => actions.run({ type: 'view', view: { kind: 'initiatives' } });
  const rowOf = (item: SidebarInitiative) => <InitiativeRow key={item.slug} item={item} selected={item.slug === openSlug} />;
  return (
    <>
      <Section
        id="initiatives"
        title="Initiatives"
        badge={<Badge count={asks} />}
        keep={rows.filter((item) => item.slug === openSlug).map(rowOf)}
        action={<IconButton icon="plus" label="New Initiative" onClick={handleNew} />}
      >
        <Row
          icon={<Icon name="grid" size={14} />}
          label="All Initiatives"
          selected={listOpen}
          onClick={handleOpenList}
          aria-current={listOpen ? 'page' : undefined}
          data-initiatives-row=""
        />
        {rows.map(rowOf)}
        {rows.length ? null : <Row className={sidebar.hintRow} icon={<Icon name="plus" size={13} />} label="Drive a thing to ship" onClick={handleNew} />}
      </Section>
      {making ? <NewInitiativeSheet close={handleClose} /> : null}
    </>
  );
};
