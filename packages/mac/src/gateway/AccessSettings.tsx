import { useState } from 'react';
import { CAP_INFO, CAP_LEVEL_INFO, CAP_ORDER, type CapLevel, type CapRow, type CapTrust, DECISION_INFO, type Rule, type RuleDecision, expiryLabel, ruleLabel } from '@beluga/core/gateway/access.js';
import { TRUST_INFO } from '@beluga/core/trust.js';
import { Button, cx } from '../components/ui.js';
import { Group, Select } from '../dialogs/settings-controls.js';
import { canPickFolders, inApp } from '../lib/boot.js';
import { pickFolders } from '../lib/projects.js';
import { useApi, useApp, useBeluga } from '../lib/beluga.js';
import s from './access.module.css';

/**
 * Settings › People & access, for tasks between Claudes: what friends' Claudes may do here, per
 * capability and trust level (with the folders they may use and your "Ask me for…" note), and
 * your rules for people's requests, which "Always" on a request writes. The rules of one person
 * also show on their card.
 */

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const COLUMNS: readonly CapTrust[] = ['ask', 'trusted', 'full'];

function useSay(): (what: string, call: Promise<unknown>, done?: string) => void {
  const { client } = useBeluga();
  return (what, call, done) =>
    void call
      .then(() => (done ? client.store.dispatch({ type: 'toast', text: done, level: 'success' }) : undefined))
      .catch((err: unknown) => client.store.dispatch({ type: 'toast', text: `Couldn't ${what}: ${message(err)}`, level: 'error' }));
}

/** Pick a folder (the Mac's open panel; in a served page Beluga's picker of the server's folders; else a typed path). */
async function pickFolder(): Promise<string | undefined> {
  if (!inApp()) return (await pickFolders('A folder friends’ agents may read and write'))?.[0];
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({ directory: true, multiple: false, title: 'A folder friends’ agents may read and write' });
  return typeof picked === 'string' ? picked : undefined;
}

function Folders() {
  const api = useApi();
  const say = useSay();
  const folders = useApp((st) => st.gateway.capabilities.folders);
  const [typed, setTyped] = useState('');
  const set = (next: readonly string[]): void => say('change the folders', api.gateway.setCapabilities({ folders: [...next] }));
  const add = async (): Promise<void> => {
    const folder = typed.trim() || (await pickFolder());
    if (!folder || folders.includes(folder)) return;
    set([...folders, folder]);
    setTyped('');
  };
  return (
    <div className={s.folders} role="group" aria-label="Folders friends may use">
      <div className={s.capName}>Folders for “Read and write files”</div>
      <div className={s.capDetail}>Besides the folder each request gets for itself. Secrets (.env files, keys) stay off-limits anyway.</div>
      {folders.map((f) => (
        <div key={f} className={s.folder}>
          <span title={f}>{f}</span>
          <Button size="small" variant="quiet" aria-label={`Remove ${f}`} onClick={() => set(folders.filter((x) => x !== f))}>
            Remove
          </Button>
        </div>
      ))}
      <div className={s.folderAdd}>
        {canPickFolders() ? null : <input className={s.input} aria-label="Folder path" placeholder="/Users/you/Shared" value={typed} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void add()} />}
        <Button size="small" onClick={() => void add()} disabled={!canPickFolders() && !typed.trim()}>
          Add Folder…
        </Button>
      </div>
    </div>
  );
}

function AskMeFor() {
  const api = useApi();
  const say = useSay();
  const saved = useApp((st) => st.gateway.note);
  const [text, setText] = useState<string | undefined>();
  const save = (): void => {
    if (text === undefined || text === saved) return;
    say('save it', api.gateway.setNote(text).then(() => setText(undefined)), 'Saved. Friends’ agents see it on your card');
  };
  return (
    <div className={s.folders}>
      <div className={s.capName}>Ask me for…</div>
      <div className={s.capDetail}>A short note friends’ agents see when they look for who can help.</div>
      <input className={s.input} aria-label="Ask me for" placeholder="the API, design reviews…" value={text ?? saved} maxLength={280} onChange={(e) => setText(e.target.value)} onBlur={save} onKeyDown={(e) => e.key === 'Enter' && save()} />
    </div>
  );
}

/** Friends your Claude asks without checking with you first (you said Always on its "Ask X's Claude?" card). */
function AskFreely() {
  const api = useApi();
  const say = useSay();
  const peers = useApp((st) => st.gateway.askFreely ?? []);
  const friends = useApp((st) => st.network.friends);
  const roomPeers = useApp((st) => st.peers);
  const nameOf = (id: string): string => friends.find((f) => f.peerId === id)?.name ?? roomPeers.find((p) => p.peerId === id)?.name ?? 'Someone';
  if (!peers.length) return null;
  return (
    <div className={s.folders} role="group" aria-label="Friends your agent asks without checking">
      <div className={s.capName}>Your agent asks them without checking</div>
      <div className={s.capDetail}>You said Always when your agent wanted to ask them. Others still get “Can I ask them?” first.</div>
      {peers.map((id) => (
        <div key={id} className={s.folder}>
          <span>{nameOf(id)}</span>
          <Button size="small" variant="quiet" aria-label={`Ask me first about ${nameOf(id)}`} onClick={() => say('change it', api.gateway.setAskFreely(id, false), 'Your agent asks you first again')}>
            Ask Me First
          </Button>
        </div>
      ))}
    </div>
  );
}

/** What friends' Claudes may do here: each capability by trust level (Allow / Ask me / Off). */
export function CapabilitySettings() {
  const api = useApi();
  const say = useSay();
  const caps = useApp((st) => st.gateway.capabilities);
  const set = (need: (typeof CAP_ORDER)[number], trust: CapTrust, level: CapLevel): void => {
    const row: CapRow = { ...caps.levels[need], [trust]: level };
    say('change it', api.gateway.setCapabilities({ levels: { [need]: row } }));
  };
  return (
    <Group title="What your friends’ agents can do here">
      <table className={s.capTable} aria-label="What friends’ agents can do here">
        <thead>
          <tr>
            <th />
            {COLUMNS.map((c) => (
              <th key={c}>{TRUST_INFO[c].label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {CAP_ORDER.map((need) => (
            <tr key={need}>
              <td>
                <div className={s.capName}>{CAP_INFO[need].label}</div>
                <div className={s.capDetail}>{CAP_INFO[need].detail}</div>
              </td>
              {COLUMNS.map((trust) => (
                <td key={trust} className={s.capCell}>
                  <Select<CapLevel>
                    label={`${CAP_INFO[need].label} for ${TRUST_INFO[trust].label}`}
                    value={caps.levels[need][trust]}
                    onChange={(v) => set(need, trust, v)}
                    // "Ask me each time" asks anyway: Allow there would mean the same as Ask me.
                    options={(trust === 'ask' ? (['ask', 'off'] as const) : (['allow', 'ask', 'off'] as const)).map((l) => ({ value: l, label: CAP_LEVEL_INFO[l] }))}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <Folders />
      <AskMeFor />
      <AskFreely />
    </Group>
  );
}

/** One rule: what it covers, until when; change its answer, or delete it. */
function RuleRow({ rule }: { rule: Rule }) {
  const api = useApi();
  const say = useSay();
  const { id, peerId, peerName, kind, needs, command, project, folder, expiresAt } = rule;
  const base = { id, peerId, peerName, kind, needs: [...needs], ...(command ? { command } : {}), ...(project ? { project } : {}), ...(folder ? { folder } : {}), ...(expiresAt ? { expiresAt } : {}) };
  return (
    <div className={s.rule} role="listitem" aria-label={`Rule: ${ruleLabel(rule)}`}>
      <div className={s.ruleText}>
        <div className={s.ruleLabel}>{ruleLabel(rule)}</div>
        <div className={s.ruleMeta}>
          {expiryLabel(rule)} · made {new Date(rule.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}
        </div>
      </div>
      <Select<RuleDecision> label={`Answer for: ${ruleLabel(rule)}`} value={rule.decision} onChange={(v) => say('change the rule', api.gateway.saveRule({ ...base, decision: v }))} options={(['allow', 'ask', 'decline'] as const).map((d) => ({ value: d, label: DECISION_INFO[d] }))} />
      <Button size="small" variant="quiet" aria-label={`Delete rule: ${ruleLabel(rule)}`} onClick={() => say('delete the rule', api.gateway.removeRule(rule.id), 'Rule deleted. Requests like it ask you again')}>
        Delete
      </Button>
    </div>
  );
}

/** One person's rules (their card in the inspector, Settings). */
export function PersonRules({ peerId, compact }: { peerId: string; compact?: boolean }) {
  const all = useApp((st) => st.gateway.rules);
  const rules = all.filter((r) => r.peerId === peerId);
  if (!rules.length) return <div className={s.empty}>No rules yet. Choosing Always on one of their requests makes one.</div>;
  return (
    <div className={cx(s.cardRules, compact && s.compact)} role="list" aria-label="Rules">
      {rules
        .slice()
        .reverse()
        .map((r) => (
          <RuleRow key={r.id} rule={r} />
        ))}
    </div>
  );
}

/** Every rule, by person. */
export function RuleSettings() {
  const rules = useApp((st) => st.gateway.rules);
  const people = [...new Map(rules.map((r) => [r.peerId, r.peerName])).entries()];
  return (
    <Group title="Rules for people’s requests">
      {people.length ? (
        <div role="list" aria-label="Rules by person">
          {people.map(([peerId, name]) => (
            <div key={peerId} role="listitem" aria-label={`Rules for ${name}`}>
              <div className={s.person}>{name}</div>
              <PersonRules peerId={peerId} />
            </div>
          ))}
        </div>
      ) : (
        <div className={s.empty}>No rules yet. When you choose Always on a friend’s request, the rule it makes shows up here, and you can change or delete it.</div>
      )}
    </Group>
  );
}

/** Both, for Settings › People & access (only while the app runs the gateway). */
export function AccessSettings() {
  const enabled = useApp((st) => st.gateway.enabled);
  if (!enabled) return null;
  return (
    <>
      <CapabilitySettings />
      <RuleSettings />
    </>
  );
}
