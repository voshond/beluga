import { useMemo, useState } from 'react';
import { type MetricRef, type StepRef, metricOf } from '@beluga/core/sentinel/dashboard-model.js';
import type { Args } from '@beluga/ipc/api.js';
import { FormSheet, TextInput } from '../components/FormSheet.js';
import { Icon, type IconName } from '../components/Icon.js';
import { cx } from '../components/ui.js';
import { useApi, useApp } from '../lib/beluga.js';
import { MetricChart, NumberTile, RowsTable, SeriesChart } from './NumberParts.js';
import { LOOK_WORDS, NEW_SOURCES, type NewSourceId, TILE_SIZES, type TileLook, type TileSizeId, looksFor, metricChoices, newSourceAsk, numberWords, sizeFor, stepChoices } from './numbers-model.js';
import { useSentinelActions, useSentinelState } from './use-sentinel.js';
import n from './numbers.module.css';
import x from './add-tile.module.css';
import { ASSISTANT_TITLE } from '@beluga/shared/assistant.js';

/**
 * Add to the board (BLG-308). One box on top: say what you want to see and your Claude puts it
 * together (setting up a draft sentinel that fetches it when none does yet). Or pick it below. On the
 * left, what your sentinels already keep (numbers with their value now, kept arrays and rows, what a
 * step said last, a sentinel's report) and somewhere new (GitHub, a database, a URL, a
 * script: Claude sets up the fetching for you). On the right, how to show it as pictures, its size as
 * shapes, a title, and the tile as it will look. A tile names a sentinel and what it keeps, never its source.
 */

type Pick =
  | { readonly kind: 'metric'; readonly ref: MetricRef }
  | { readonly kind: 'step'; readonly ref: StepRef; readonly label: string }
  | { readonly kind: 'report'; readonly sentinelId: string; readonly label: string }
  | { readonly kind: 'heading' }
  | { readonly kind: 'new'; readonly source: NewSourceId };

export function AddTileSheet({ dashboardId, close }: { dashboardId: string; close: () => void }) {
  const api = useApi();
  const a = useSentinelActions();
  const state = useSentinelState();
  const projects = useApp((st) => st.projects);
  const d = state.dashboards?.find((b) => b.id === dashboardId);
  const [words, setWords] = useState('');
  const [pick, setPick] = useState<Pick>();
  const [look, setLook] = useState<TileLook>('number');
  const [size, setSize] = useState<TileSizeId>('small');
  const [title, setTitle] = useState('');
  const [what, setWhat] = useState('');
  const projectName = (id: string | undefined): string => projects.find((p) => p.id === id)?.name ?? ASSISTANT_TITLE;
  const metrics = useMemo(() => metricChoices(state, projectName, d), [state, projects, d]);
  const steps = useMemo(() => stepChoices(state, projectName), [state.items, projects]);
  // Everything kept, by project and sentinel, as the list shows them.
  const groups = useMemo(() => {
    const out = new Map<string, { head: string; items: Array<{ pick: Pick; label: string; hint?: string; value?: string; icon: IconName; on?: boolean }> }>();
    const add = (head: string, item: { pick: Pick; label: string; hint?: string; value?: string; icon: IconName; on?: boolean }): void => {
      const g = out.get(head) ?? { head, items: [] };
      g.items.push(item);
      out.set(head, g);
    };
    for (const c of metrics) add(`${c.project} · ${c.sentinel}`, { pick: { kind: 'metric', ref: c.ref }, label: c.label, ...(c.value ? { value: c.value } : {}), icon: c.kind === 'rows' ? 'table' : c.kind === 'output' ? 'file' : 'chartLine', ...(c.onIt ? { on: true, hint: 'on this board' } : {}) });
    for (const c of steps) add(`${c.project} · ${c.sentinel}`, { pick: { kind: 'step', ref: c.ref, label: c.label }, label: c.label, hint: c.kind === 'claude' ? 'what the agent wrote' : c.kind === 'http' ? 'the service’s answer' : 'what it printed', icon: c.kind === 'claude' ? 'claude' : c.kind === 'http' ? 'globe' : 'terminal' });
    // What each sentinel said last, together at the end (one line each, not under every sentinel).
    type Item = { pick: Pick; label: string; hint?: string; value?: string; icon: IconName; on?: boolean };
    const said: Item[] = state.items.map((i) => ({ pick: { kind: 'report', sentinelId: i.id, label: i.name }, label: i.name, hint: `${projectName(i.projectId)} · its latest report`, icon: 'file' }));
    return [...out.values(), ...(said.length ? [{ head: 'What a sentinel said last', items: said }] : [])];
  }, [metrics, steps, state.items, projects]);

  const keyOf = (p: Pick | undefined): string => (!p ? '' : p.kind === 'metric' ? `m:${p.ref.sentinelId}/${p.ref.metric}` : p.kind === 'step' ? `s:${p.ref.sentinelId}/${p.ref.stepId}` : p.kind === 'report' ? `r:${p.sentinelId}` : p.kind === 'new' ? `n:${p.source}` : 'h');
  const metric = pick?.kind === 'metric' ? metricOf(state, pick.ref) : undefined;
  const looks: readonly TileLook[] = pick?.kind === 'metric' ? looksFor(metric?.kind ?? 'number') : pick?.kind === 'step' || pick?.kind === 'report' ? ['text'] : [];
  const choose = (p: Pick): void => {
    setPick(p);
    setWords('');
    const first = p.kind === 'metric' ? looksFor(metricOf(state, p.ref)?.kind ?? 'number')[0]! : 'text';
    setLook(first);
    setSize(sizeFor(first));
  };
  const shape = TILE_SIZES.find((t) => t.id === size)!;
  const own = { ...(title.trim() ? { title: title.trim() } : {}), width: shape.w, ...(shape.h === 2 ? { height: 2 as const } : {}) };

  const describing = Boolean(words.trim()) || pick?.kind === 'new';
  const ready = words.trim() ? true : pick?.kind === 'new' ? Boolean(what.trim()) : pick?.kind === 'heading' ? Boolean(title.trim()) : Boolean(pick);
  const submit = async (): Promise<string | void> => {
    // Words (or somewhere new): your Claude builds it, and sets up the fetching when nothing does yet.
    if (describing) {
      const said = pick?.kind === 'new' && !words.trim() ? newSourceAsk(pick.source, what) : words.trim();
      const went = await a.act(() => api.dashboard.ask(dashboardId, said));
      if (!went) return 'Couldn’t ask your agent: see the message above';
      return close();
    }
    if (!pick) return;
    const tile: Args<'dashboard.addTile'>[1] =
      pick.kind === 'heading'
        ? { kind: 'divider', title: title.trim() }
        : pick.kind === 'report'
          ? { kind: 'text', sentinelId: pick.sentinelId, text: 'report', ...own }
          : pick.kind === 'step'
            ? { kind: 'output', step: pick.ref, ...own }
            : pick.kind === 'metric'
              ? look === 'number'
                ? { kind: 'number', metric: pick.ref, ...own }
                : look === 'table'
                  ? { kind: 'table', metric: pick.ref, ...own }
                  : look === 'text'
                    ? { kind: 'output', metric: pick.ref, ...own }
                    : { kind: 'series', ...(metric?.kind === 'series' ? { metric: pick.ref } : { metrics: [pick.ref] }), chart: look === 'bars' ? 'bar' : 'line', ...own }
              : { kind: 'divider', title: title.trim() };
    const done = await a.act(() => api.dashboard.addTile(dashboardId, tile));
    if (!done) return 'Couldn’t add it: see the message above';
    close();
  };

  const newSource = pick?.kind === 'new' ? NEW_SOURCES.find((s) => s.id === pick.source) : undefined;
  return (
    <FormSheet title={`Add to ${d?.name ?? 'the board'}`} icon="gauge" submitLabel={describing ? 'Ask Your Agent' : `Add to ${d?.name ?? 'the Board'}`} canSubmit={ready} width={880} onCancel={close} onSubmit={submit}>
      <div className={x.sheet}>
        <textarea
          className={x.describe}
          value={words}
          rows={1}
          placeholder="Say what you want to see, or pick it below: “revenue per day”, “open pull requests”, “this morning’s brief”…"
          aria-label="What should it show?"
          data-autofocus
          onChange={(e) => setWords(e.target.value)}
        />
        <div className={x.panes} data-dim={words.trim() ? '' : undefined}>
          <div className={x.list} role="listbox" aria-label="What to show">
            <div className={x.group}>Already kept</div>
            {groups.length ? (
              groups.map((g) => (
                <div key={g.head} role="group" aria-label={g.head}>
                  <div className={x.sub}>{g.head}</div>
                  {g.items.map((it) => (
                    <button key={keyOf(it.pick)} type="button" role="option" aria-selected={keyOf(pick) === keyOf(it.pick)} className={x.item} onClick={() => choose(it.pick)} data-pick={keyOf(it.pick)}>
                      <Icon name={it.icon} size={13} />
                      <span className={x.itemText}>
                        {it.label}
                        {it.hint ? <small>{it.hint}</small> : null}
                      </span>
                      {it.value ? <span className={x.value}>{it.value}</span> : null}
                    </button>
                  ))}
                </div>
              ))
            ) : (
              <p className={x.quiet}>Nothing is kept yet. Pick somewhere new, or say what you want above.</p>
            )}
            <div className={x.group}>From somewhere new</div>
            {NEW_SOURCES.map((src) => (
              <button key={src.id} type="button" role="option" aria-selected={keyOf(pick) === `n:${src.id}`} className={x.item} onClick={() => (setPick({ kind: 'new', source: src.id }), setWhat(''))} data-source={src.id}>
                <span className={x.mark} data-source={src.id}>
                  <Icon name={src.id === 'github' ? 'pr' : src.id === 'database' ? 'table' : src.id === 'url' ? 'globe' : 'terminal'} size={11} />
                </span>
                <span className={x.itemText}>{src.label}</span>
                <span className={x.value}>{src.hint}</span>
              </button>
            ))}
            <div className={x.group}>Other</div>
            <button type="button" role="option" aria-selected={pick?.kind === 'heading'} className={x.item} onClick={() => (setPick({ kind: 'heading' }), setWords(''))}>
              <Icon name="minus" size={13} />
              <span className={x.itemText}>A heading across the board</span>
            </button>
          </div>

          <div className={x.right}>
            {words.trim() ? (
              <p className={x.quiet}>Your agent puts it together from what your sentinels keep. When nothing fetches it yet, it sets up a sentinel that does: a draft you look over and turn on first.</p>
            ) : !pick ? (
              <p className={x.quiet}>Pick something on the left to see how it can look.</p>
            ) : newSource ? (
              <>
                <div className={x.k}>What from {newSource.label}?</div>
                <div className={x.field}><TextInput value={what} onChange={setWhat} maxLength={400} placeholder={newSource.ideas[0]} aria-label={`What from ${newSource.label}?`} /></div>
                <div className={x.ideas}>
                  {newSource.ideas.map((idea) => (
                    <button key={idea} type="button" className={x.idea} onClick={() => setWhat(idea)}>
                      {idea}
                    </button>
                  ))}
                </div>
                <p className={x.quiet}>Your agent sets up the sentinel that fetches it (paused, for you to turn on) with your project’s own keys, and adds its tile here.</p>
              </>
            ) : pick.kind === 'heading' ? (
              <>
                <div className={x.k}>Heading</div>
                <div className={x.field}><TextInput value={title} onChange={setTitle} maxLength={80} placeholder="Money" aria-label="Heading" /></div>
              </>
            ) : (
              <>
                <div className={x.k}>Show it as</div>
                <div className={x.looks} role="radiogroup" aria-label="Show it as">
                  {looks.map((l) => (
                    <button key={l} type="button" role="radio" aria-checked={look === l} className={x.look} onClick={() => (setLook(l), setSize(sizeFor(l)))}>
                      <LookPicture look={l} />
                      <span>{LOOK_WORDS[l]}</span>
                    </button>
                  ))}
                </div>
                <div className={x.k}>Size</div>
                <div className={x.sizes} role="radiogroup" aria-label="Size">
                  {TILE_SIZES.map((t) => (
                    <button key={t.id} type="button" role="radio" aria-checked={size === t.id} className={x.size} onClick={() => setSize(t.id)}>
                      <span className={x.shape} style={{ width: t.w * 18 + (t.w - 1) * 3, height: t.h * 18 + (t.h - 1) * 3 }} />
                      <span>{t.label}</span>
                    </button>
                  ))}
                </div>
                <div className={x.k}>Title</div>
                <div className={x.field}><TextInput value={title} onChange={setTitle} maxLength={80} placeholder={pick.kind === 'metric' ? (metric?.label ?? 'Its label') : pick.kind === 'step' || pick.kind === 'report' ? pick.label : ''} aria-label="Title" /></div>
                <div className={x.k}>Preview</div>
                <Preview pick={pick} look={look} title={title} wide={shape.w > 1} />
                <p className={x.quiet}>Drag it into place on the board afterwards; drag its corner to resize.</p>
              </>
            )}
          </div>
        </div>
      </div>
    </FormSheet>
  );
}

/** A small picture of each look (the shape, not real data). */
function LookPicture({ look }: { look: TileLook }) {
  if (look === 'number')
    return (
      <svg width="56" height="26" aria-hidden="true">
        <text x="0" y="19" fontSize="15" fontWeight="600" fill="currentColor">
          3.4k
        </text>
        <polyline fill="none" stroke="var(--ok)" strokeWidth="1.5" points="38,20 44,14 50,16 56,7" />
      </svg>
    );
  if (look === 'line')
    return (
      <svg width="56" height="26" aria-hidden="true">
        <polyline fill="none" stroke="var(--accent)" strokeWidth="1.5" points="0,22 9,16 18,18 28,9 37,13 46,5 56,7" />
      </svg>
    );
  if (look === 'bars')
    return (
      <svg width="56" height="26" aria-hidden="true">
        <g fill="var(--accent)">
          <rect x="2" y="14" width="7" height="12" rx="1" />
          <rect x="13" y="8" width="7" height="18" rx="1" />
          <rect x="24" y="12" width="7" height="14" rx="1" />
          <rect x="35" y="3" width="7" height="23" rx="1" />
          <rect x="46" y="10" width="7" height="16" rx="1" />
        </g>
      </svg>
    );
  if (look === 'table')
    return (
      <svg width="56" height="26" aria-hidden="true">
        <g stroke="var(--hairline-strong)">
          <line x1="0" y1="6" x2="56" y2="6" />
          <line x1="0" y1="13" x2="56" y2="13" />
          <line x1="0" y1="20" x2="56" y2="20" />
          <line x1="20" y1="2" x2="20" y2="24" />
        </g>
      </svg>
    );
  return (
    <svg width="56" height="26" aria-hidden="true">
      <g stroke="var(--hairline-strong)" strokeWidth="2" strokeLinecap="round">
        <line x1="2" y1="6" x2="50" y2="6" />
        <line x1="2" y1="13" x2="54" y2="13" />
        <line x1="2" y1="20" x2="36" y2="20" />
      </g>
    </svg>
  );
}

function Preview({ pick, look, title, wide }: { pick: Pick; look: TileLook; title: string; wide: boolean }) {
  const state = useSentinelState();
  if (pick.kind !== 'metric') return <div className={cx(n.previewTile, x.previewText)}>{pick.kind === 'step' || pick.kind === 'report' ? 'Shows what it said last, and updates each time it runs.' : null}</div>;
  const m = metricOf(state, pick.ref);
  if (!m) return null;
  return (
    <div className={cx(n.previewTile, x.preview)} data-testid="tile-preview" data-wide={wide || undefined}>
      {look === 'number' ? (
        <NumberTile w={numberWords(m, 'previous', title.trim() || m.label)} />
      ) : look === 'table' ? (
        m.rows ? <RowsTable metric={m} pageSize={4} /> : null
      ) : m.kind === 'series' ? (
        <SeriesChart metric={m} kind={look === 'bars' ? 'bar' : 'line'} height={150} />
      ) : (
        <MetricChart series={[m]} kind={look === 'bars' ? 'bar' : 'line'} height={150} />
      )}
    </div>
  );
}
