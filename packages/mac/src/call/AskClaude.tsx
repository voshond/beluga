import { type CSSProperties, useEffect, useRef, useState } from 'react';
import type { CallView } from '@beluga/shared/calls.js';
import type { MessageView } from '@beluga/net/mesh/views.js';
import { Icon } from '../components/Icon.js';
import { cx, personColor } from '../components/ui.js';
import { Markdown } from '../chat/Markdown.js';
import { useApp, useBeluga } from '../lib/beluga.js';
import { useMyAgentName } from '../lib/agent-words.js';
import { type Ink, draw } from './ink.js';
import { useCallEngine, useCallLive } from './use-call.js';
import c from './call.module.css';

/** A part of the shared picture, in fractions of it. */
export interface Region {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** The longest side of a picture sent to Claude: sharp enough to read code, small enough to send at once. */
const MAX_SIDE = 1800;

/** That part of the screen as it is now, with everyone's ink on it, as a PNG. */
export async function capture(video: HTMLVideoElement, region: Region, ink: Ink, colorOf: (peerId: string) => string): Promise<Blob> {
  const W = video.videoWidth;
  const H = video.videoHeight;
  if (!W || !H) throw new Error('The screen isn’t showing yet');
  const full = document.createElement('canvas');
  full.width = W;
  full.height = H;
  const g = full.getContext('2d')!;
  g.drawImage(video, 0, 0, W, H);
  // The ink, drawn at the picture's own size (the same fractions as on screen).
  const layer = document.createElement('canvas');
  layer.width = W;
  layer.height = H;
  draw(layer.getContext('2d')!, ink, { x: 0, y: 0, w: W, h: H }, performance.now(), colorOf, Math.max(1, W / 1200));
  g.drawImage(layer, 0, 0);
  const sx = Math.round(region.x * W);
  const sy = Math.round(region.y * H);
  const sw = Math.max(1, Math.round(region.w * W));
  const sh = Math.max(1, Math.round(region.h * H));
  const scale = Math.min(1, MAX_SIDE / Math.max(sw, sh));
  const out = document.createElement('canvas');
  out.width = Math.round(sw * scale);
  out.height = Math.round(sh * scale);
  out.getContext('2d')!.drawImage(full, sx, sy, sw, sh, 0, 0, out.width, out.height);
  return new Promise((resolve, reject) => out.toBlob((b) => (b ? resolve(b) : reject(new Error('Couldn’t take the picture'))), 'image/png'));
}

const base64 = async (blob: Blob): Promise<string> => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/** The question, beside the part you marked: Return asks, Esc lets it go. */
export function AskBox({ call, region, anchor, video, ink, sharer, done }: { call: CallView; region: Region; anchor: CSSProperties; video: HTMLVideoElement | null; ink: Ink; sharer: string; done: () => void }) {
  const { client } = useBeluga();
  const engine = useCallEngine();
  const me = useApp((st) => st.network.self?.peerId ?? '');
  const agent = useMyAgentName();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const whole = region.w >= 0.999 && region.h >= 0.999;
  const ask = async (): Promise<void> => {
    if (!video || busy) return;
    setBusy(true);
    try {
      const blob = await capture(video, region, ink, personColor);
      const file = await client.api.network['files.addData'](`${sharer === 'your' ? 'Your' : sharer.replace(/’s$/, '')} screen.png`, await base64(blob));
      const words = text.trim() || (whole ? 'What’s on this screen? Anything that looks wrong?' : 'What’s this part of the screen? Anything that looks wrong?');
      const sent = (await client.api.network.post(call.conversation, { text: `${words}\n\n_About ${sharer} shared screen, in the call._`, files: [file as never], ask: [me] })) as MessageView;
      engine.stageSend({ k: 'asked', by: me, ask: sent.id, box: [region.x, region.y, region.w, region.h] });
      done();
    } catch (err) {
      setBusy(false);
      client.store.dispatch({ type: 'toast', text: `Couldn’t ask: ${err instanceof Error ? err.message : String(err)}`, level: 'error' });
    }
  };
  const top = Number(anchor.top ?? 0) + Number(anchor.height ?? 0) + 8;
  const left = Number(anchor.left ?? 0);
  return (
    <form
      className={c.askBox}
      style={{ top: Math.min(top, 10_000), left }}
      onPointerDown={(e) => e.stopPropagation()}
      onSubmit={(e) => {
        e.preventDefault();
        void ask();
      }}
    >
      <Icon name="sparkles" size={14} className={c.askMark} />
      <input
        ref={input}
        value={text}
        disabled={busy}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            done();
          }
        }}
        placeholder={whole ? `Ask ${agent} about this screen…` : `Ask ${agent} about this part…`}
        aria-label={`Ask ${agent}`}
      />
      <button type="submit" className={c.askSend} disabled={busy} aria-label="Ask">
        {busy ? <span className={c.spinner} aria-hidden="true" /> : <Icon name="send" size={13} />}
      </button>
    </form>
  );
}

/**
 * What Claude says about the screen, on the stage for everyone in the call (each window gets the
 * ask on the data channel, and the answer is the chat's own message). Closing it only hides it here.
 */
export function AskCard({ call }: { call: CallView }) {
  const live = useCallLive();
  const agent = useMyAgentName();
  const [closed, setClosed] = useState<readonly string[]>([]);
  const ask = [...live.asks].reverse().find((id) => !closed.includes(id));
  const messages = useApp((st) => st.network.messages[call.conversation]);
  const thinking = useApp((st) => (ask ? (st.network.live?.[call.conversation] ?? []).some((l) => l.for === ask) : false));
  if (!ask) return null;
  const question = messages?.find((m) => m.id === ask);
  const answer = messages?.findLast((m) => m.claude?.for === ask);
  const asker = question ? (question.mine ? 'You' : question.name) : 'Someone';
  return (
    <aside className={cx(c.askCard, answer && c.askCardDone)} aria-live="polite" aria-label="Your agent about the screen">
      <header className={c.askHead}>
        <Icon name="claude" size={13} />
        <span>{answer ? `${agent}, for ${asker === 'You' ? 'you' : asker}` : thinking ? `${agent} is looking…` : `${asker} asked ${agent}`}</span>
        <button type="button" className={c.askClose} aria-label="Close" onClick={() => setClosed((x) => [...x, ask])}>
          <Icon name="x" size={12} />
        </button>
      </header>
      {answer ? (
        <div className={c.askBody}>
          <Markdown text={answer.text} />
        </div>
      ) : (
        <div className={c.askWait} aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      )}
    </aside>
  );
}
