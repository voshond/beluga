export const OSC_CLIPBOARD = 52;

const decodeBase64 = (payload: string): string | undefined => {
  try {
    const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
};

export const osc52Text = (data: string): string | undefined => {
  const split = data.indexOf(';');
  if (split < 0) return undefined;
  const payload = data.slice(split + 1).replace(/\s+/g, '');
  if (!payload || payload === '?') return undefined;
  const text = decodeBase64(payload);
  return text ? text : undefined;
};

export type ClipboardChord = 'copy' | 'paste';

export type ChordKey = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>;

export const clipboardChord = (e: ChordKey, mac: boolean): ClipboardChord | undefined => {
  if (mac || !e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return undefined;
  const key = e.key.toLowerCase();
  if (key === 'c') return 'copy';
  if (key === 'v') return 'paste';
  return undefined;
};
