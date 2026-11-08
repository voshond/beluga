import { useEffect, useState } from 'react';
import { ActionsDropdown } from '../components/SpecMenu.js';
import { IconButton } from '../components/ui.js';
import { useApi } from '../lib/beluga.js';

export function SshMenu({ onOpen, className }: { onOpen: (host: string) => void; className?: string }) {
  const api = useApi();
  const [hosts, setHosts] = useState<readonly string[]>([]);
  useEffect(() => {
    let live = true;
    void api.terminals.sshHosts().then((found) => live && setHosts(found), () => undefined);
    return () => {
      live = false;
    };
  }, [api]);
  if (!hosts.length) return null;
  const items = hosts.map((host) => ({ label: host, icon: 'globe' as const, onSelect: () => onOpen(host) }));
  return (
    <ActionsDropdown items={items} align="start">
      <IconButton icon="globe" label="Shell on another machine (SSH)" {...(className ? { className } : {})} />
    </ActionsDropdown>
  );
}
