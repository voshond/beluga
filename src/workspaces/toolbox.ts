import { z } from 'zod';

/**
 * A named, parameterized command saved in a project's Toolbox (BLG-75). Personal tools live in
 * projects.json; team tools shared via beluga.json need approval before their first run.
 */

export const TOOLBOX_PARAM_KINDS = ['host', 'text'] as const;
export type ToolParamKind = (typeof TOOLBOX_PARAM_KINDS)[number];

export interface ToolParam {
  readonly name: string;
  readonly kind: ToolParamKind;
}

export type ToolSource = 'personal' | 'team';

export interface Tool {
  readonly id: string;
  readonly name: string;
  /** May contain {{param}} placeholders that are shell-quoted on substitution. */
  readonly command: string;
  readonly params?: readonly ToolParam[];
  readonly source: ToolSource;
  /** Set for tools an agent proposed (tool_propose). */
  readonly createdBy?: 'claude';
  readonly createdAt: number;
}

export interface ToolDraft {
  readonly name: string;
  readonly command: string;
  readonly params?: readonly ToolParam[];
  readonly source?: ToolSource;
  readonly createdBy?: 'claude';
}

export type ToolPatch = Partial<Pick<Tool, 'name' | 'command' | 'params' | 'source'>>;

/**
 * A command signature the detection sees repeated 3+ times in 14 days. When still pending (not
 * dismissed and not yet made into a tool), it shows as a NeedsYou card.
 */
export interface ToolboxSig {
  readonly id: string;
  readonly projectRoot: string;
  readonly command: string;
  readonly count: number;
  readonly firstSeenMs: number;
  readonly lastSeenMs: number;
}

/** Shell-quote a single value for POSIX sh (safe inside a double-quoted or unquoted context). */
export function shellQuote(value: string): string {
  if (!value) return "''";
  if (/^[A-Za-z0-9@%+=:,./-]+$/.test(value)) return value;
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/**
 * Substitute {{param}} placeholders in a command string, shell-quoting each substituted value so
 * it is safe to pass verbatim to sh -c.
 */
export function substituteParams(command: string, params: Readonly<Record<string, string>>): string {
  return command.replace(/\{\{([^}]+)\}\}/g, (match, raw: string) => {
    const name = raw.trim();
    const value = params[name];
    if (value === undefined) return match;
    return shellQuote(value);
  });
}

/** All distinct param names from {{…}} in a command string, in order of first appearance. */
export function extractParamNames(command: string): string[] {
  const seen = new Set<string>();
  for (const m of command.matchAll(/\{\{([^}]+)\}\}/g)) {
    seen.add(m[1]!.trim());
  }
  return [...seen];
}

/** A stable signature of a Bash command for detection: strip absolute paths and known hosts. */
export function normalizeCommandSig(command: string): string {
  return command
    .replace(/\/(?:home|Users|root)\/[^\s/]+/g, '~')
    .replace(/\b(?:arch|m1arch|nas|i9arch)\b/g, '<host>')
    .trim()
    .slice(0, 200);
}

export const TOOL_REPORT_STATUSES = ['success', 'warn', 'fail'] as const;
export type ToolReportStatus = (typeof TOOL_REPORT_STATUSES)[number];

/** What a tool's script said about its own result, from a `::beluga status=<status> <message>` line. */
export interface ToolReport {
  readonly status: ToolReportStatus;
  readonly message: string;
}

const REPORT_LINE = /^::beluga\s+status=(success|warn|fail)(?:\s+(.*))?$/;
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g;

/** The report in one line of terminal output, or undefined when the line is not a marker. */
export function parseToolReport(line: string): ToolReport | undefined {
  const match = REPORT_LINE.exec(line.replace(ANSI, '').trim());
  if (!match) return undefined;
  return { status: match[1] as ToolReportStatus, message: (match[2] ?? '').trim().slice(0, 200) };
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/g;

/** The text one line of a tool's output shows last (a progress bar redraws after `\r`), or undefined when blank or a marker. */
export function toolTrailLine(line: string): string | undefined {
  const shown = line.replace(ANSI, '').split('\r').map((part) => part.replace(CONTROL, '').trim()).filter(Boolean).pop();
  if (!shown || parseToolReport(shown)) return undefined;
  return shown.slice(0, 200);
}

/**
 * How a tool's last run ended. A non-zero exit always fails; otherwise the script's own report
 * decides, and a run that reported nothing succeeded.
 */
export function toolOutcome(code: number | null, report: ToolReport | undefined): ToolReport {
  if (code !== 0) return { status: 'fail', message: report?.status === 'fail' && report.message ? report.message : `exit ${code ?? '?'}` };
  return report ?? { status: 'success', message: '' };
}

// ---- Zod schemas (browser-safe: zod only)

const ToolParamSchema = z.object({
  name: z.string().min(1).max(40),
  kind: z.enum(TOOLBOX_PARAM_KINDS),
});

export const ToolSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().min(1).max(100),
  command: z.string().min(1).max(2000),
  params: z.array(ToolParamSchema).max(10).optional(),
  source: z.enum(['personal', 'team'] as const),
  createdBy: z.literal('claude').optional(),
  createdAt: z.number().int(),
});

export const ToolDraftSchema = z.object({
  name: z.string().trim().min(1).max(100),
  command: z.string().trim().min(1).max(2000),
  params: z.array(ToolParamSchema).max(10).optional(),
  source: z.enum(['personal', 'team'] as const).optional(),
  createdBy: z.literal('claude').optional(),
});

export const ToolPatchSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  command: z.string().trim().min(1).max(2000).optional(),
  params: z.array(ToolParamSchema).max(10).optional(),
  source: z.enum(['personal', 'team'] as const).optional(),
});
