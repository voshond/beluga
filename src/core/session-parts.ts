import { switchAgent } from './agent-switch.js';
import { runtimeChoices } from '../shared/agent-runtimes.js';
import type { SessionOptions, Session } from './session.js';
import { threadsOf } from './threads/launch.js';
import type { ModelChoice } from './work-store.js';
import { WorkspaceController } from './workspace-controller.js';
import { Notifier } from './notify.js';
import { Workbench } from './workbench.js';
import { QuestionBroker } from './questions.js';
import { RunAsks } from './run-asks.js';
import { readSshHosts } from './ssh-hosts.js';
import { WorkspaceSharing } from './workspace-sharing.js';
import { ReplayGuard } from './replay.js';
import { People } from './people.js';
import { RoomFiles } from './room-files.js';
import { AgentHost } from './agent-host.js';
import { StepBook } from './step-book.js';
import { RemoteWork } from './remote-work.js';
import { PeerRun } from './peer-run.js';
import { ProjectInvites } from './project-invites.js';
import { GuestShell } from './guest-shell.js';
import { SharedDiff } from './shared-diff.js';
import { EnvVars } from './env-vars.js';
import { LocalEndpoints } from './local-endpoints.js';
import { LOCAL_RUNTIME, localModels, localWhy } from '../shared/local-endpoints.js';
import { useViewEnv } from './views/sources.js';
import { boardOf } from './board/registry.js';
import { sentinelOf } from './sentinel/registry.js';
import { needPlans, plansOf } from './plans/registry.js';
import { assistantOf } from './assistant/registry.js';
import { companionOf } from '../companion/registry.js';
import { stopTestProcesses } from '../workspaces/test-procs.js';
import { ghRepoEnv } from '../workspaces/github.js';
import { AgentTerminals } from './agent-term.js';
import { claudeHome } from './claude-code/launch.js';
import { callNotesToolsOf } from './calls/launch.js';
import { toolboxOf } from './toolbox/registry.js';
import type { ToolboxTools } from '../agent/types.js';
import { guestPlace, sharedWorktreeBrief } from './shared-guest.js';
import { belugaHome } from './home.js';
import { peerName } from './store.js';

/** Everything a session is made of, wired to each other and to the session. */
export interface SessionParts {
  readonly workspaces?: WorkspaceController;
  readonly notifier: Notifier;
  readonly workbench?: Workbench;
  readonly questions: QuestionBroker;
  readonly runAsks: RunAsks;
  readonly sharing: WorkspaceSharing;
  readonly replay: ReplayGuard;
  readonly people: People;
  readonly files: RoomFiles;
  readonly host: AgentHost;
  readonly remote: RemoteWork;
  readonly peerRun: PeerRun;
  readonly invites: ProjectInvites;
  readonly shell: GuestShell;
  readonly diff: SharedDiff;
  /** Your environment variables (kept on this computer). */
  readonly env: EnvVars;
  readonly local: LocalEndpoints;
  /** The agent's own terminal on a conversation (BLG-534). */
  readonly agentTerms?: AgentTerminals;
}

export function createSessionParts(session: Session, opts: SessionOptions): SessionParts {
  let workspaces: WorkspaceController | undefined;
  let workbench: Workbench | undefined;
  const env = new EnvVars({ store: opts.store, onChange: () => workbench?.envChanged() });
  // Local endpoints (BLG-449) answer only where your agent runs (not in the demo).
  const listRuntimes = () =>
    runtimeChoices((id) => {
      if (id === (opts.runtime?.agent ?? 'claude')) return session.backend ? {} : undefined;
      if (id === LOCAL_RUNTIME) return opts.runtime?.runtimes('claude') && !localWhy(local.choices()) ? { models: localModels(local.choices()) } : undefined;
      return opts.runtime?.runtimes(id) || opts.alsoRuntimes?.some((r) => r.id === id) ? {} : undefined;
    });
  // Listed again with what each runtime last said about itself (BLG-507: a local endpoint answering never wipes Codex's sign-in state and models).
  const local = new LocalEndpoints({ endpoints: () => env.endpoints(), onChange: () => (workbench ? workbench.runtimesChanged() : opts.store.dispatch({ type: 'runtimes', runtimes: listRuntimes() })) });
  if (opts.runtime) local.start();
  // Database views find the project's connection string (its variables, its .env).
  useViewEnv({ database: (dir) => env.viewEnv(dir), commands: (dir) => env.envFor({ dir }) });
    const notifier = new Notifier({ store: opts.store, desktop: (n) => opts.desktopNotify?.(n), toast: (text, level) => session.toast(text, level) });
    if (opts.workspaces) {
      workspaces = new WorkspaceController({
        manager: opts.workspaces,
        store: opts.store,
        shares: opts.shares,
        selfId: () => session.selfId,
        // Your default agent's runtime: a place that picked none resumes only its sessions.
        defaultRuntime: () => opts.runtime?.agent ?? 'claude',
        defaultAgent: (project) => session.agentFor(project),
        toast: (text, level) => session.toast(text, level),
        intend: (intent) => session.intend(intent),
        askClaude: (prompt, channel, o) => (o?.terminal ? session.startInTerminal(prompt, channel, o.shown) : session.askOwnClaude(prompt, channel, false, o?.echo ?? true, o?.shown)),
        showAsk: (prompt, channel) => session.showAsk(prompt, channel),
        planHere: (channel) => void needPlans(session).here(channel),
        titleChat: (content) => session.titleChat(content),
        compact: (channel, instructions) => session.compact(channel, instructions),
        stopHere: async (channel) => {
          if (host.runningIn(channel)) host.stopRun(channel);
          await host.idle(channel);
        },
        endRuns: (channel, why) => host.endIn(channel, why),
        forgetContext: (channel) => host.forgetContext(channel),
        findConversation: opts.findConversation
          ? async (dir, o) => {
              const found = await opts.findConversation!(dir, { id: session.selfId, name: session.store.getState().self?.name ?? 'you' }, o);
              // Its steps in detail stay beside the chat (opened from the Claude cards).
              if (found?.steps) host.keepImported(found.sessionId, found.steps);
              return found;
            }
          : undefined,
        ...(opts.otherTools ? { otherTools: opts.otherTools } : {}),
        onWorktreeCreated: (ws) => workbench?.onWorktreeCreated(ws),
        onWorkspaceGoing: (id) => workbench?.closeTerminals(id),
        onWorktreeRestored: (ws, remake) => workbench?.onWorktreeRestored(ws, remake),
        env: { newKeysBack: (projectId) => env.newKeysBack(projectId), merge: (projectId, vars) => env.merge(projectId, vars), moveProject: (from, to) => env.moveProject(from, to) },
        runningIn: (channel) => host.runningIn(channel),
      });
    }
    if (workspaces) {
      workbench = new Workbench({
        store: opts.store,
        controller: workspaces,
        terminals: opts.terminals,
        notify: (e) => notifier.notify(e),
        toast: (text, level) => session.toast(text, level),
        intend: (intent) => session.intend(intent),
        askClaude: (prompt, channel) => session.askOwnClaude(prompt, channel),
        savedChats: (loaded) => assistantOf(session)?.savedChats(loaded) ?? [],
        loadSavedChat: (id) => assistantOf(session)?.loadSaved(id),
        setPrefs: (prefs) => session.setPrefs(prefs),
        confirm: (title, detail) => session.ask('request', title, detail),
        open: opts.open,
        listModels: async () => (await session.backend?.listModels?.()) as readonly ModelChoice[] | undefined,
        ...(opts.updateAgent ? { updateAgent: opts.updateAgent } : {}),
        switchAgent: (channel, agent, mode) =>
          switchAgent(
            {
              find: (id) => opts.workspaces?.find(id),
              setAgent: (id, a) => opts.workspaces?.setAgent(id, a),
              carry: (id, from) => opts.workspaces?.setCarry(id, from),
              askAndWait: (prompt, ch, ms) => session.askAndWait(prompt, ch, ms),
              start: (prompt, ch) => void session.askOwnClaude(prompt, ch, false, false),
              system: (ch, text, level) => session.store.dispatch({ type: 'system', channel: ch, text, level: level ?? 'info' }),
              log: () => session.store.getState().log,
              defaultAgent: () => session.agentRef,
              canResume: (id) => opts.runtime?.runtimes(id)?.capabilities.canResume ?? true,
            },
            channel,
            agent,
            mode,
          ),
        // Your agent's runtime runs here; another, when this Beluga registers it (the demo's agent is Claude).
        listRuntimes,
        // Your agents (Claude Code signed in? Codex installed and signed in?): only with the real runtimes (never the demo's or a test's).
        ...(opts.runtime
          ? {
              runtimeStatus: async () => (await import('../agent/runtime/registry.js')).runtimeStatuses(),
              signInCommand: async (id: string) => (await import('../agent/runtime/registry.js')).signInCommand(id),
            }
          : opts.alsoRuntimes?.some((r) => r.status)
            ? { runtimeStatus: () => Promise.all(opts.alsoRuntimes!.filter((r) => r.status).map(async (r) => ({ id: r.id, ...(await r.status!()) }))) }
            : {}),
        findPr: opts.findPr,
        hasGh: opts.hasGh,
        envFor: (where) => env.envFor(where),
        fixSetup: (dir, failed, output) => session.fixSetup(dir, failed, output),
        fixRun: (dir, failed, output) => session.fixRun(dir, failed, output),
        workOutScripts: (dir, want) => (session.worksOutScripts ? session.workOutScripts(dir, want) : undefined),
        hasClaude: () => session.hasAgent,
      });
    }
    const questions = new QuestionBroker({
      store: opts.store,
      selfId: () => session.selfId,
      send: (body, o) => session.send(body, o),
      timeoutMs: () => session.approvalTimeoutMs,
      toast: (text, level) => session.toast(text, level),
    });
    const runAsks = new RunAsks({
      store: opts.store,
      selfId: () => session.selfId,
      sshHosts: readSshHosts,
      answer: (qid, question, text) => questions.answerPart(qid, question, text),
    });
    const sharing = new WorkspaceSharing({
      store: opts.store,
      selfId: () => session.selfId,
      send: (body, o) => session.send(body, o),
      shares: opts.shares,
      workspaces: opts.workspaces,
      toast: (text, level) => session.toast(text, level),
      intend: (intent) => session.intend(intent),
    });
    const replay = new ReplayGuard(opts.replayFile);
    const people = new People({
      store: opts.store,
      selfId: () => session.selfId,
      saved: opts.savedPeople ?? {},
      save: (people) => opts.saveSettings?.({ people }),
      ...(opts.loadPeople ? { load: opts.loadPeople } : {}),
      toast: (text, level) => session.toast(text, level),
    });
    const files = new RoomFiles({
      store: opts.store,
      selfId: () => session.selfId,
      send: (body, o) => session.send(body, o),
      shares: opts.shares,
      toast: (text, level) => session.toast(text, level),
      system: (text, level) => session.system(text, level),
      requestTimeoutMs: opts.requestTimeoutMs,
      downloadDir: opts.downloadDir,
    });
    const host = new AgentHost({
      store: opts.store,
      selfId: () => session.selfId,
      send: (body, o) => session.send(body, o),
      agent: () => session.backend,
      agentRef: (channel) => (channel ? workspaces?.agentOf(channel, session.agentRef) : undefined) ?? session.agentRef,
      // A room ask that names one of your agents (BLG-520): the ones your card lists, and whether each runs here.
      agents: () => opts.client.currentProfile.agents ?? [],
      runsAgent: (agent) => session.runsAgent(agent),
      backendFor: (runtime) => session.backendFor(runtime),
      shares: opts.shares,
      sharing,
      people,
      questions,
      workspaces,
      toast: (text, level) => session.toast(text, level),
      system: (text, level) => session.system(text, level),
      approvalTimeoutMs: () => session.approvalTimeoutMs,
      refreshUsage: () => session.refreshUsage(),
      canEditIn: (peerId, channel) => invites.canEditIn(peerId, channel),
      // Claude's gh works on origin's repository, as Beluga does: a fork's own, not the original (yours win when set).
      envFor: (channel, dir) => ({ ...ghRepoEnv(dir), ...env.envFor(channel.startsWith('ws:') ? { workspaceId: channel.slice(3), dir } : { dir }, { claude: true }) }),
      dotenvAccess: env.dotenvAccess,
      stopTests: (dir) => stopTestProcesses(dir),
      nameTask: (prompt) => session.nameTask(prompt),
      steps: new StepBook(opts.stepsDir),
      isGuest: (peerId) => invites.isRestricted(peerId),
      board: (channel, from, o) => boardOf(session)?.forRun(channel, from, o),
      sentinel: (channel, from) => sentinelOf(session)?.forRun(channel, from),
      sentinelChat: (channel, from) => sentinelOf(session)?.chatPlace(channel, from),
      confirmTool: (toolName, input) => sentinelOf(session)?.confirmWords(toolName, input),
      plans: (channel, from, said) => plansOf(session)?.forRun(channel, from, said),
      threads: (channel) => threadsOf(session)?.forRun(channel),
      // "Your Mac"'s chats, and your own asks in friends' chats (BLG-207): both work in its folder.
      assistant: (channel, from) => assistantOf(session)?.forRun(channel, from) ?? assistantOf(session)?.forChat(channel, from),
      // Your "@claude" in a worktree a friend shared with you: your agent, here, reading theirs (core/shared-guest).
      guestRun: (channel, from) => {
        const ws = from === session.selfId ? sharing.sharedFor(channel) : undefined;
        return ws?.role === 'contribute' ? { place: guestPlace(belugaHome()), brief: sharedWorktreeBrief(ws, peerName(opts.store.getState(), ws.owner)) } : undefined;
      },
      phone: (scratchDir) => companionOf(session)?.control.toolsFor(scratchDir),
      callNotes: () => callNotesToolsOf(session),
      phoneUse: () => companionOf(session)?.control.useLevel() ?? 'off',
      setup: (channel) => workbench?.setupForRun(channel.slice(3)),
      terminalDriving: (channel) => agentTerms?.driving(channel) ?? false,
      toolbox: (channel) => {
        const service = toolboxOf(session);
        if (!service) return undefined;
        const wsId = channel.startsWith('ws:') ? channel.slice(3) : undefined;
        const root = wsId ? opts.store.getState().projects.find((p) => p.id === wsId || p.workspaces?.some((w) => w.id === wsId))?.root : undefined;
        if (!root) return undefined;
        const projectId = opts.store.getState().projects.find((p) => p.root === root)?.id ?? (wsId ?? channel);
        return {
          list: (projectRoot?: string) => {
            const r = projectRoot ?? root;
            const tools = service.list(r);
            if (!tools.length) return 'No Toolbox tools for this project.';
            return tools.map((t) => `${t.name}  [${t.id}]  ${t.command}  (${t.source})`).join('\n');
          },
          run: (nameOrId: string, params?: Readonly<Record<string, string>>, projectRoot?: string) => {
            const r = projectRoot ?? root;
            const all = service.list(r);
            const tool = all.find((t) => t.name === nameOrId || t.id === nameOrId);
            if (!tool) return Promise.reject(new Error(`No tool named "${nameOrId}" in this project. Use tool_list to see available tools.`));
            const termKey = service.run(r, projectId, tool.id, params ?? {});
            return `Running "${tool.name}" in terminal ${termKey}.`;
          },
          propose: (draft: { name: string; command: string; params?: Array<{ name: string; kind: 'host' | 'text' }>; projectRoot?: string; replaces?: string }) => {
            const r = draft.projectRoot ?? root;
            const replaced = draft.replaces ? service.list(r).find((t) => t.id === draft.replaces || t.name === draft.replaces) : undefined;
            if (draft.replaces && !replaced) return Promise.reject(new Error(`No tool "${draft.replaces}" to replace in this project. Use tool_list to see available tools.`));
            const id = `propose-${Date.now().toString(36)}`;
            opts.store.dispatch({ type: 'toolbox_suggestion_add', suggestion: { id, kind: 'propose', projectRoot: r, name: draft.name, command: draft.command, ...(draft.params ? { params: draft.params } : {}), ...(replaced ? { replaces: replaced.id } : {}), askedAt: Date.now() } });
            return replaced
              ? `Proposed an update to "${replaced.name}". It will appear as an "Update / Discard" card.`
              : `Proposed tool "${draft.name}". It will appear as a "Keep / Discard" card.`;
          },
        } satisfies ToolboxTools;
      },
      onBashCommand: (projectRoot, command) => {
        const service = toolboxOf(session);
        if (!service) return;
        const sig = service.recordBashCommand(projectRoot, command);
        if (!sig) return;
        opts.store.dispatch({ type: 'toolbox_suggestion_add', suggestion: { id: sig.id, kind: 'detection', projectRoot, name: sig.command.split(' ')[0] ?? sig.command, command: sig.command, count: sig.count, askedAt: sig.lastSeenMs } });
      },
    });
    const terminals = opts.terminals;
    const agentTerms =
      workspaces && workbench && terminals && opts.workspaces
        ? new AgentTerminals({
            store: opts.store,
            find: (id) => opts.workspaces?.find(id),
            ensureLoaded: (id) => void workspaces?.ensureLoaded(id),
            launch: (channel, sink, prompt) => host.terminalLaunch(channel, sink, prompt),
            openProgram: (key, ws, program, size) => workbench?.openProgram(key, ws, program, size),
            closeTerminal: (key) => workbench?.closeTerminal(key),
            pty: (key) => terminals.get(key),
            agentOf: (id) => {
              const agent = workspaces?.agentIn(`ws:${id}`) ?? session.agentRef;
              return { runtime: agent.runtime, label: agent.label };
            },
            rememberSession: (id, sessionId, runtime) => opts.workspaces?.rememberSession(id, sessionId, runtime),
            self: () => ({ id: session.selfId, name: session.store.getState().self?.name ?? 'you' }),
            keepSteps: (steps) => host.keepTerminalSteps(steps),
            claudeConfigDir: claudeHome(),
            saving: () => opts.store.getState().powerSaving,
          })
        : undefined;
    const remote = new RemoteWork({
      store: opts.store,
      selfId: () => session.selfId,
      send: (body, o) => session.send(body, o),
      request: (to, b) => files.request(to, b),
      shares: opts.shares,
      controller: workspaces,
      sharing,
      approve: (title, detail, peer) => session.ask('request', title, detail, peer).then((a) => a !== 'no'),
      runOnBehalf: (from, channel, prompt) => session.runOnBehalf(from, channel, prompt),
      runFor: (from, channel, prompt, plan) => session.runFor(from, channel, prompt, plan),
      askAndWait: (prompt, channel, timeoutMs) => session.askAndWait(prompt, channel, timeoutMs),
      askOwnClaude: (prompt, channel) => session.askOwnClaude(prompt, channel),
      nameTask: (prompt) => session.nameTask(prompt),
      notify: (e) => notifier.notify(e),
      toast: (text, level) => session.toast(text, level),
      intend: (intent) => session.intend(intent),
      onWorktreeCreated: (ws) => workbench?.onWorktreeCreated(ws),
      downloadDir: opts.downloadDir,
    });
    const peerRun = new PeerRun({
      store: opts.store,
      selfId: () => session.selfId,
      send: (body, o) => session.send(body, o),
      shares: opts.shares,
      controller: workspaces,
      agentCwd: opts.agentCwd,
      approve: (title, detail, peer) => session.ask('request', title, detail, peer),
      ...(opts.runShell ? { runShell: opts.runShell } : {}),
    });
    const invites: ProjectInvites = new ProjectInvites({
      store: opts.store,
      selfId: () => session.selfId,
      sharing,
      people,
      room: opts.room?.guests,
      toast: (text, level) => session.toast(text, level),
      system: (text, level) => session.system(text, level),
      copy: (text, success) => session.copyText(text, success),
      startInvite: opts.startInvite,
    });
    const diff = new SharedDiff({ store: opts.store, shares: opts.shares, sharing, manager: opts.workspaces, send: (body, o) => session.send(body, o), request: (to, b) => files.request(to, b) });
    const shell = new GuestShell({
      store: opts.store,
      listFiles: (at) => files.listFiles(at),
      openLocation: (at) => files.openLocation(at),
      search: (at, mode, query) => diff.search(at, mode, query),
    });
  return { workspaces, notifier, workbench, questions, runAsks, sharing, replay, people, files, host, remote, peerRun, invites, shell, diff, env, local, ...(agentTerms ? { agentTerms } : {}) };
}
