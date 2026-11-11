import { useEffect, useState } from "react";
import { type Tool, type ToolReport, toolOutcome } from "@beluga/workspaces/toolbox.js";
import { toolboxTermId } from "@beluga/shared/terminal-keys.js";
import { Icon } from "../../components/Icon.js";
import { Select } from "../../components/Select.js";
import { Button, Working } from "../../components/ui.js";
import { toast, useApi, useApp, useBeluga } from "../../lib/beluga.js";
import { useLateArrival } from "../../lib/last-seen.js";
import { sameFields } from "../../lib/stable.js";
import { Section } from "./HomeSection.js";
import { ToolRow, type ToolView } from "./HomeToolboxRow.js";
import t from "./home-toolbox.module.css";

/** Where a tool's last run is: still going, or how it ended (its exit code and its own `::beluga status=` line). */
type ToolRunState = { readonly running: true; readonly report?: ToolReport } | { readonly running: false; readonly outcome: ToolReport };

/**
 * The project's Toolbox: named commands run without an agent. A click runs one; its terminal
 * button runs it in a popup to watch (or shows the run that's there). Host-param tools ask for
 * the SSH host first. A row shows the last line its tool printed and how its last run ended.
 */
export function HomeToolbox({ projectId, projectRoot }: { projectId: string; projectRoot: string }) {
  const api = useApi();
  const { ui, client } = useBeluga();
  const [tools, setTools] = useState<Tool[]>([]);
  const [hosts, setHosts] = useState<string[]>([]);
  const [hostFor, setHostFor] = useState<{ id: string; watch: boolean } | null>(null);
  const [hostValue, setHostValue] = useState("");
  const [startingId, setStartingId] = useState<string | null>(null);
  const [watchingId, setWatchingId] = useState<string | null>(null);
  const [runs, setRuns] = useState<Readonly<Record<string, number>>>({});
  const terms = useApp((st) => ({ terminals: st.terminals, termExits: st.termExits, termReports: st.termReports, termTrails: st.termTrails }), sameFields);
  const late = useLateArrival(projectId, tools.length > 0);

  useEffect(() => {
    void api.toolbox.list(projectRoot).then((ts) => setTools(ts as Tool[]));
    void api.toolbox.sshHosts().then((hs) => setHosts(hs as string[]));
  }, [projectRoot]);

  if (!tools.length) return null;

  const runStateOf = (key: string): ToolRunState | undefined => {
    if (!(key in terms.terminals)) return undefined;
    const report = terms.termReports[key];
    if (!(key in terms.termExits)) return { running: true, ...(report ? { report } : {}) };
    return { running: false, outcome: toolOutcome(terms.termExits[key] ?? null, report) };
  };

  const viewOf = (tool: Tool): ToolView => {
    const termKey = toolboxTermId(projectId, tool.id);
    const state = runStateOf(termKey);
    const result = state && !state.running ? state.outcome : undefined;
    const report = state?.running ? state.report : result;
    return {
      tool,
      termKey,
      started: state !== undefined,
      running: startingId === tool.id || Boolean(state?.running),
      result,
      line: report?.message || terms.termTrails[termKey],
      needsHost: (tool.params?.some((p) => p.kind === "host") ?? false) && hosts.length > 0,
    };
  };

  const run = (tool: Tool, watch: boolean, params: Record<string, string> = {}): void => {
    setStartingId(tool.id);
    void api.toolbox.run(projectRoot, tool.id, params)
      .then(() => {
        setRuns((r) => ({ ...r, [tool.id]: (r[tool.id] ?? 0) + 1 }));
        if (watch) setWatchingId(tool.id);
      })
      .catch((err: unknown) => toast(client, err instanceof Error ? err.message : String(err), "error"))
      .finally(() => setStartingId(null));
  };

  const handleRun = (tool: Tool, watch: boolean): void => {
    if (startingId !== null || runStateOf(toolboxTermId(projectId, tool.id))?.running) return;
    if (viewOf(tool).needsHost) {
      setHostFor({ id: tool.id, watch });
      setHostValue(hosts[0] ?? "");
      return;
    }
    run(tool, watch);
  };

  const handleRunOnHost = (tool: Tool, watch: boolean): void => {
    setHostFor(null);
    const hostParam = tool.params?.find((p) => p.kind === "host");
    run(tool, watch, hostParam ? { [hostParam.name]: hostValue } : {});
  };

  return (
    <Section
      arrive={late}
      title="Toolbox"
      count={tools.length}
      hint="Commands that run without an agent"
      bare
      action={
        <Button size="small" variant="quiet" icon="gear" onClick={() => ui.openMenu({ kind: "toolbox", projectId, projectRoot })}>
          Manage
        </Button>
      }
    >
      <div className={t.list} role="list">
        {tools.map((tool) => hostFor?.id === tool.id ? (
          <div key={tool.id} role="listitem" className={t.listItem}>
            <div className={t.picker}>
              <Icon name="wrench" size={12} className={t.pickerIcon} />
              <span className={t.name}>{tool.name}</span>
              <Select className={t.hostSelect} value={hostValue} options={hosts.map((h) => ({ value: h, label: h }))} onChange={setHostValue} label="Host" />
              <Button size="small" disabled={startingId !== null} onClick={() => handleRunOnHost(tool, hostFor.watch)}>
                {startingId === tool.id ? <Working /> : "Run"}
              </Button>
              <Button size="small" variant="quiet" onClick={() => setHostFor(null)}>Cancel</Button>
            </div>
          </div>
        ) : (
          <ToolRow
            key={tool.id}
            view={viewOf(tool)}
            run={runs[tool.id] ?? 0}
            busy={startingId !== null}
            watching={watchingId === tool.id}
            onWatch={(open) => setWatchingId(open ? tool.id : null)}
            onRun={(watch) => handleRun(tool, watch)}
          />
        ))}
      </div>
    </Section>
  );
}
