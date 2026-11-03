import { spawn } from 'node:child_process';

export interface ClipboardTool {
  readonly cmd: string;
  readonly args: readonly string[];
}

export const COPY: Record<string, readonly ClipboardTool[]> = {
  darwin: [{ cmd: 'pbcopy', args: [] }],
  win32: [{ cmd: 'clip', args: [] }],
  linux: [
    { cmd: 'wl-copy', args: [] },
    { cmd: 'xclip', args: ['-selection', 'clipboard'] },
    { cmd: 'xsel', args: ['--clipboard', '--input'] },
  ],
};

export const PASTE: Record<string, readonly ClipboardTool[]> = {
  darwin: [{ cmd: 'pbpaste', args: [] }],
  win32: [{ cmd: 'powershell', args: ['-NoProfile', '-Command', 'Get-Clipboard'] }],
  linux: [
    { cmd: 'wl-paste', args: ['--no-newline'] },
    { cmd: 'xclip', args: ['-selection', 'clipboard', '-o'] },
    { cmd: 'xsel', args: ['--clipboard', '--output'] },
  ],
};

/** A clipboard tool that hasn't answered by now never will (xclip can stay to serve what it copied). */
export const CLIPBOARD_TIMEOUT_MS = 3000;

/**
 * The tools that can work here: on Linux, Wayland's need its display and X's theirs, so a server
 * with no desktop has none (copying then goes to a screen, or into the chat) instead of each failing.
 */
export function clipboardTools(table: Record<string, readonly ClipboardTool[]>, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): readonly ClipboardTool[] {
  const tools = table[platform] ?? [];
  if (platform !== 'linux') return tools;
  return tools.filter((t) => (t.cmd.startsWith('wl-') ? Boolean(env.WAYLAND_DISPLAY) : Boolean(env.DISPLAY)));
}

export function run(tool: ClipboardTool, input?: string, timeoutMs = CLIPBOARD_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(tool.cmd, [...tool.args], { stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${tool.cmd} didn't answer`));
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stdin.on('error', () => undefined);
    child.on('error', (err) => (clearTimeout(timer), reject(err)));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${tool.cmd} exited ${code}`));
    });
    child.stdin.end(input ?? '');
  });
}

/** Copy using the OS clipboard tool only. Returns false when none is available. */
export async function copyNative(text: string): Promise<boolean> {
  for (const tool of clipboardTools(COPY)) {
    try {
      await run(tool, text);
      return true;
    } catch {
      // try the next tool
    }
  }
  return false;
}

/**
 * What a paste tool printed, as the clipboard holds it: PowerShell's Get-Clipboard (Windows) ends
 * every line with CRLF, the last one too, so that one line end goes. Other systems' tools print it as it is.
 */
export const pastedText = (out: string, platform: NodeJS.Platform = process.platform): string => (platform === 'win32' ? out.replace(/\r?\n$/, '') : out);

export async function pasteText(): Promise<string | undefined> {
  for (const tool of clipboardTools(PASTE)) {
    try {
      return pastedText(await run(tool));
    } catch {
      // try the next tool
    }
  }
  return undefined;
}
