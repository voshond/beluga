import type { SocketClient } from '@beluga/ipc/socket-client.js';
import { linkHealth } from '@beluga/machines/links.js';
import { Icon } from '../components/Icon.js';
import { cx } from '../components/ui.js';
import { useLinkSample } from './use-link-sample.js';
import { useBeluga, useMachine } from '../lib/beluga.js';
import { MachineMark } from './MachineMark.js';
import { useMachineView } from './use-machines.js';
import c from './machines.module.css';

/** Inside a computer's page: its mark and name, for the toolbar's title ("on build-box"). */
export function MachineTag() {
  const machine = useMachine();
  const { home } = useBeluga();
  if (!machine) return null;
  return <Tag machine={machine} home={home} />;
}

function Tag({ machine, home }: { machine: string; home: SocketClient }) {
  const view = useMachineView(home, machine);
  // The link as this window feels it (BLG-792): said when it's slow or lost, never felt as a freeze.
  const sample = useLinkSample(machine);
  const name = view?.name ?? 'Your computer';
  const link = sample ? linkHealth(sample, name) : { state: 'ok' as const, words: `Runs on ${name}` };
  return (
    <span className={cx(c.tag, link.state !== 'ok' && c.tagDim)} title={link.words} data-link={link.state}>
      {view ? <MachineMark machine={view} size={12} /> : null}
      {view?.name ?? 'Your computer'}
      {link.state === 'slow' ? (
        <span className={cx(c.linkBadge, c.linkSlow)}>
          <Icon name="clock" size={10} />
          Slow
        </span>
      ) : link.state === 'lost' ? (
        <span className={cx(c.linkBadge, c.linkLost)}>
          <Icon name="refresh" size={10} />
          Reconnecting
        </span>
      ) : null}
    </span>
  );
}
