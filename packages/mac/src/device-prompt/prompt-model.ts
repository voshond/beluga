/** Words for the device approval window (DevicePrompt.tsx). */

type Asker = { readonly agent: string | null; readonly conversation: string | null };

export const askedBy = ({ agent, conversation }: Asker): string => {
  const who = agent ? `${agent} on your Beluga server` : 'An agent on your Beluga server';
  return conversation ? `${who} asks, from ${conversation}.` : `${who} asks.`;
};

export const secondsLeft = (expiresAt: number, now: number): number => Math.max(0, Math.ceil((expiresAt - now) / 1000));
