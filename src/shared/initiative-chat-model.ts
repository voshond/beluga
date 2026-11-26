/** Chats an initiative runs on its own (Check-in, Follow-ups): Settings' initiative model unless the chat picked one. */
export const BACKGROUND_INITIATIVE_CHATS: readonly string[] = ['checkin', 'watch'];

/**
 * The model an initiative chat runs on: its own pick, else (Check-in and Follow-ups, when your agent
 * is Claude) Settings' initiative model. Undefined: your default, as any conversation. Browser-safe.
 */
export const initiativeChatModel = (chat: string, own: string | undefined, runtime: string, initiativeModel: string | undefined): string | undefined => {
  if (own) return own;
  if (!BACKGROUND_INITIATIVE_CHATS.includes(chat) || runtime !== 'claude') return undefined;
  return initiativeModel || undefined;
};
