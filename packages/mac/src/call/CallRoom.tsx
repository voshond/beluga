import { type ReactNode, useEffect } from 'react';
import { cx } from '../components/ui.js';
import { CallStrip } from './CallStrip.js';
import { Stage } from './Stage.js';
import { CameraStrip, FaceView } from './Cameras.js';
import { NotesBox, NotesReaderFor } from './NotesBox.js';
import { useCallPlace } from './use-call.js';
import { useApp } from '../lib/beluga.js';
import { useCallEngine, useCallLive, useConversationCall } from './use-call.js';
import c from './call.module.css';

/**
 * A conversation with its call (BLG-706): the strip on top, and once someone shares, their
 * screen takes the room with the same chat as a column beside it. The chat is the same element
 * either way (never drawn again), so where you were reading and what you were typing stay put.
 */
export function CallRoom({ id, children }: { id: string; children: ReactNode }) {
  const call = useConversationCall(id);
  const live = useCallLive();
  const staged = Boolean(call?.mine === 'in' && live.conversation === id && live.stage);
  // The room's chat has no timeline of its own for them: its latest call's notes sit on top, folded.
  const roomNotes = useApp((st) => (id === 'room' ? st.network.callNotes?.room?.at(-1) : undefined));
  const place = useCallPlace(id);
  const engine = useCallEngine();
  // Tell the others how you show their cameras (BLG-717), so each sends you its picture at that
  // size: face to face one person, or a collage of four or fewer, big; the band or filmstrip small.
  const mineHere = call?.mine === 'in' && live.conversation === id;
  const others = call?.people.filter((p) => !p.me && p.camera).map((p) => p.peerId) ?? [];
  const big = mineHere && live.faces && others.length <= 4 ? others : [];
  const bigKey = big.join(',');
  useEffect(() => {
    if (!mineHere) return;
    engine.setCameraView(bigKey ? bigKey.split(',') : [], true);
    return () => engine.setCameraView([], false);
  }, [engine, mineHere, bigKey]);
  return (
    <div className={c.room}>
      {call ? <CallStrip id={id} /> : null}
      {/* Face to face (BLG-714): the call over the whole window, like FaceTime. */}
      {call?.mine === 'in' && live.conversation === id && live.faces ? <FaceView call={call} /> : null}
      {/* Cameras that are on, as a band of faces (over the shared screen instead, while someone shares). */}
      {call?.mine === 'in' && live.conversation === id && !staged ? <CameraStrip call={call} /> : null}
      <div className={cx(c.roomBody, staged && c.staged)}>
        {staged && call ? <Stage call={call} /> : null}
        <div className={c.roomChat}>
          {roomNotes && !call ? <NotesBox notes={roomNotes} place="the room" /> : null}
          {children}
        </div>
        {/* A call's notes open beside the chat (BLG-715): long calls read like the chat, with search and a timeline. */}
        <NotesReaderFor conversation={id} place={place} />
      </div>
    </div>
  );
}
