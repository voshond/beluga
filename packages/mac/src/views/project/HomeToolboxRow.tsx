import * as Popover from "@radix-ui/react-popover";
import { useEffect, useRef, useState } from "react";
import type { Tool, ToolReport, ToolReportStatus } from "@beluga/workspaces/toolbox.js";
import { Icon } from "../../components/Icon.js";
import { Button, Working, cx } from "../../components/ui.js";
import { Xterm } from "../Xterm.js";
import t from "./home-toolbox.module.css";

export type ToolView = {
  readonly tool: Tool;
  readonly termKey: string;
  /** Its terminal is there (running or ended): the popup has something to show. */
  readonly started: boolean;
  readonly running: boolean;
  readonly result: ToolReport | undefined;
  /** What the row says under the name: the tool's own report, else the last line it printed. */
  readonly line: string | undefined;
  readonly needsHost: boolean;
};

type ToolRowProps = {
  readonly view: ToolView;
  /** Bumped on each run: the popup's terminal attaches again to the new program. */
  readonly run: number;
  readonly busy: boolean;
  readonly watching: boolean;
  readonly onWatch: (open: boolean) => void;
  readonly onRun: (watch: boolean) => void;
};

const TOOL_STATUS_ICON = { success: "check", warn: "alert", fail: "x" } as const;
const FLASH_MS = 8000;

const runLabel = ({ tool, result }: ToolView): string =>
  result ? `Run ${tool.name} (last run: ${result.status}${result.message ? `, ${result.message}` : ""})` : `Run ${tool.name}`;

const noStart = (): undefined => undefined;

/** The status a run that just ended shows for a few seconds (its row tinted), then lets go. */
function useFlash(running: boolean, status: ToolReportStatus | undefined): ToolReportStatus | undefined {
  const [flash, setFlash] = useState<ToolReportStatus | undefined>(undefined);
  const wasRunning = useRef(running);
  useEffect(() => {
    const ended = wasRunning.current && !running;
    wasRunning.current = running;
    if (running) return setFlash(undefined);
    if (!ended || !status) return;
    setFlash(status);
    const timer = setTimeout(() => setFlash(undefined), FLASH_MS);
    return () => clearTimeout(timer);
  }, [running, status]);
  return flash;
}

function ToolStatus({ view }: { view: ToolView }) {
  if (view.running) return <span className={t.status}><Working /></span>;
  if (!view.result) return <span className={t.runWord}>Run</span>;
  return <span className={cx(t.status, t[`tone_${view.result.status}`])}><Icon name={TOOL_STATUS_ICON[view.result.status]} size={11} /></span>;
}

function WatchPopup({ view, run, busy, onRun }: { view: ToolView; run: number; busy: boolean; onRun: () => void }) {
  return (
    <Popover.Content className={t.popover} side="bottom" align="end" sideOffset={6} collisionPadding={12} aria-label={`${view.tool.name} output`}>
      <div className={t.popHead}>
        <span className={t.name}>{view.tool.name}</span>
        <span className={cx(t.popState, view.result && t[`tone_${view.result.status}`])}>
          {view.running ? "Running…" : view.result ? (view.result.message || view.result.status) : "Starting…"}
        </span>
        <span className={t.flex} />
        <Button size="small" variant="quiet" icon="play" disabled={busy || view.running} onClick={onRun}>
          Run Again
        </Button>
        <Popover.Close className={t.iconButton} aria-label="Close"><Icon name="x" size={12} /></Popover.Close>
      </div>
      <div className={t.termBox}>
        {view.started ? <Xterm key={`${view.termKey}#${run}`} termKey={view.termKey} start={noStart} focus={false} /> : null}
      </div>
    </Popover.Content>
  );
}

export function ToolRow({ view, run, busy, watching, onWatch, onRun }: ToolRowProps) {
  const flash = useFlash(view.running, view.result?.status);
  const params = view.tool.params ?? [];
  const tone = view.result && !view.running ? t[`tone_${view.result.status}`] : undefined;

  const handleWatch = (): void => {
    if (watching) return onWatch(false);
    if (view.started) return onWatch(true);
    onRun(true);
  };

  return (
    <div role="listitem" className={cx(t.listItem, flash && t[`flash_${flash}`])}>
      <button type="button" className={t.listRow} onClick={() => onRun(false)} disabled={busy || view.running} aria-label={runLabel(view)} aria-busy={view.running}>
        <span className={t.runMark}>
          <Icon name="wrench" size={12} className={t.runIdle} />
          <Icon name="play" size={12} className={t.runGo} />
        </span>
        <span className={t.main}>
          <span className={t.nameLine}>
            <span className={t.name}>{view.tool.name}</span>
            {params.map((p) => (
              <span key={p.name} className={t.param} title={p.kind === "host" ? "Asks for an SSH host" : "Asks for a value"}>{`{{${p.name}}}`}</span>
            ))}
          </span>
          {view.line ? <span className={cx(t.trail, tone)}>{view.line}</span> : null}
        </span>
        <ToolStatus view={view} />
      </button>
      <Popover.Root open={watching} onOpenChange={onWatch}>
        <Popover.Trigger asChild>
          <button type="button" className={cx(t.iconButton, t.watch, watching && t.watchOn)} onClick={(e) => { e.preventDefault(); handleWatch(); }} disabled={busy && !view.started} aria-label={view.started ? `Watch ${view.tool.name}` : `Run ${view.tool.name} and watch`} title={view.started ? "Watch the output" : "Run and watch"}>
            <Icon name="terminal" size={13} />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <WatchPopup view={view} run={run} busy={busy} onRun={() => onRun(true)} />
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
