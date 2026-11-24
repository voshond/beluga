import { useEffect, useState } from 'react';
import { type MemoryEntry, type MemoryOverview, type MemoryScope, type MemoryView, alwaysEntries, filedEntries, tidyWords } from '@beluga/shared/memory.js';
import { Button } from '../../components/ui.js';
import { toast, useBeluga } from '../../lib/beluga.js';
import { Group, Row, Select } from '../settings-controls.js';
import { MemoryEntryRow } from './MemoryEntryRow.js';
import a from './agent-setup.module.css';

const USER_KEY = 'user';

const keyOf = (scope: MemoryScope): string => (scope.kind === 'user' ? USER_KEY : scope.root);

const errorText = (err: Error | string): string => (typeof err === 'string' ? err : err.message);

export const MemorySettings = () => {
  const { client } = useBeluga();
  const [memory, setMemory] = useState<MemoryOverview>();
  const [picked, setPicked] = useState(USER_KEY);
  const [draft, setDraft] = useState('');
  const [tidying, setTidying] = useState(false);

  const load = async () => setMemory(await client.api.memory.list());

  useEffect(() => {
    void load();
  }, []);

  const views: readonly MemoryView[] = memory ? [memory.user, ...memory.projects] : [];
  const current = views.find((v) => keyOf(v.scope) === picked) ?? memory?.user;
  const options = views.map((v) => ({ value: keyOf(v.scope), label: v.entries.length ? `${v.label} (${v.entries.length})` : v.label }));

  const handleChange = async (change: () => Promise<MemoryView>): Promise<boolean> => {
    try {
      await change();
      await load();
      return true;
    } catch (err) {
      toast(client, errorText(err as Error), 'error');
      return false;
    }
  };

  const handleAdd = async () => {
    if (!current || !draft.trim()) return;
    if (await handleChange(() => client.api.memory.add(current.scope, draft))) setDraft('');
  };

  const handleSave = (entry: MemoryEntry, text: string) => (current ? handleChange(() => client.api.memory.replace(current.scope, entry.id, text)) : Promise.resolve(false));

  const handleRemove = (entry: MemoryEntry) => {
    if (!current) return;
    void handleChange(() => client.api.memory.remove(current.scope, entry.id));
  };

  const handleFile = (entry: MemoryEntry) => {
    if (!current) return;
    void handleChange(() => client.api.memory.file(current.scope, entry.id, !entry.filed));
  };

  const filed = current ? filedEntries(current) : [];

  const handleTidy = async () => {
    setTidying(true);
    try {
      toast(client, tidyWords(await client.api.memory.tidy()), 'info');
    } catch (err) {
      toast(client, errorText(err as Error), 'error');
    } finally {
      setTidying(false);
    }
  };

  return (
    <Group title="Memory">
      <Row label="What your agents remember" detail="Added to every run you start, on Claude Code, Codex, Copilot, OpenCode and local models. Never to a friend’s run. Agents keep it with their memory tools.">
        {current ? <Select label="Memory" size="small" value={keyOf(current.scope)} options={options} onChange={setPicked} /> : null}
      </Row>
      {current ? (
        <div className={a.editor}>
          {alwaysEntries(current).map((entry) => (
            <MemoryEntryRow key={`${entry.id}:${entry.text}`} entry={entry} onSave={handleSave} onRemove={handleRemove} onFile={handleFile} />
          ))}
          <div className={a.bar}>
            <input
              className={`${a.field} ${a.description}`}
              aria-label="New memory entry"
              spellCheck={false}
              placeholder={current.scope.kind === 'user' ? 'Prefers short answers…' : 'Deploys go through the NAS…'}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void handleAdd()}
            />
            <Button size="small" icon="plus" disabled={!draft.trim()} onClick={() => void handleAdd()}>
              Add
            </Button>
          </div>
          <div className={a.bar}>
            <span className={a.muted}>One fact per entry. Never a password or key.</span>
            <span className={a.flex} />
            <span className={a.muted}>
              {current.used} / {current.cap}
            </span>
            <Button size="small" icon="sparkles" disabled={tidying} onClick={() => void handleTidy()}>
              {tidying ? 'Tidying…' : 'Tidy'}
            </Button>
          </div>
          {filed.length ? (
            <>
              <div className={a.bar}>
                <span className={a.muted}>Filed away: a run gets these only when it is about them</span>
                <span className={a.flex} />
                <span className={a.muted}>
                  {current.filedUsed} / {current.filedCap}
                </span>
              </div>
              {filed.map((entry) => (
                <MemoryEntryRow key={`${entry.id}:${entry.text}`} entry={entry} onSave={handleSave} onRemove={handleRemove} onFile={handleFile} />
              ))}
            </>
          ) : null}
        </div>
      ) : null}
    </Group>
  );
};
