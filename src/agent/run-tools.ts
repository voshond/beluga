import { createBoardTools } from './board-tools.js';
import { createCallNotesTools } from './call-notes-tools.js';
import { createDashboardTools } from './dashboard-tools.js';
import { createMacTools } from './mac-tools.js';
import { createPhoneTools } from './phone-tools.js';
import { createPlanTools } from './plan-tools.js';
import { createSentinelTools } from './sentinel-tools.js';
import { createTaskTools } from './task-tools.js';
import type { ToolSuite } from './tool-kit.js';
import { createRoomTools } from './tools.js';
import type { AgentRunInput, RoomBridge } from './types.js';
import { type ViewShelf, createViewTools } from './view-tools.js';

/**
 * Beluga's tools for one run, by server name: the one registry both mounts serve (Claude's
 * in-process servers, the stdio server for any other runtime). Which suites a run gets is decided
 * here alone, from its input.
 */
export function runToolSuites(input: AgentRunInput, bridge: RoomBridge, shelf: ViewShelf, cwd: string): Record<string, ToolSuite> {
  const askOnly = input.place?.askOnly;
  // A friend's task brings the tools its owner allowed (the screen, device info) as a server of their own.
  const task = input.taskTools ? createTaskTools(input.taskTools) : undefined;
  return {
    beluga: createRoomTools(bridge, askOnly ? input.continueInWorktree : undefined, askOnly ? undefined : input.setup, input.dialogue),
    ...(task ? { beluga_task: task } : {}),
    // Your own runs get the task board (core/board): the task they're doing, and tools to keep it true.
    ...(input.board ? { beluga_board: createBoardTools(input.board) } : {}),
    // Your own runs get sentinels (core/sentinel): list, set up, run, pause; inside a run, stop it.
    ...(input.sentinelTools ? { beluga_sentinel: createSentinelTools(input.sentinelTools) } : {}),
    ...(input.dashboardTools ? { beluga_dashboard: createDashboardTools(input.dashboardTools) } : {}),
    // A plan's home conversation gets the plan's tools (core/plans).
    ...(input.planTools ? { beluga_plan: createPlanTools(input.planTools) } : {}),
    // "Your Mac" gets its own tools (core/assistant).
    ...(input.macTools ? { beluga_mac: createMacTools(input.macTools) } : {}),
    // Your own runs can drive your phone (core/phone, BLG-150).
    ...(input.phoneTools ? { beluga_phone: createPhoneTools(input.phoneTools) } : {}),
    // Your own runs can look up what was said in calls you were in (core/calls, BLG-715).
    ...(input.callNotesTools ? { beluga_calls: createCallNotesTools(input.callNotesTools) } : {}),
    beluga_view: createViewTools(shelf, cwd),
  };
}
