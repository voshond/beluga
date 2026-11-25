import { useState } from 'react';
import { CompactDetail, KindChip, ListItem, RecordDetail, StateBadge, TimelineDetail } from './LogParts.js';
import { MOCK_SUGGESTIONS, type MockSuggestion, historyOf, openOf } from './mock-suggestions.js';
import s from './variants.module.css';

export type LogVariant = 'all' | 'tabs' | 'timeline' | 'log';

type Tab = 'open' | 'history';

type GroupedList = { readonly title: string; readonly items: readonly MockSuggestion[] };

const findById = (id: number): MockSuggestion | undefined => MOCK_SUGGESTIONS.find((m) => m.id === id);

const TabsVersion = () => {
  const [tab, setTab] = useState<Tab>('open');
  const [selectedId, setSelectedId] = useState(14);
  const items = tab === 'open' ? openOf(MOCK_SUGGESTIONS) : historyOf(MOCK_SUGGESTIONS);
  const selected = findById(selectedId);
  const handleTab = (next: Tab): void => {
    setTab(next);
    const first = (next === 'open' ? openOf(MOCK_SUGGESTIONS) : historyOf(MOCK_SUGGESTIONS))[0];
    if (first) setSelectedId(first.id);
  };
  return (
    <div className={s.split}>
      <div className={s.listPane}>
        <div className={s.tabs} role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'open'} className={s.tab} onClick={() => handleTab('open')}>
            Open · {openOf(MOCK_SUGGESTIONS).length}
          </button>
          <button type="button" role="tab" aria-selected={tab === 'history'} className={s.tab} onClick={() => handleTab('history')}>
            History · {historyOf(MOCK_SUGGESTIONS).length}
          </button>
        </div>
        <div role="listbox" aria-label="Suggestions">
          {items.map((m) => (
            <ListItem key={m.id} suggestion={m} selected={m.id === selectedId} onSelect={setSelectedId} />
          ))}
        </div>
      </div>
      {selected ? <CompactDetail suggestion={selected} /> : null}
    </div>
  );
};

const GROUPS: readonly GroupedList[] = [
  { title: 'Needs you', items: openOf(MOCK_SUGGESTIONS) },
  { title: 'This week', items: historyOf(MOCK_SUGGESTIONS).filter((m) => (m.resolvedAt ?? '') >= '2026-11-23') },
  { title: 'Earlier', items: historyOf(MOCK_SUGGESTIONS).filter((m) => (m.resolvedAt ?? '') < '2026-11-23') },
];

const TimelineVersion = () => {
  const [selectedId, setSelectedId] = useState(9);
  const selected = findById(selectedId);
  return (
    <div className={s.split}>
      <div className={s.listPane} role="listbox" aria-label="Suggestions and decisions">
        {GROUPS.map((g) => (
          <div key={g.title}>
            <span className={s.groupTitle}>
              {g.title} · {g.items.length}
            </span>
            {g.items.map((m) => (
              <ListItem key={m.id} suggestion={m} selected={m.id === selectedId} onSelect={setSelectedId} />
            ))}
          </div>
        ))}
      </div>
      {selected ? <TimelineDetail suggestion={selected} /> : null}
    </div>
  );
};

const LogVersion = () => {
  const [selectedId, setSelectedId] = useState(11);
  const selected = findById(selectedId);
  return (
    <div className={s.logLayout}>
      <div className={s.logMain}>
        <span className={s.groupTitle}>Needs you · {openOf(MOCK_SUGGESTIONS).length}</span>
        <div role="listbox" aria-label="Open suggestions" className={s.openStack}>
          {openOf(MOCK_SUGGESTIONS).map((m) => (
            <ListItem key={m.id} suggestion={m} selected={m.id === selectedId} onSelect={setSelectedId} />
          ))}
        </div>
        <span className={s.groupTitle}>Decision log</span>
        <table className={s.table}>
          <thead>
            <tr>
              <th>Date</th>
              <th>Decision</th>
              <th>Result</th>
              <th>Proof</th>
            </tr>
          </thead>
          <tbody>
            {historyOf(MOCK_SUGGESTIONS).map((m) => (
              <tr key={m.id} aria-selected={m.id === selectedId} onClick={() => setSelectedId(m.id)} tabIndex={0}>
                <td className={s.itemDate}>{m.resolvedAt?.slice(5, 10)}</td>
                <td>
                  <KindChip suggestion={m} /> {m.headline}
                </td>
                <td>
                  <StateBadge suggestion={m} />
                </td>
                <td className={s.quiet}>{m.proof.length || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {selected ? <RecordDetail suggestion={selected} /> : null}
    </div>
  );
};

const VERSIONS = {
  tabs: { title: 'E · Tabs: Open / History, compact detail', render: () => <TabsVersion /> },
  timeline: { title: 'F · Timeline: one grouped list, lifecycle and proof on the right', render: () => <TimelineVersion /> },
  log: { title: 'G · Decision log: open stack plus history table, record written like a doc', render: () => <LogVersion /> },
} as const;

const DecisionLogVariants = ({ variant = 'all' }: { variant?: LogVariant }) => {
  const keys = variant === 'all' ? (Object.keys(VERSIONS) as Array<keyof typeof VERSIONS>) : [variant];
  return (
    <div className={s.gallery}>
      {keys.map((key) => (
        <section key={key} className={s.variant}>
          <span className={s.variantTitle}>{VERSIONS[key].title}</span>
          {VERSIONS[key].render()}
        </section>
      ))}
    </div>
  );
};

export default DecisionLogVariants;
