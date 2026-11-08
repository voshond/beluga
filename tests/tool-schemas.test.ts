import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createBoardToolDefs } from '../src/agent/board-tools.js';
import { createDashboardToolDefs } from '../src/agent/dashboard-tools.js';
import { createGatewayToolDefs } from '../src/agent/gateway-tools.js';
import { createMacToolDefs } from '../src/agent/mac-tools.js';
import { createPhoneToolDefs } from '../src/agent/phone-tools.js';
import { createPlanToolDefs } from '../src/agent/plan-tools.js';
import { createSentinelToolDefs } from '../src/agent/sentinel-tools.js';
import { createThreadToolDefs } from '../src/agent/thread-tools.js';
import { createTaskToolDefs } from '../src/agent/task-tools.js';
import { createRoomToolDefs } from '../src/agent/tools.js';
import { fromToolDraft } from '../src/core/sentinel/sentinels.js';

/**
 * A tool whose input can't become JSON Schema (a preprocess, a transform, a z.custom) is dropped
 * from Claude's tools without a word: sentinel_create and sentinel_update went missing that way.
 */

// Stands in for every bridge: the factories only keep it, these tests never call a handler.
const any: never = new Proxy(function () {}, { get: (_t, p) => (p === 'then' ? undefined : any), apply: () => any }) as never;

const SERVERS = {
  beluga: [...createRoomToolDefs(any), ...createGatewayToolDefs(any)],
  beluga_board: createBoardToolDefs(any),
  beluga_dashboard: createDashboardToolDefs(any),
  beluga_mac: createMacToolDefs(any),
  beluga_phone: createPhoneToolDefs(any),
  beluga_plan: createPlanToolDefs(any),
  beluga_sentinel: createSentinelToolDefs(any),
  beluga_task: createTaskToolDefs(any),
  beluga_threads: createThreadToolDefs(any),
};

describe('every tool Claude is given has an input JSON Schema can say', () => {
  for (const [server, defs] of Object.entries(SERVERS)) {
    it(server, () => {
      const broken = (defs as Array<{ name: string; inputSchema: z.ZodRawShape }>).filter((d) => {
        try {
          z.toJSONSchema(z.object(d.inputSchema));
          return false;
        } catch {
          return true;
        }
      });
      expect(broken.map((d) => d.name)).toEqual([]);
    });
  }

  it('sentinel_create and sentinel_update are there', () => {
    expect(SERVERS.beluga_sentinel.map((d) => d.name)).toEqual(expect.arrayContaining(['sentinel_create', 'sentinel_update']));
  });

  it('a Keep the numbers step from Claude is still read for real: a bare command, a currency unit', () => {
    const d = fromToolDraft({
      name: 'Subscribers',
      trigger: { kind: 'manual' },
      steps: [{ kind: 'measure', name: 'Count', from: 'source', source: 'echo 42', metrics: [{ name: 'subscribers', unit: 'currency:USD' }] }],
    } as never);
    expect(d.steps?.[0]).toMatchObject({ kind: 'measure', source: { kind: 'command', command: 'echo 42' }, metrics: [{ name: 'subscribers', unit: 'currency:USD' }] });
  });
});
