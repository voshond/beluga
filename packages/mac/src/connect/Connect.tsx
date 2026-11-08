import { invoke } from '@tauri-apps/api/core';
import { type FormEvent, useEffect, useState } from 'react';
import { checkDeviceName, checkServerUrl } from './server-url.js';

type ClientView = {
  readonly mode: 'local' | 'server' | null;
  readonly serverUrl: string | null;
  readonly deviceName: string;
  readonly defaultDeviceName: string;
};

type Screen =
  | { readonly kind: 'loading' }
  | { readonly kind: 'pick' }
  | { readonly kind: 'server' }
  | { readonly kind: 'connecting'; readonly server: string }
  | { readonly kind: 'unreachable'; readonly server: string; readonly detail: string };

const errorText = (err: Error | string): string => (typeof err === 'string' ? err : err.message);

const wantsChange = (): boolean => new URLSearchParams(location.search).has('change');

export const Connect = () => {
  const [screen, setScreen] = useState<Screen>({ kind: 'loading' });
  const [address, setAddress] = useState('');
  const [deviceName, setDeviceName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const openSaved = (server: string) => {
    setScreen({ kind: 'connecting', server });
    invoke('client_open').catch((err: Error | string) => setScreen({ kind: 'unreachable', server, detail: errorText(err) }));
  };

  useEffect(() => {
    invoke<ClientView>('client_config')
      .then((view) => {
        setAddress(view.serverUrl ?? '');
        setDeviceName(view.deviceName);
        if (view.mode === 'server' && view.serverUrl && !wantsChange()) return openSaved(view.serverUrl);
        setScreen({ kind: view.serverUrl ? 'server' : 'pick' });
      })
      .catch((err: Error | string) => {
        setError(errorText(err));
        setScreen({ kind: 'pick' });
      });
  }, []);

  const handleRunHere = () => {
    setBusy(true);
    setError(null);
    invoke('client_use_local').catch((err: Error | string) => {
      setBusy(false);
      setError(errorText(err));
    });
  };

  const handleConnect = (event: FormEvent) => {
    event.preventDefault();
    const url = checkServerUrl(address);
    const nameError = checkDeviceName(deviceName);
    if (!url.ok) return setError(url.error);
    if (nameError) return setError(nameError);
    setBusy(true);
    setError(null);
    invoke('client_use_server', { url: url.url, deviceName }).catch((err: Error | string) => {
      setBusy(false);
      setError(errorText(err));
    });
  };

  const handleChangeServer = () => {
    setError(null);
    setScreen({ kind: 'server' });
  };

  const handleBack = () => {
    setError(null);
    setScreen({ kind: 'pick' });
  };

  const alert = error && (
    <p className="connect-error" role="alert">
      {error}
    </p>
  );

  if (screen.kind === 'loading') return <main className="connect" aria-busy="true" />;

  if (screen.kind === 'connecting') {
    return (
      <main className="connect" aria-busy="true">
        <h1>Connecting…</h1>
        <p className="connect-lead">{screen.server}</p>
      </main>
    );
  }

  if (screen.kind === 'unreachable') {
    return (
      <main className="connect">
        <h1>Can’t reach the server</h1>
        <p className="connect-lead">{screen.server}</p>
        <p className="connect-error" role="alert">
          {screen.detail}
        </p>
        <div className="connect-actions">
          <button type="button" className="connect-primary" onClick={() => openSaved(screen.server)}>
            Retry
          </button>
          <button type="button" onClick={handleChangeServer}>
            Change server
          </button>
        </div>
      </main>
    );
  }

  if (screen.kind === 'server') {
    return (
      <main className="connect">
        <h1>Connect to a server</h1>
        <p className="connect-lead">Open a Beluga that runs on another computer. Nothing runs on this one.</p>
        <form className="connect-form" onSubmit={handleConnect} noValidate>
          <label>
            Server address
            <input type="url" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="https://my-server.my-tailnet.ts.net" autoFocus spellCheck={false} autoCapitalize="off" />
          </label>
          <span className="connect-hint">The address of its web port, or a join link. http:// only works for 127.0.0.1 (an SSH tunnel).</span>
          <label>
            This device’s name
            <input type="text" value={deviceName} onChange={(e) => setDeviceName(e.target.value)} spellCheck={false} />
          </label>
          <span className="connect-hint">How the server’s agents name this computer.</span>
          {alert}
          <div className="connect-actions">
            <button type="submit" className="connect-primary" disabled={busy}>
              {busy ? 'Connecting…' : 'Connect'}
            </button>
            <button type="button" onClick={handleBack} disabled={busy}>
              Back
            </button>
          </div>
        </form>
      </main>
    );
  }

  return (
    <main className="connect">
      <h1>Welcome to Beluga</h1>
      <p className="connect-lead">Where should your projects and agents run?</p>
      <div className="connect-choices">
        <button type="button" className="connect-choice" onClick={handleRunHere} disabled={busy}>
          <strong>Run Beluga here</strong>
          <span>This computer runs your projects, agents and rooms.</span>
        </button>
        <button type="button" className="connect-choice" onClick={handleChangeServer} disabled={busy}>
          <strong>Connect to a server</strong>
          <span>Use a Beluga that runs on another computer, over Tailscale, an SSH tunnel or your own domain.</span>
        </button>
      </div>
      {alert}
    </main>
  );
};
