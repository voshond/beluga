import { useEffect, useState } from "react";
import { type Tool, type ToolReport, toolOutcome } from "@beluga/workspaces/toolbox.js";
import { toolboxTermId } from "@beluga/shared/terminal-keys.js";
import { Icon } from "../../components/Icon.js";
import { Select } from "../../components/Select.js";
import { Button, Segmented, Tip, Working, cx } from "../../components/ui.js";
import { toast, useApi, useApp, useBeluga } from "../../lib/beluga.js";
import { useLateArrival } from "../../lib/last-seen.js";
import { type ToolboxLook, setPrefs, usePrefs } from "../../lib/prefs.js";
import { sameFields } from "../../lib/stable.js";
import { Section } from "./HomeSection.js";
import t from "./home-toolbox.module.css";

/** Where a tool's last run is: still going, or how it ended (its exit code and its own `::beluga status=` line). */
type ToolRunState = { readonly running: true; readonly report?: ToolReport } | { readonly running: false; readonly outcome: ToolReport };

type ToolView = {
  readonly tool: Tool;
  readonly running: boolean;
  readonly result: ToolReport | undefined;
  readonly message: string | undefined;
  readonly needsHost: boolean;
};

type LookProps = {
  readonly views: readonly ToolView[];
  readonly busy: boolean;
  readonly onRun: (tool: Tool) => void;
  readonly picker: (tool: Tool) => React.ReactNode;
};

const TOOL_STATUS_ICON = { success: "check", warn: "alert", fail: "x" } as const;

const LOOKS = [
  { value: "list", label: "List", icon: "rows" },
  { value: "tiles", label: "Tiles", icon: "grid" },
  { value: "chips", label: "Chips", icon: "tag" },
] as const;

const runLabel = ({ tool, result }: ToolView): string =>
  result ? `Run ${tool.name} (last run: ${result.status}${result.message ? `, ${result.message}` : ""})` : `Run ${tool.name}`;

function ToolStatus({ view, idle }: { view: ToolView; idle?: React.ReactNode }) {
  if (view.running) return <span className={t.status}><Working /></span>;
  if (view.result) return <span className={cx(t.status, t[`tone_${view.result.status}`])}><Icon name={TOOL_STATUS_ICON[view.result.status]} size={11} /></span>;
  return <>{idle ?? null}</>;
}

function ToolLine({ view }: { view: ToolView }) {
  const tone = view.result && view.message ? t[`tone_${view.result.status}`] : undefined;
  return <span className={cx(view.message ? t.message : t.command, tone)}>{view.message || view.tool.command}</span>;
}

function ListLook({ views, busy, onRun, picker }: LookProps) {
  return (
    <div className={t.list} role="list">
      {views.map((view) => (
        <div key={view.tool.id} role="listitem" className={t.listItem}>
          {picker(view.tool) ?? (
            <button type="button" className={t.listRow} onClick={() => onRun(view.tool)} disabled={busy || view.running} aria-label={runLabel(view)} aria-busy={view.running} title={view.tool.command}>
              <span className={t.runMark}>
                <Icon name="wrench" size={12} className={t.runIdle} />
                <Icon name="play" size={12} className={t.runGo} />
              </span>
              <span className={t.main}>
                <span className={t.name}>{view.tool.name}</span>
                <ToolLine view={view} />
              </span>
              {view.needsHost && !view.running && !view.result ? <span className={t.hint}>picks host</span> : null}
              <ToolStatus view={view} idle={<span className={t.runWord}>Run</span>} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function TilesLook({ views, busy, onRun, picker }: LookProps) {
  const picking = views.map((v) => picker(v.tool)).find(Boolean);
  return (
    <>
      <div className={t.tiles} role="list">
        {views.map((view) => (
          <button key={view.tool.id} type="button" role="listitem" className={cx(t.tile, view.running && t.tileLive)} onClick={() => onRun(view.tool)} disabled={busy || view.running} aria-label={runLabel(view)} aria-busy={view.running} title={view.tool.command}>
            <span className={t.tileHead}>
              <span className={t.runMark}>
                <Icon name="wrench" size={12} className={t.runIdle} />
                <Icon name="play" size={12} className={t.runGo} />
              </span>
              <span className={t.name}>{view.tool.name}</span>
              <ToolStatus view={view} />
            </span>
            <ToolLine view={view} />
          </button>
        ))}
      </div>
      {picking ? <div className={t.pickerBox}>{picking}</div> : null}
    </>
  );
}

function ChipsLook({ views, busy, onRun, picker }: LookProps) {
  const picking = views.map((v) => picker(v.tool)).find(Boolean);
  return (
    <>
      <div className={t.chips} role="list">
        {views.map((view) => (
          <Tip key={view.tool.id} label={view.message || view.tool.command}>
            <button type="button" role="listitem" className={cx(t.chip, view.running && t.tileLive)} onClick={() => onRun(view.tool)} disabled={busy || view.running} aria-label={runLabel(view)} aria-busy={view.running}>
              <ToolStatus view={view} idle={<Icon name="play" size={10} className={t.chipPlay} />} />
              <span className={t.name}>{view.tool.name}</span>
            </button>
          </Tip>
        ))}
      </div>
      {picking ? <div className={t.pickerBox}>{picking}</div> : null}
    </>
  );
}

const LOOK_VIEWS: Record<ToolboxLook, (props: LookProps) => React.JSX.Element> ={ list: ListLook, tiles: TilesLook, chips: ChipsLook };

/**
 * The project's Toolbox: named commands run without an agent. Each tool is a button that opens in
 * a Terminal tab; host-param tools show the SSH host dropdown before running. A tool shows the
 * last run's result until it runs again.
 */
export function HomeToolbox({ projectId, projectRoot }: { projectId: string; projectRoot: string }) {
  const api = useApi();
  const { ui, client } = useBeluga();
  const look = usePrefs().toolboxLook;
  const [tools, setTools] = useState<Tool[]>([]);
  const [hosts, setHosts] = useState<string[]>([]);
  const [hostFor, setHostFor] = useState<string | null>(null);
  const [hostValue, setHostValue] = useState("");
  const [startingId, setStartingId] = useState<string | null>(null);
  const terms = useApp((st) => ({ terminals: st.terminals, termExits: st.termExits, termReports: st.termReports }), sameFields);
  const late = useLateArrival(projectId, tools.length > 0);

  useEffect(() => {
    void api.toolbox.list(projectRoot).then((ts) => setTools(ts as Tool[]));
    void api.toolbox.sshHosts().then((hs) => setHosts(hs as string[]));
  }, [projectRoot]);

  if (!tools.length) return null;

  const runStateOf = (tool: Tool): ToolRunState | undefined => {
    const key = toolboxTermId(projectId, tool.id);
    if (!(key in terms.terminals)) return undefined;
    const report = terms.termReports[key];
    if (!(key in terms.termExits)) return { running: true, ...(report ? { report } : {}) };
    return { running: false, outcome: toolOutcome(terms.termExits[key] ?? null, report) };
  };

  const viewOf = (tool: Tool): ToolView => {
    const state = runStateOf(tool);
    const result = state && !state.running ? state.outcome : undefined;
    return {
      tool,
      running: startingId === tool.id || Boolean(state?.running),
      result,
      message: state?.running ? state.report?.message : result?.message,
      needsHost: (tool.params?.some((p) => p.kind === "host") ?? false) && hosts.length > 0,
    };
  };

  const run = (tool: Tool, params: Record<string, string> = {}): void => {
    setStartingId(tool.id);
    void api.toolbox.run(projectRoot, tool.id, params)
      .catch((err: unknown) => toast(client, err instanceof Error ? err.message : String(err), "error"))
      .finally(() => setStartingId(null));
  };

  const handleRun = (tool: Tool): void => {
    if (startingId !== null || runStateOf(tool)?.running) return;
    if (viewOf(tool).needsHost) {
      setHostFor(tool.id);
      setHostValue(hosts[0] ?? "");
      return;
    }
    run(tool);
  };

  const handleRunOnHost = (tool: Tool): void => {
    setHostFor(null);
    const hostParam = tool.params?.find((p) => p.kind === "host");
    run(tool, hostParam ? { [hostParam.name]: hostValue } : {});
  };

  const picker = (tool: Tool): React.ReactNode => {
    if (hostFor !== tool.id) return null;
    return (
      <div className={t.picker}>
        <Icon name="wrench" size={12} className={t.pickerIcon} />
        <span className={t.name}>{tool.name}</span>
        <Select className={t.hostSelect} value={hostValue} options={hosts.map((h) => ({ value: h, label: h }))} onChange={setHostValue} label="Host" />
        <Button size="small" disabled={startingId !== null} onClick={() => handleRunOnHost(tool)}>
          {startingId === tool.id ? <Working /> : "Run"}
        </Button>
        <Button size="small" variant="quiet" onClick={() => setHostFor(null)}>Cancel</Button>
      </div>
    );
  };

  const Look = LOOK_VIEWS[look];

  return (
    <Section
      arrive={late}
      title="Toolbox"
      count={tools.length}
      hint="Commands that run without an agent"
      bare
      action={
        <span className={t.actions}>
          <Segmented<ToolboxLook> value={look} options={LOOKS} onChange={(v) => setPrefs({ toolboxLook: v })} label="Toolbox look" iconOnly radio />
          <Button size="small" variant="quiet" icon="gear" onClick={() => ui.openMenu({ kind: "toolbox", projectId, projectRoot })}>
            Manage
          </Button>
        </span>
      }
    >
      <Look views={tools.map(viewOf)} busy={startingId !== null} onRun={handleRun} picker={picker} />
    </Section>
  );
}
