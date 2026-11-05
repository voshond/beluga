import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react';
import type { CallPersonView, CallView } from '@beluga/shared/calls.js';
import { callLength } from '@beluga/shared/calls.js';
import { Icon } from '../components/Icon.js';
import { Avatar, Tip, cx } from '../components/ui.js';
import { CallControls } from './CallStrip.js';
import { CallChatPops } from './ChatPops.js';
import { useCallEngine, useCallLive, useCallPlace, useSecond } from './use-call.js';
import c from './call.module.css';

/** A camera's picture, playing (yours mirrored, as a mirror would). */
function Picture({ stream, mirrored, className }: { stream: MediaStream; mirrored?: boolean; className?: string }) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    v.srcObject = stream;
    void v.play().catch(() => undefined);
  }, [stream]);
  return <video ref={video} className={cx(className, mirrored && c.mirrored)} autoPlay playsInline muted />;
}

/** One camera: the picture, the name, muted, a ring while they talk. */
function Tile({ person, stream, speaking, onOpen }: { person: CallPersonView; stream: MediaStream; speaking: boolean; onOpen?: () => void }) {
  const tile = (
    <figure className={cx(c.tile, speaking && !person.muted && c.tileSpeaking)} aria-label={person.me ? 'Your camera' : `${person.name}’s camera`}>
      <Picture stream={stream} mirrored={Boolean(person.me)} className={c.tileVideo} />
      <figcaption className={c.tileName}>
        {person.muted ? <Icon name="micOff" size={10} /> : null}
        {person.me ? 'You' : person.name}
      </figcaption>
    </figure>
  );
  if (!onOpen) return tile;
  return (
    <button type="button" className={c.tileButton} onClick={onOpen} aria-label={`Face to face with ${person.me ? 'everyone' : person.name}`}>
      {tile}
    </button>
  );
}

/**
 * The cameras that are on in a call (BLG-714): a band of faces under the call strip (a click on one
 * goes face to face), or, while someone shares their screen, a small filmstrip over its corner.
 */
export function CameraStrip({ call, floating }: { call: CallView; floating?: boolean }) {
  const engine = useCallEngine();
  const live = useCallLive();
  const on = call.people.filter((p) => live.cameras[p.peerId]);
  if (!on.length) return null;
  return (
    <div className={floating ? c.filmstrip : c.faces} role="list" aria-label="Cameras" onPointerDown={floating ? (e) => e.stopPropagation() : undefined}>
      {on.map((p) => (
        <div key={p.peerId} role="listitem" className={c.tileWrap}>
          <Tile person={p} stream={live.cameras[p.peerId]!} speaking={live.speaking.has(p.peerId)} {...(floating ? {} : { onOpen: () => engine.setFaces(true) })} />
        </div>
      ))}
      {floating ? null : (
        <Tip label="Face to Face">
          <button type="button" className={c.facesOpen} aria-label="Face to Face" onClick={() => engine.setFaces(true)}>
            <Icon name="expand" size={14} />
          </button>
        </Tip>
      )}
    </div>
  );
}

/** Someone without their camera on, in the collage: their picture, large, ringing as they talk. */
function NoCamera({ person, speaking }: { person: CallPersonView; speaking: boolean }) {
  return (
    <figure className={cx(c.faceTile, c.faceEmpty, speaking && !person.muted && c.tileSpeaking)} aria-label={person.name}>
      <Avatar name={person.name} id={person.peerId} size={88} />
      <figcaption className={c.tileName}>
        {person.muted ? <Icon name="micOff" size={10} /> : null}
        {person.name}
      </figcaption>
    </figure>
  );
}

type Corner = 'br' | 'bl' | 'tr' | 'tl';

/**
 * Face to face (BLG-714), like FaceTime: the call over the whole window. One other person fills
 * it; a group is a collage, everyone the same size. You're a small picture in a corner, which you
 * can drag to another one. The call's buttons sit at the bottom; Esc or Back to Chat comes back.
 */
export function FaceView({ call }: { call: CallView }) {
  const engine = useCallEngine();
  const live = useCallLive();
  const place = useCallPlace(call.conversation);
  const now = useSecond();
  const [corner, setCorner] = useState<Corner>('br');
  const [drag, setDrag] = useState<{ x: number; y: number } | undefined>();
  const start = useRef<{ px: number; py: number; x: number; y: number } | undefined>(undefined);
  const others = call.people.filter((p) => !p.me);
  const me = call.people.find((p) => p.me);
  const myCam = me ? live.cameras[me.peerId] : undefined;

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') engine.setFaces(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [engine]);

  const cols = Math.ceil(Math.sqrt(Math.max(1, others.length)));
  const rows = Math.ceil(Math.max(1, others.length) / cols);

  // Your picture follows the pointer, then settles into the nearest corner.
  const down = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const r = e.currentTarget.getBoundingClientRect();
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { px: e.clientX, py: e.clientY, x: r.left, y: r.top };
    setDrag({ x: r.left, y: r.top });
  };
  const move = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const s = start.current;
    if (s) setDrag({ x: s.x + e.clientX - s.px, y: s.y + e.clientY - s.py });
  };
  const up = (e: ReactPointerEvent<HTMLDivElement>): void => {
    start.current = undefined;
    const right = e.clientX > window.innerWidth / 2;
    const bottom = e.clientY > window.innerHeight / 2;
    setCorner(`${bottom ? 'b' : 't'}${right ? 'r' : 'l'}` as Corner);
    setDrag(undefined);
  };

  return (
    <section className={c.faceView} aria-label="Face to face">
      <header className={c.faceHead}>
        <strong>{place.replace(/^the room$/, 'The room')}</strong>
        <span>{callLength(now - call.startedAt)}</span>
      </header>
      <div className={cx(c.collage, others.length === 1 && c.solo)} style={{ gridTemplateColumns: `repeat(${cols}, 1fr)`, gridTemplateRows: `repeat(${rows}, 1fr)` }} role="list" aria-label="People in the call">
        {others.length ? (
          others.map((p) => {
            const stream = live.cameras[p.peerId];
            const speaking = live.speaking.has(p.peerId);
            return (
              <div key={p.peerId} role="listitem" className={c.collageCell}>
                {stream ? (
                  <figure className={cx(c.faceTile, speaking && !p.muted && c.tileSpeaking)} aria-label={`${p.name}’s camera`}>
                    <Picture stream={stream} className={c.faceVideo} />
                    <figcaption className={c.tileName}>
                      {p.muted ? <Icon name="micOff" size={10} /> : null}
                      {p.name}
                    </figcaption>
                  </figure>
                ) : (
                  <NoCamera person={p} speaking={speaking} />
                )}
              </div>
            );
          })
        ) : (
          <p className={c.faceWaiting}>Waiting for them to pick up</p>
        )}
      </div>
      {me ? (
        <div
          className={cx(c.pip, c[`pip_${corner}`], drag && c.pipDragging)}
          style={drag ? { left: drag.x, top: drag.y, right: 'auto', bottom: 'auto' } : undefined}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          aria-label="Your camera"
        >
          {myCam ? <Picture stream={myCam} mirrored className={c.faceVideo} /> : <Avatar name="You" id={me.peerId} size={48} />}
        </div>
      ) : null}
      {/* The whole window is faces: the chat pops up on the right. */}
      <CallChatPops conversation={call.conversation} place={place} dark className={c.faceRail} />
      <footer className={c.faceBar}>
        <CallControls call={call} />
        <button type="button" className={c.faceBack} onClick={() => engine.setFaces(false)}>
          <Icon name="chat" size={14} />
          Back to Chat
        </button>
      </footer>
    </section>
  );
}
