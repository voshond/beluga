export const HONCHO_USER_PEER = 'user';

export const honchoId = (raw: string): string => raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 512) || '_';

export const agentPeerId = (runtime: string): string => honchoId(`agent-${runtime || 'claude'}`);

export const sessionIdOf = (channel: string): string => honchoId(`beluga-${channel}`);

export type PeerRole = 'user' | 'agent';

export const peerConfig = (role: PeerRole): { readonly observe_me: boolean; readonly observe_others: boolean } =>
  role === 'user' ? { observe_me: true, observe_others: false } : { observe_me: false, observe_others: false };
