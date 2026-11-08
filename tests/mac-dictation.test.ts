import { describe, expect, it } from 'vitest';
import { accelLabel, accelOf, cleanWords, dictationAudio, downsample, levelOf, matchesAccel, microphonesOf, parseAccel, spoken, wavFromFloats } from '../packages/mac/src/lib/dictation-model.js';

/** Speaking instead of typing in the Mac app (BLG-145): the talk shortcut, the recording, the words. */
const key = (code: string, m: { meta?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean } = {}) => ({ code, metaKey: Boolean(m.meta), ctrlKey: Boolean(m.ctrl), altKey: Boolean(m.alt), shiftKey: Boolean(m.shift) });

describe('the talk shortcut', () => {
  it('reads accelerators as Tauri writes them, and shows them as a Mac does', () => {
    expect(parseAccel('Alt+Space')).toEqual({ cmd: false, ctrl: false, alt: true, shift: false, code: 'Space' });
    expect(parseAccel('CommandOrControl+Shift+D')).toEqual({ cmd: true, ctrl: false, alt: false, shift: true, code: 'KeyD' });
    expect(accelLabel('Alt+Space')).toBe('⌥Space');
    expect(accelLabel('Control+Alt+Shift+CommandOrControl+1')).toBe('⌃⌥⇧⌘1');
  });

  it('refuses what typing needs: a letter, digit or Space alone (or with Shift), Escape and Enter', () => {
    expect(parseAccel('D')).toBeUndefined();
    expect(parseAccel('Shift+Space')).toBeUndefined();
    expect(parseAccel('Alt+Escape')).toBeUndefined();
    expect(parseAccel('Nope+D')).toBeUndefined();
    // A function key alone is fine.
    expect(parseAccel('F5')).toMatchObject({ code: 'F5' });
  });

  it('records a key press, and matches by the key, not the character ⌥ makes', () => {
    expect(accelOf(key('AltLeft', { alt: true }))).toBeUndefined();
    expect(accelOf(key('Space', { alt: true }))).toBe('Alt+Space');
    expect(accelOf(key('KeyD', { meta: true, shift: true }))).toBe('CommandOrControl+Shift+D');
    const a = parseAccel('Alt+Space')!;
    expect(matchesAccel(a, key('Space', { alt: true }))).toBe(true);
    expect(matchesAccel(a, key('Space', { alt: true, shift: true }))).toBe(false);
    expect(matchesAccel(a, key('Space'))).toBe(false);
    // What the recorder writes reads back the same.
    expect(parseAccel(accelOf(key('Digit1', { ctrl: true, alt: true }))!)).toMatchObject({ ctrl: true, alt: true, code: 'Digit1' });
  });
});

describe('the recording', () => {
  it('goes down to 16 kHz, averaging what each sample covers', () => {
    const at48 = new Float32Array(4800).fill(0.5);
    const out = downsample(at48, 48_000);
    expect(out.length).toBe(1600);
    expect(out[0]).toBeCloseTo(0.5);
    expect(downsample(new Float32Array([1, 2]), 16_000)).toEqual(new Float32Array([1, 2]));
  });

  it('becomes a 16-bit mono WAV, clipped to range', () => {
    const w = wavFromFloats(new Float32Array([0, 1, -1, 2]));
    const v = new DataView(w.buffer);
    expect(new TextDecoder().decode(w.subarray(0, 4))).toBe('RIFF');
    expect([v.getUint16(22, true), v.getUint32(24, true), v.getUint32(40, true)]).toEqual([1, 16_000, 8]);
    expect([v.getInt16(44, true), v.getInt16(46, true), v.getInt16(48, true), v.getInt16(50, true)]).toEqual([0, 32767, -32768, 32767]);
  });

  it('shows silence as 0 and speech as louder', () => {
    expect(levelOf(new Float32Array(100))).toBe(0);
    expect(levelOf(new Float32Array(100).fill(0.2))).toBeGreaterThan(levelOf(new Float32Array(100).fill(0.01)));
  });
});

describe('the words', () => {
  it('drops what Whisper says about the sound, and keeps a space from the word before', () => {
    expect(cleanWords('[BLANK_AUDIO]')).toBe('');
    expect(cleanWords(' (music) Fix the login  ♪ ')).toBe('Fix the login');
    expect(spoken('', 'Fix it')).toBe('Fix it');
    expect(spoken('Hi.', 'Fix it')).toBe(' Fix it');
    expect(spoken('Hi. ', 'Fix it')).toBe('Fix it');
  });
});

describe('the talk shortcut off the Mac', () => {
  const press = (code: string, m: { ctrl?: boolean; alt?: boolean; meta?: boolean } = {}) => ({ code, metaKey: !!m.meta, ctrlKey: !!m.ctrl, altKey: !!m.alt, shiftKey: false });

  it('records Ctrl as the main key and shows it in words', () => {
    expect(accelOf(press('KeyD', { ctrl: true }), false)).toBe('CommandOrControl+D');
    expect(accelLabel('CommandOrControl+Shift+D', false)).toBe('Ctrl+Shift+D');
    expect(accelLabel('Alt+Space', false)).toBe('Alt+Space');
  });

  it('matches a Ctrl shortcut pressed with Ctrl', () => {
    const accel = parseAccel('CommandOrControl+D')!;
    expect(matchesAccel(accel, press('KeyD', { ctrl: true }), false)).toBe(true);
    expect(matchesAccel(accel, press('KeyD', { meta: true }), false)).toBe(false);
  });
});

describe('the microphone it listens to', () => {
  const dev = (kind: string, deviceId: string, label = '') => ({ kind, deviceId, label });

  it('lists the microphones once each, without macOS’s own stand-ins, and names unnamed ones', () => {
    const all = [dev('audioinput', 'default', 'Default - MacBook Pro Microphone'), dev('audioinput', 'built-in', 'MacBook Pro Microphone'), dev('audiooutput', 'spk', 'Speakers'), dev('audioinput', 'usb'), dev('audioinput', '')];
    expect(microphonesOf(all)).toEqual([
      { id: 'built-in', label: 'MacBook Pro Microphone' },
      { id: 'usb', label: 'Microphone 2' },
    ]);
  });

  it('asks for the one picked, and takes macOS’s own when it’s gone', () => {
    expect(dictationAudio('')).not.toHaveProperty('deviceId');
    expect(dictationAudio('usb')).toMatchObject({ channelCount: 1, echoCancellation: true, deviceId: { ideal: 'usb' } });
  });
});
