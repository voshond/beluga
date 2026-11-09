import * as Popover from '@radix-ui/react-popover';
import { useEffect, useRef, useState } from 'react';
import { CLAUDE_AI_CONNECTORS_URL } from '@beluga/shared/mcp.js';
import { Icon } from '../components/Icon.js';
import { Dot, cx } from '../components/ui.js';
import { useApp, useBeluga } from '../lib/beluga.js';
import { myRuntime } from './ModelPicker.js';
import { MCP_FROM, MCP_STATUS, checkMcp, mcpRuntimeOf, mcpSummary, signInMcp, useMcp } from '../lib/mcp.js';
import { openExternal } from '../lib/system.js';
import s from './mcp.module.css';

const OPEN_DELAY_MS = 220;
const CLOSE_DELAY_MS = 180;

/**
 * Your MCP servers in the box you type in (BLG-252): a plug and how many are connected, with a
 * soft amber dot when one needs you to sign in. Hover for the list, Sign In… right there.
 * Nothing shows when you have none. It sits on the box's right, beside how full the context is;
 * in a narrow box only the plug (and its dot) stays.
 */
export function McpChip() {
  const { client, ui } = useBeluga();
  // Your agent's servers (Codex's own when it's Codex, BLG-518): the same list as Settings shows.
  const runtime = mcpRuntimeOf(useApp((st) => myRuntime(st.prefs)));
  const { rows, checking, signingIn } = useMcp(client, runtime);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const later = (v: boolean, ms: number): void => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(v), ms);
  };
  const hover = { onPointerEnter: () => later(true, open ? 0 : OPEN_DELAY_MS), onPointerLeave: () => later(false, CLOSE_DELAY_MS) };
  if (!rows?.length) return null;
  const sum = mcpSummary(rows);
  return (
    <Popover.Root
      open={open}
      onOpenChange={(v) => {
        clearTimeout(timer.current);
        setOpen(v);
      }}
    >
      <Popover.Trigger asChild>
        <button type="button" className={s.chip} aria-label={`MCP servers: ${sum.line}`} data-mcp-chip={sum.needYou ? 'needs-you' : 'ok'} {...hover}>
          <Icon name="plug" size={12} />
          <span className={s.count}>
            {sum.connected}/{rows.length}
          </span>
          {sum.needYou ? <span className={s.needs} aria-hidden="true" /> : null}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className={s.popover} side="top" align="end" sideOffset={8} collisionPadding={12} aria-label="MCP servers" {...hover} onOpenAutoFocus={(e) => e.preventDefault()}>
          <div className={s.head}>
            <span className={s.title}>MCP servers</span>
            <button type="button" className={s.quiet} disabled={checking} onClick={() => void checkMcp(client, runtime)} aria-label="Check again">
              <Icon name="refresh" size={12} className={cx(checking && s.turning)} />
            </button>
          </div>
          <div className={s.sub}>{sum.line}</div>
          <ul className={s.list}>
            {rows.map((row) => (
              <li key={row.name} className={s.row}>
                <Dot tone={MCP_STATUS[row.status].tone} />
                <span className={s.name}>
                  {row.label}
                  <span className={s.from}>{MCP_FROM[row.from](row.where)}</span>
                </span>
                {row.canSignIn ? (
                  <button type="button" className={s.signIn} disabled={signingIn !== undefined} onClick={() => void signInMcp(client, row, runtime)}>
                    {signingIn === row.name ? 'Waiting…' : 'Sign In'}
                  </button>
                ) : row.from === 'claude.ai' && row.status === 'needs-auth' ? (
                  <button type="button" className={s.signIn} onClick={() => void openExternal(CLAUDE_AI_CONNECTORS_URL)}>
                    claude.ai
                  </button>
                ) : (
                  <span className={s.state} title={row.error}>
                    {MCP_STATUS[row.status].words}
                  </span>
                )}
              </li>
            ))}
          </ul>
          <div className={s.foot}>
            <span className={s.hint}>Your own agent uses these. A friend’s request never does.</span>
            <button
              type="button"
              className={s.quiet}
              onClick={() => {
                setOpen(false);
                ui.patch({ settings: 'claude' });
              }}
            >
              Settings
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
