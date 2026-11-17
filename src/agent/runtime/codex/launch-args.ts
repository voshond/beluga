export type CodexLaunch = {
  readonly fullAccess: boolean;
  readonly neverAsks: boolean;
};

const BYPASS = new Set(['--dangerously-bypass-approvals-and-sandbox', '--yolo']);
const SANDBOX = new Set(['-s', '--sandbox']);
const APPROVAL = new Set(['-a', '--ask-for-approval']);
const CONFIG = new Set(['-c', '--config']);

export const codexLaunch = (args: readonly string[]): CodexLaunch => {
  let fullAccess = false;
  let neverAsks = false;
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = splitFlag(args[i]!);
    const value = unquote(inline ?? args[i + 1] ?? '');
    if (BYPASS.has(flag)) {
      fullAccess = true;
      neverAsks = true;
      continue;
    }
    if (SANDBOX.has(flag) && value === 'danger-full-access') fullAccess = true;
    if (APPROVAL.has(flag) && value === 'never') neverAsks = true;
    if (!CONFIG.has(flag)) continue;
    const [key, setting] = splitAt(value, '=');
    if (key.trim() === 'sandbox_mode' && unquote(setting) === 'danger-full-access') fullAccess = true;
    if (key.trim() === 'approval_policy' && unquote(setting) === 'never') neverAsks = true;
  }
  return { fullAccess, neverAsks };
};

const splitFlag = (arg: string): [string, string | undefined] => {
  const at = arg.indexOf('=');
  return at > 0 && arg.startsWith('--') ? [arg.slice(0, at), arg.slice(at + 1)] : [arg, undefined];
};

const splitAt = (text: string, sep: string): [string, string] => {
  const at = text.indexOf(sep);
  return at < 0 ? [text, ''] : [text.slice(0, at), text.slice(at + 1)];
};

const unquote = (text: string): string => text.trim().replace(/^["']|["']$/g, '');
