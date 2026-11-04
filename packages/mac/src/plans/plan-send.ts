/**
 * Sending a message from the plan chat: its "[image N]" references become links to the images
 * (Beluga keeps them) and it goes to the plan's Claude. Resolves when it went; rejects with what to
 * say under the box otherwise. Retry sends the same message again: its images are expanded once
 * (the first time that works), and it carries one id, so a Retry of a message that reached Beluga
 * though its answer was lost isn't said in the chat, or asked of Claude, twice.
 */

export interface PlanSendApi {
  readonly attachments: { expand(text: string, channel: string, only?: number[], shown?: number[]): Promise<string> };
  /** False (or a rejection) when it didn't go. */
  readonly session: { submit(text: string, opts: { channel: string; id: string; urgent?: boolean }): Promise<boolean | void> };
  readonly questions: { answer(qid: string, answer: { kind: 'plan'; approve: false; feedback: string }): Promise<void> };
}

/** One message from the box, kept as is for Retry. */
export interface PlanMessage {
  readonly typed: string;
  readonly id: string;
  /** The images that went with it (only their "[image N]" become links). */
  readonly images?: readonly number[];
  /** The number each of `images` had in the box (its "[image N]" says it). */
  readonly shown?: readonly number[];
  /** What it says with its images expanded, once they were. */
  expanded?: string;
}

/** crypto.randomUUID only exists on HTTPS or localhost: the web port over plain HTTP (a LAN or Tailscale address) has none. */
export const messageId = (): string => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

export const planMessage = (typed: string, images?: readonly number[], shown?: readonly number[]): PlanMessage => ({ typed, id: messageId(), ...(images ? { images } : {}), ...(shown ? { shown } : {}) });

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export const hasImageRefs = (message: string): boolean => message.includes('[image ') && !message.startsWith('/');

/**
 * `urgent`: now, while Claude works (the plan's conversation is where you run everything from, so
 * by default your message doesn't wait behind a long turn): read at its next step, or a long
 * command is interrupted for it (the agent host's steer). `planQid`: Claude's plan waiting for
 * your approval here: Claude's run is held on that card, so what you type is what to change in
 * the plan (as in every message box), not a message the held run would never read.
 */
export async function sendPlanMessage(api: PlanSendApi, message: PlanMessage, channel: string, urgent = false, planQid?: string): Promise<void> {
  if (message.expanded === undefined) {
    let full = message.typed;
    if (hasImageRefs(full)) {
      try {
        full = await api.attachments.expand(full, channel, message.images && [...message.images], message.shown && [...message.shown]);
      } catch (err) {
        throw new Error(`Couldn't send the images: ${errorText(err)}`);
      }
    }
    message.expanded = full;
  }
  if (planQid && !message.expanded.startsWith('/')) {
    try {
      await api.questions.answer(planQid, { kind: 'plan', approve: false, feedback: message.expanded });
    } catch (err) {
      throw new Error(errorText(err));
    }
    return;
  }
  let went: boolean | void;
  try {
    went = await api.session.submit(message.expanded, { channel, id: message.id, ...(urgent ? { urgent: true } : {}) });
  } catch (err) {
    throw new Error(errorText(err));
  }
  if (went === false) throw new Error("The agent can't be asked here");
}
