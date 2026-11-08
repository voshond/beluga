import { formatBytes } from '../../../../src/shared/format.js';

/** What the device approval window shows (src-tauri/src/device.rs: Prompt), and its words. */

type Asked = {
  readonly id: string;
  readonly device: string;
  readonly conversation: string | null;
  readonly agent: string | null;
  readonly why: string;
  readonly expiresAt: number;
};

export type DevicePromptView = Asked &
  (
    | { readonly kind: 'run'; readonly cwd: string; readonly command: string; readonly timeoutSec: number }
    | { readonly kind: 'file'; readonly path: string; readonly size: number }
    | { readonly kind: 'screenshot' }
  );

export const headline = (prompt: DevicePromptView): string => {
  if (prompt.kind === 'run') return `Run this command on ${prompt.device}?`;
  if (prompt.kind === 'file') return `Send this file from ${prompt.device}?`;
  return `Send a screenshot of ${prompt.device}?`;
};

export const actionLabel = (prompt: DevicePromptView): string => (prompt.kind === 'run' ? 'Run' : 'Send');

export const askedBy = ({ agent, conversation }: Pick<Asked, 'agent' | 'conversation'>): string => {
  const who = agent ? `${agent} on your Beluga server` : 'An agent on your Beluga server';
  return conversation ? `${who} asks, from ${conversation}.` : `${who} asks.`;
};

export const sizeText = (bytes: number): string => (bytes < 1024 ? `${bytes} bytes` : `${formatBytes(bytes)} (${bytes.toLocaleString('en-US')} bytes)`);

export const secondsLeft =(expiresAt: number, now: number): number => Math.max(0, Math.ceil((expiresAt - now) / 1000));
