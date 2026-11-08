import { useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon.js';
import { Empty, cx } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { ActionsContext } from '../components/SpecMenu.js';
import { copyText } from '../lib/copy.js';
import { useApi, useApp, useBeluga, useUi } from '../lib/beluga.js';
import s from './lists.module.css';

/** Search every conversation (yours and the ones shared with you), and jump to a result. */
export function SearchView() {
  const api = useApi();
  const actions = useActions();
  const { client, ui } = useBeluga();
  const from = useUi((u) => u.searchQuery);
  const search = useApp((st) => st.search);
  const [query, setQuery] = useState(search.query);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);
  // Arrow keys move the selection; keep it in view.
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [search.cursor]);
  // The sidebar's field searches too: both show the same hits, so this box takes up its query.
  useEffect(() => {
    if (from === undefined) return;
    setQuery(from);
    ui.patch({ searchQuery: undefined });
  }, [from, ui]);
  useEffect(() => {
    const t = setTimeout(() => void api.workbench.search(query), 120);
    return () => clearTimeout(t);
  }, [query]);
  const open = (i: number): void => {
    client.store.dispatch({ type: 'search_cursor', cursor: i });
    actions.run({ type: 'search_hit', index: i });
  };
  return (
    <div className={s.page}>
      <div className={s.searchBox}>
        <Icon name="search" size={15} />
        <input
          ref={input}
          className="selectable"
          value={query}
          placeholder="Search every conversation"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              client.store.dispatch({ type: 'search_cursor', cursor: search.cursor + (e.key === 'ArrowDown' ? 1 : -1) });
            } else if (e.key === 'Enter' && search.hits.length) open(search.cursor);
          }}
        />
        {search.query ? <span className={s.dim}>{search.hits.length} in {search.searched} conversations</span> : null}
      </div>
      {!query.trim() ? (
        <Empty icon="search" title="Find anything anyone said" detail="Every conversation: the room, your workspaces (archived ones too), and workspaces shared with you." />
      ) : !search.hits.length ? (
        <Empty icon="search" title="No matches" detail={`Nothing says “${query}”.`} />
      ) : (
        <div ref={list} className={s.list} role="listbox">
          {search.hits.map((h, i) => (
            <ActionsContext
              key={`${h.channel}:${h.ts}:${i}`}
              items={[
                { label: 'Open Conversation', icon: 'chat', onSelect: () => open(i) },
                { label: 'Copy Message', icon: 'copy', separate: true, onSelect: () => void copyText(h.text).then(() => client.store.dispatch({ type: 'toast', text: 'Copied the message', level: 'success' })) },
              ]}
            >
            <div role="option" aria-selected={i === search.cursor} className={cx(s.hit, i === search.cursor && s.hitOn)} onClick={() => open(i)}>
              <div className={s.hitHead}>
                <span className={s.place}>{h.place}</span>
                {h.archived ? <span className={s.dim}>archived</span> : null}
                <span className={s.dim}>{h.who}</span>
                <span className={s.when}>{new Date(h.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
              </div>
              <div className={`${s.snippet} selectable`}>
                {h.text.slice(Math.max(0, h.at - 60), h.at)}
                <mark>{h.text.slice(h.at, h.at + search.query.length)}</mark>
                {h.text.slice(h.at + search.query.length, h.at + search.query.length + 140)}
              </div>
            </div>
            </ActionsContext>
          ))}
        </div>
      )}
    </div>
  );
}
