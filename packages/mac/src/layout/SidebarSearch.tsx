import { useEffect, useMemo, useRef, useState } from 'react';
import { snippet } from '@beluga/core/search.js';
import { Icon } from '../components/Icon.js';
import { IconButton, cx } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useApi, useApp, useBeluga } from '../lib/beluga.js';
import { shortcutKeys } from '../lib/shortcuts.js';
import { sameDeep } from '../lib/stable.js';
import { type ChatTarget, FOCUS_SIDEBAR_SEARCH, MESSAGE_SEARCH_DEBOUNCE_MS, type SidebarResult, matchChats, moveSelection, searchesMessages, sidebarResults } from './sidebar-search-model.js';
import s from './SidebarSearch.module.css';

/**
 * The field at the top of the sidebar: finds a conversation by name, branch, PR or project at once,
 * and a message (through the same search as the Search page). While it has a query its results take
 * the place of `children`, which stay mounted, so their folds and scroll come back as they were.
 */
export function SidebarSearch({ children }: { children: React.ReactNode }) {
  const api = useApi();
  const actions = useActions();
  const { ui } = useBeluga();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const q = query.trim();
  const sources = useApp((st) => (q ? { projects: st.projects, plans: st.plans, shared: st.shared, prs: st.prs } : undefined), sameDeep);
  const search = useApp((st) => (q ? st.search : undefined));
  const results = useMemo(() => (sources && search ? sidebarResults(q, matchChats(q, sources), search) : []), [q, sources, search]);
  const looking = searchesMessages(q) && search?.query !== q;

  useEffect(() => {
    const focus = (): void => input.current?.select();
    document.addEventListener(FOCUS_SIDEBAR_SEARCH, focus);
    return () => document.removeEventListener(FOCUS_SIDEBAR_SEARCH, focus);
  }, []);
  useEffect(() => {
    if (!searchesMessages(q)) return;
    const t = setTimeout(() => {
      void api.workbench.search(q);
      ui.patch({ searchQuery: q });
    }, MESSAGE_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q, api, ui]);
  useEffect(() => setSelected(0), [q]);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const clear = (): void => setQuery('');
  const openChat = (target: ChatTarget): void => {
    if (target.kind === 'workspace') actions.run({ type: 'open_ws', id: target.id });
    else if (target.kind === 'shared') actions.run({ type: 'open_shared', owner: target.owner, id: target.id, tab: 'chat' });
    else actions.run({ type: 'view', view: { kind: 'plan', id: target.id } });
  };
  const seeAll = (): void => {
    ui.patch({ searchQuery: q });
    actions.run({ type: 'view', view: { kind: 'search' } });
  };
  const open = (result: SidebarResult): void => {
    if (result.type === 'chat') openChat(result.chat.target);
    else if (result.type === 'message') actions.run({ type: 'search_hit', index: result.index });
    else seeAll();
  };

  return (
    <>
      <div className={s.field}>
        <Icon name="search" size={13} className={s.fieldIcon} />
        <input
          ref={input}
          className={cx(s.input, 'selectable')}
          value={query}
          placeholder="Search chats and messages"
          aria-label="Search chats and messages"
          title={shortcutKeys('sidebar-search')}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              setSelected((at) => moveSelection(at, results.length, e.key === 'ArrowDown' ? 1 : -1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              const result = results[selected];
              if (result) open(result);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              if (query) clear();
              else input.current?.blur();
            }
          }}
        />
        {query ? <IconButton icon="x" label="Clear search" className={s.clear} onClick={clear} /> : null}
      </div>
      {q ? <Results list={list} results={results} selected={selected} looking={looking} open={open} /> : null}
      <div className={q ? s.kept : s.shown}>{children}</div>
    </>
  );
}

function Results({ list, results, selected, looking, open }: { list: React.RefObject<HTMLDivElement | null>; results: readonly SidebarResult[]; selected: number; looking: boolean; open: (result: SidebarResult) => void }) {
  const firstMessage = results.findIndex((r) => r.type === 'message');
  const onlyAll = results.length === 1;
  return (
    <div ref={list} className={s.results} role="listbox" aria-label="Search results">
      {onlyAll && !looking ? <div className={s.note}>No chats match.</div> : null}
      {results.map((r, i) => (
        <div key={r.key}>
          {i === firstMessage ? <div className={s.heading}>Messages</div> : null}
          {r.type === 'all' && looking ? <div className={s.note}>Searching messages…</div> : null}
          <div role="option" aria-selected={i === selected} className={cx(s.result, i === selected && s.resultOn)} onClick={() => open(r)}>
            {r.type === 'chat' ? <ChatResult label={r.chat.label} detail={r.chat.detail} /> : r.type === 'message' ? <MessageResult result={r} /> : <span className={s.all}>See All in Search</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

function ChatResult({ label, detail }: { label: string; detail: string }) {
  return (
    <>
      <span className={s.line}>{label}</span>
      {detail ? <span className={s.detail}>{detail}</span> : null}
    </>
  );
}

function MessageResult({ result }: { result: Extract<SidebarResult, { type: 'message' }> }) {
  const { before, match, after } = snippet(result.hit, 80);
  return (
    <>
      <span className={s.detail}>{result.hit.place}</span>
      <span className={s.excerpt}>
        {before}
        <mark>{match}</mark>
        {after}
      </span>
    </>
  );
}
