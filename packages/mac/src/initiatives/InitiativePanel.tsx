import type { InitiativeView, Suggestion } from '@beluga/core/initiatives/model.js';
import { Icon } from '../components/Icon.js';
import { IconButton } from '../components/ui.js';
import { ResizeHandle } from '../layout/panel/ResizeHandle.js';
import { useDockWidth } from '../layout/panel/use-dock-width.js';
import { InitiativeChat } from './InitiativeChat.js';
import { SuggestionRecord, kindLabel } from './SuggestionRecord.js';
import home from '../sentinel/home.module.css';
import s from './initiatives.module.css';

export type PanelTab = 'chat' | 'record';

type PanelProps = {
  readonly item: InitiativeView;
  readonly picked: Suggestion | undefined;
  readonly tab: PanelTab;
  readonly onTab: (tab: PanelTab) => void;
  readonly onClose: () => void;
};

export const InitiativePanel = ({ item, picked, tab, onTab, onClose }: PanelProps) => {
  const dock = useDockWidth('initiatives.chat.width', 400);
  const shown: PanelTab = picked ? tab : 'chat';
  const handleChat = (): void => onTab('chat');
  const handleRecord = (): void => onTab('record');
  return (
    <aside ref={dock.ref} className={home.panel} style={{ width: dock.width }} aria-label={`${item.name} panel`}>
      <ResizeHandle label={`Resize ${item.name} panel`} className={home.panelEdge} {...dock.handle} />
      <div className={home.panelInner} style={{ width: dock.width }}>
        <div className={s.panelTabs} role="tablist" aria-label={`${item.name} panel`}>
          <button type="button" role="tab" aria-selected={shown === 'chat'} className={s.panelTab} onClick={handleChat}>
            <Icon name="chat" size={12} />
            Chat
          </button>
          {picked ? (
            <span className={s.panelTabWrap} data-on={shown === 'record'}>
              <button type="button" role="tab" aria-selected={shown === 'record'} className={s.panelTab} onClick={handleRecord}>
                {kindLabel(picked)} #{picked.id}
              </button>
              <IconButton size="small" icon="x" label={`Close suggestion ${picked.id}`} onClick={onClose} />
            </span>
          ) : null}
        </div>
        <div className={s.panelPane} data-shown={shown === 'chat'}>
          <InitiativeChat item={item} />
        </div>
        {picked && shown === 'record' ? (
          <div className={s.panelPane} data-pane="record" data-shown>
            <SuggestionRecord item={item} suggestion={picked} onChat={handleChat} />
          </div>
        ) : null}
      </div>
    </aside>
  );
};
