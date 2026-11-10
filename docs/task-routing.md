# Routed task runs (BLG-82) — design

Plans already run like an orchestra: a head agent routes, one agent per milestone builds, a checker
checks, a fixer fixes conflicts (`docs/tasks-and-plans.md` § 3). A task run outside a plan was still
one agent on one model doing everything. This page compares our plan orchestrator with DeepSeek's
dsh-superagent prototype, says which parts carry over to every task run, and describes the first
version: **Settings › Experimental › Routed task runs** (experiment id `routing`).

## 1. Findings: our plan orchestrator next to dsh-superagent

dsh-superagent (research prototype, `deepseek-ai/dsh-superagent-prototype`) is a GitHub/Feishu
listener: a **main Session (router)** admits requests and routes them to Tickets; each Ticket gets
an **Executor Session (worker)** with its own directory, which investigates, builds and opens the PR.

| Concern | dsh-superagent | Beluga plans (`src/core/plans/`) | Beluga task runs before BLG-82 |
|---|---|---|---|
| Who routes | Main Session, `prompts/orchestrator.md`: never plans implementation, never reads code, forwards the original words | Head agent, `ORCHESTRATOR` in `prompt.ts` (BLG-5): routes words and work, edits no files | Nobody: the task's agent does it all |
| Who works | One Executor per Ticket, own Session and directory | One agent per milestone, own worktree (BLG-7) | One agent per task, own worktree |
| Who plans the work | The worker ("workers derive requirements from the original source") | The planner writes milestones and tasks up front; the milestone agent orders its tasks | The agent, in its head |
| Model per role | `RoleModel` per role (`eval.model`, `executor.model`), seeded on a new session only (`role-models.ts`) | One agent (and model) for the whole plan (BLG-497); no per-role model | The conversation's model, else the agent's, else Settings' |
| Reports | Structured `orchestrator_report`: progress / ready / blocked / failed / dropped | `plan_gate` for checks, board status for tasks | Board status, handoff |
| Asking a person | `human_action`: one concrete question, routed to where it was raised | `plan_ask` cards (BLG-6) | AskUserQuestion |
| Out-of-scope work | `orchestrator_trigger_handback` | `plan_handback` (BLG-7) | `task_create` (a sub-task) |
| Verification | Worker self-reviews, CI and human review | A fresh checker per milestone with only `plan_get` / `plan_gate` | The same agent checks its own work |
| Concurrency | Worker slots with one spare for a person | *Run at Once* per plan | One run per conversation |
| Stalls | Retries transient failures 3×, then blocked | Rescue ladder (BLG-473), watchdog | Watchdog nudge (autopilot only) |

What we had already taken: router-does-no-work (BLG-5), one structured question (BLG-6), hand-back
(BLG-7), clarify first (BLG-8). What we had **not** taken: a model per role. The prototype only
configures it statically; neither picks it from the work.

## 2. What carries over to a normal task run

A task is one unit of reviewable work in one worktree, so the plan's *between-tasks* machinery
(milestones, gates on merges, the plan branch, the fixer, the rescue ladder) does not apply. What
does apply is the *inside-a-task* split:

| Plan-mode part | In a task run | Why |
|---|---|---|
| Head agent routes, doesn't build | **Yes**: the task's agent becomes its orchestrator: understands, cuts steps, routes them, signs off | The expensive model's judgment is spent where it counts |
| Agents per unit of work | **Yes, as subagents** in the same worktree (`beluga-builder`) | A new conversation per step would lose context and add daemon state; Claude Code subagents run in the same folder and report back |
| Fresh checker | **Yes**: `beluga-checker`, read-only, a different model from the builder | Same reason as plans: the one who built it isn't the one who checks it |
| Structured reports | **Yes**: builders end with `done` / `blocked` / `failed` + changes + checks run (prototype's report states) | The orchestrator can route on the first line |
| Ask one question, hand back extra work | **Yes, kept with the orchestrator**: workers never ask the user and never touch the board | One voice to the user, as in the prototype |
| Milestones, gates, plan branch, fixer, rescue ladder | No | They coordinate several tasks; a task is one |
| Clarify first | Already in the task brief flow | — |

## 3. Choosing the model and routing each step

### The orchestrator's model: sized from the task

`taskSize` (`src/core/board/routing.ts`) reads what the board already knows:

| Size | When | Orchestrator | Builder | Scout | Checker |
|---|---|---|---|---|---|
| small | none of below | Sonnet, effort medium | Haiku | Haiku | Haiku |
| medium | estimate ≥ 2, or ≥ 3 acceptance criteria, or label `feature` / `bug` / `design` | Opus, effort medium | Sonnet | Haiku | Haiku |
| large | estimate ≥ 5, or ≥ 6 criteria, or label `important` | Opus, effort high | Sonnet | Haiku | Sonnet |

The rule: the orchestrator sits a tier above the builder; reading the code is always the cheapest
tier; checking matches the builder only when the work is big. Models are Claude Code aliases
(`haiku`, `sonnet`, `opus`), so they follow the newest model of each family.

**Who wins:** a model picked for the conversation (the picker) or set on the agent always wins
and turns routing off for that run; an effort picked for the conversation wins over the routed
effort. Only Claude runs are routed (other runtimes have no subagent model choice). A message sent
into a live routed run keeps the orchestrator's model unless you pick one meanwhile.

### Routing each step

The orchestrator is told (`routingBrief`, instruction piece `routing`):

1. **Understand**: read the brief; send `beluga-scout` to find files, current behaviour and tests
   instead of reading widely itself.
2. **Plan**: steps a person could review one by one, as its todo list.
3. **Route**: `beluga-builder` for a step with a clear spec; itself for a step needing judgment
   (an interface, a design decision, a subtle bug, a cross-cutting change) or one a builder failed
   twice. Steps on different files may run side by side.
4. **Brief fully**: files, decisions, the criteria served, the checks to run. Never resend a
   blocked or failed brief unchanged.
5. **Verify**: `beluga-checker` with the criteria and checks, then it reads the diff itself, ticks
   criteria, writes the handoff and commits.

A one-line fix needs no routing. The workers (`workerAgents`) are SDK `agents` definitions: the
scout and checker cannot Edit/Write; no worker has the board tools (`mcp__beluga_board`).

## 4. The first version (shipped here)

```text
BoardWork.forRun ── route (taskSize) ──▶ AgentHost.runAgent
                                           │ experiment `routing` on, your own Claude run,
                                           │ no model picked → routedRun(route)
                                           ▼
                         AgentRunInput { model, effort, routing: { brief, agents } }
                                           ▼
             Claude runner: options.agents = sdkAgents(routing); brief via run-instructions
```

- `src/core/board/routing.ts`: sizing, routes, the brief, the worker definitions.
- `src/core/board/work.ts`: `RunBoard.route` for a worktree doing a task (not plan runs, not friends).
- `src/core/agent-host.ts`: `routedFor` decides; `lane.routedModel` keeps follow-ups on it.
- `src/agent/runtime/claude/runner.ts`: `sdkAgents` → `Options.agents`.
- `src/shared/experiments.ts`: the `routing` experiment (the Mac's Experimental pane lists it by itself).
- Tests: `tests/task-routing.test.ts`, `tests/board-work.test.ts`.

No new API method, no protocol change, nothing on the phone.

## 5. Next

- Route plan milestone agents the same way (the plan's own agent choice, BLG-497, decides the tier).
- Learn the sizes: record per run which tier did which step and its cost (`usageOf` already sums
  per model) and tune the thresholds from it.
- A per-project override of the tier table (Settings › Agents), only if one table doesn't suit.
- Show the routed model on the conversation's model chip ("Auto · Opus").
