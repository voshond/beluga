import { useEffect, useState } from 'react';
import { Button } from '../components/ui.js';
import { appInvoke, remoteApp } from '../lib/boot.js';
import { Group, Row } from './settings-controls.js';
import s from './settings.module.css';

type ClientView = { readonly deviceName: string };

/** The app as a client of a Beluga server (BLG-53): which server, this device's name, and the way back to Run here. */
export function ServerSettingsGroup() {
  const [deviceName, setDeviceName] = useState('');
  const [saved, setSaved] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!remoteApp()) return;
    void appInvoke<ClientView>('client_config')
      .then((view) => {
        setDeviceName(view.deviceName);
        setSaved(view.deviceName);
      })
      .catch(() => undefined);
  }, []);

  if (!remoteApp()) return null;

  const handleSaveName = () => {
    if (deviceName.trim() === saved) return;
    appInvoke<string>('client_set_device_name', { name: deviceName })
      .then((name) => {
        setError(null);
        setSaved(name);
        setDeviceName(name);
      })
      .catch((err: Error | string) => setError(typeof err === 'string' ? err : err.message));
  };

  const handleChangeServer = () => void appInvoke('client_change_server').catch(() => undefined);
  const handleRunHere = () => void appInvoke('client_use_local').catch(() => undefined);

  return (
    <Group title="Server">
      <Row label="Address" detail="This app shows the Beluga that runs there. Projects, agents and files are the server’s.">
        <span className={s.mono}>{location.origin}</span>
      </Row>
      <Row label="This device" detail={error ?? 'How the server’s agents name this computer.'}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSaveName();
          }}
        >
          <input aria-label="This device" className={s.text} value={deviceName} spellCheck={false} onChange={(e) => setDeviceName(e.target.value)} onBlur={handleSaveName} />
        </form>
      </Row>
      <Row label="Connection" detail="Pick another server, or run Beluga on this computer instead.">
        <Button size="small" onClick={handleChangeServer}>
          Change Server…
        </Button>
        <Button size="small" onClick={handleRunHere}>
          Switch to Run Here
        </Button>
      </Row>
    </Group>
  );
}
