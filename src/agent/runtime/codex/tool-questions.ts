import { z } from 'zod';
import { type ToolSuite, toolName } from '../../tool-kit.js';

/**
 * Codex asks before it calls an MCP tool that does not say it only reads, with
 * `mcpServer/elicitation/request`. These shapes are from a real codex-cli 0.163 and its
 * generate-json-schema. An elicitation that does not match them exactly is a server's own question
 * to the user, and Beluga does not answer it.
 */
export const ELICITATION = 'mcpServer/elicitation/request';

const MCP_TOOL_CALL = 'mcp_tool_call';
const ASKS_TOOL = /^Allow the (.+) MCP server to run tool "([^"]+)"\?$/;

export interface McpToolCall {
  /** The tool as Beluga's gate names it: `mcp__<server>__<tool>`. */
  readonly name: string;
  readonly server: string;
  readonly tool: string;
  readonly args: Record<string, unknown>;
}

/** The tool call that this elicitation asks about. Undefined: it is something else. */
export function mcpToolCallOf(params: Record<string, unknown>): McpToolCall | undefined {
  const meta = isRecord(params._meta) ? params._meta : undefined;
  if (params.mode !== 'form' || meta?.codex_approval_kind !== MCP_TOOL_CALL || !isRecord(meta.tool_params)) return undefined;
  // A form with fields asks the user for data. A question about a tool call has none.
  const schema = params.requestedSchema;
  if (!isRecord(schema) || !isRecord(schema.properties) || Object.keys(schema.properties).length) return undefined;
  const asked = typeof params.message === 'string' ? ASKS_TOOL.exec(params.message) : undefined;
  if (!asked || asked[1] !== params.serverName) return undefined;
  return { name: toolName(asked[1]!, asked[2]!), server: asked[1]!, tool: asked[2]!, args: meta.tool_params };
}

/**
 * The arguments as the tool server will give them to its gate, with the schema's defaults. Codex
 * asks with what the model wrote. Undefined: this tool is not on Beluga's servers for this run, or
 * the arguments do not fit, so the tool server will not take the call as this one.
 */
export function argsOnServer(suites: Readonly<Record<string, ToolSuite>>, call: McpToolCall): Record<string, unknown> | undefined {
  const def = suites[call.server]?.tools.find((t) => t.name === call.tool);
  const parsed = def ? z.object(def.inputSchema).safeParse(call.args) : undefined;
  return parsed?.success ? parsed.data : undefined;
}

/**
 * The calls that passed the gate when Codex asked about them. The tool server's gate takes each one
 * when the call arrives, so that one call does not ask you two times. One pass is good for one call
 * with the same name and arguments. Any other call goes through the gate again.
 */
export class GatePasses {
  private readonly passes = new Map<string, number>();

  add(name: string, args: Record<string, unknown>): void {
    const key = keyOf(name, args);
    this.passes.set(key, (this.passes.get(key) ?? 0) + 1);
  }

  take(name: string, args: Record<string, unknown>): boolean {
    const key = keyOf(name, args);
    const left = this.passes.get(key) ?? 0;
    if (!left) return false;
    if (left === 1) this.passes.delete(key);
    else this.passes.set(key, left - 1);
    return true;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The same key for the same arguments, whatever order their fields come in. */
function keyOf(name: string, args: Record<string, unknown>): string {
  return `${name}\n${JSON.stringify(sorted(args))}`;
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sorted(value[k])]));
}
