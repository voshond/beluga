import { Icon } from '../components/Icon.js';
import { Badge } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useApp } from '../lib/beluga.js';
import { Row } from '../layout/sidebar-parts.js';
import { openSuggestions } from '@beluga/core/initiatives/model.js';
import { isInitiativeView, sidebarLine } from './initiatives-model.js';

export const InitiativesNav = () => {
  const actions = useActions();
  const enabled = useApp((st) => st.initiatives.enabled);
  const line = useApp((st) => sidebarLine(st.initiatives.items));
  const asks = useApp((st) => st.initiatives.items.filter((i) => i.status !== 'archived').reduce((n, i) => n + openSuggestions(i).length, 0));
  const selected = useApp((st) => isInitiativeView(st.view.kind));
  if (!enabled) return null;
  const handleClick = (): void => actions.run({ type: 'view', view: { kind: 'initiatives' } });
  return (
    <Row
      icon={<Icon name="flag" size={14} />}
      label="Initiatives"
      detail={line}
      selected={selected}
      onClick={handleClick}
      aria-current={selected ? 'page' : undefined}
      data-initiatives-row=""
      trailing={asks ? <Badge count={asks} /> : null}
    />
  );
};
