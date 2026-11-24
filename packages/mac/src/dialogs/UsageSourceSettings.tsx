import { useEffect, useState } from 'react';
import type { BelugaClient } from '@beluga/ipc/client.js';
import { USAGE_GATEWAY_DEFAULT_URL, type UsageGatewayCheck, type UsageGatewayProviders, type UsageSource } from '@beluga/shared/usage-gateway.js';
import { Button } from '../components/ui.js';
import { useBeluga } from '../lib/beluga.js';
import { useClock } from '../lib/window-active.js';
import { ago } from '../phone/phone-model.js';
import p from '../phone/phone.module.css';
import { Group, Row, Select } from './settings-controls.js';
import s from './settings.module.css';

type UsageGatewayApi = BelugaClient['api']['usageGateway'];
type Status = Awaited<ReturnType<UsageGatewayApi['status']>>;
type Patch = Parameters<UsageGatewayApi['configure']>[0];

const REFRESH_MS = 10_000;

const errorText = (err: Error): string => err.message || String(err);

const providerWords = (providers: UsageGatewayProviders): string =>
  (['claude', 'codex'] as const).map((id) => `${id === 'claude' ? 'Claude Code' : 'Codex'}: ${providers[id].ok ? 'came back' : providers[id].error ?? 'nothing'}`).join(' · ');

const checkWords = (check: UsageGatewayCheck): string => (check.ok ? providerWords(check.providers) : check.error);

const lastWords = (status: Status, now: number): string => {
  if (status.lastError) return `Last problem: ${status.lastError}. The cards keep their last numbers.`;
  if (!status.checkedAt) return 'Not read yet.';
  const read = `Read ${ago(status.checkedAt, now)}`;
  return status.providers ? `${read}. ${providerWords(status.providers)}` : `${read}.`;
};

export function UsageSourceSettings() {
  const { client } = useBeluga();
  const [status, setStatus] = useState<Status>();
  const [urlDraft, setUrlDraft] = useState<string>();
  const [key, setKey] = useState('');
  const [check, setCheck] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const tick = useClock(true, REFRESH_MS);
  useEffect(() => {
    client.api.usageGateway.status().then(setStatus, (err: Error) => setError(errorText(err)));
  }, [client, tick]);

  if (!status) return error ? <div className={p.error}>{error}</div> : null;

  const url = urlDraft ?? status.url;
  const onGateway = status.source === 'gateway';

  const save = (patch: Patch): void => {
    setError(undefined);
    client.api.usageGateway.configure(patch).then(
      (next) => {
        setStatus(next);
        setUrlDraft(undefined);
      },
      (err: Error) => setError(errorText(err)),
    );
  };

  const handleSource = (source: UsageSource): void => save({ source });
  const handleSaveUrl = (): void => {
    if (!url.trim() || url.trim().replace(/\/+$/, '') === status.url) return;
    save({ url: url.trim(), ...(key.trim() ? { key: key.trim() } : {}) });
    setKey('');
  };
  const handleSaveKey = (): void => {
    if (!key.trim()) return;
    save({ key: key.trim() });
    setKey('');
  };
  const handleForgetKey = (): void => save({ key: null });
  const handleCheck = (): void => {
    setBusy(true);
    setCheck(undefined);
    client.api.usageGateway
      .check({ ...(url.trim() ? { url: url.trim() } : {}), ...(key.trim() ? { key: key.trim() } : {}) })
      .then(
        (r) => setCheck(checkWords(r)),
        (err: Error) => setCheck(errorText(err)),
      )
      .finally(() => setBusy(false));
  };

  return (
    <Group title="Usage source">
      <Row label="Read Claude Code and Codex usage from" detail={onGateway ? 'Your ai-gateway, every 5 minutes, on top of what your agents report here. No local sign-in or run needed.' : 'What your agents report when they run on this computer.'}>
        <Select
          label="Usage source"
          value={status.source}
          onChange={handleSource}
          options={[
            { value: 'local', label: 'Local agents' },
            { value: 'gateway', label: 'ai-gateway' },
          ]}
        />
      </Row>
      {onGateway ? (
        <>
          <Row label="Address" detail={status.hasKey && url.trim().replace(/\/+$/, '') !== status.url ? `The saved key only goes to ${status.url}: saving this address forgets it unless you type its key below first.` : undefined}>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleSaveUrl();
              }}
            >
              <input aria-label="ai-gateway address" className={s.text} value={url} spellCheck={false} placeholder={USAGE_GATEWAY_DEFAULT_URL} onChange={(e) => setUrlDraft(e.target.value)} onBlur={handleSaveUrl} />
            </form>
          </Row>
          <Row label="Usage key" detail={status.hasKey ? `Saved on this computer, readable only by you, and only ever sent to ${status.url}. Type a new one to replace it.` : 'The gateway’s read-only USAGE_READ_TOKEN.'}>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleSaveKey();
              }}
            >
              <input aria-label="ai-gateway usage key" type="password" autoComplete="off" className={s.text} value={key} spellCheck={false} placeholder={status.hasKey ? '••••••••' : 'none'} onChange={(e) => setKey(e.target.value)} onBlur={handleSaveKey} />
            </form>
            {status.hasKey ? (
              <Button size="small" variant="quiet" onClick={handleForgetKey}>
                Forget
              </Button>
            ) : null}
          </Row>
          <Row label="Check" detail={check ?? lastWords(status, Date.now())}>
            <Button size="small" disabled={busy} onClick={handleCheck}>
              {busy ? 'Checking…' : 'Check'}
            </Button>
          </Row>
        </>
      ) : null}
      {error ? <div className={p.error}>{error}</div> : null}
    </Group>
  );
}
