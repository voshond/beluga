import { describe, expect, it } from 'vitest';
import { PASTE_IMAGE_ORDER, bestImageType, pickPastedImages } from '../packages/mac/src/chat/paste-images-model.js';

/** Pasting a JPEG, WebP or GIF as it is, and one picture when the clipboard offers it several ways (BLG-109). */
describe('pasted images', () => {
  const file = (type: string, size = 10, name = `image.${type.split('/')[1]}`) => ({ name, type, size });

  it('takes a GIF first, then PNG, WebP and JPEG', () => {
    expect(PASTE_IMAGE_ORDER).toEqual(['image/gif', 'image/png', 'image/webp', 'image/jpeg']);
    expect(bestImageType(['image/jpeg', 'image/png', 'image/bmp', 'text/plain'])).toBe('image/png');
    expect(bestImageType(['image/jpeg', 'image/webp'])).toBe('image/webp');
    expect(bestImageType(['image/png', 'image/gif'])).toBe('image/gif');
    expect(bestImageType(['IMAGE/JPEG'])).toBe('image/jpeg');
    expect(bestImageType(['image/bmp', 'image/tiff', 'UTF8_STRING'])).toBeUndefined();
    expect(bestImageType([])).toBeUndefined();
  });

  it('keeps a lone JPEG, WebP or GIF as it is', () => {
    for (const type of ['image/jpeg', 'image/webp', 'image/gif', 'image/png']) expect(pickPastedImages([file(type)])).toEqual([file(type)]);
  });

  it('leaves out the empty picture WebKitGTK hands over for anything but a PNG', () => {
    expect(pickPastedImages([file('image/png', 0)])).toEqual([]);
  });

  it('takes one of the clipboard’s own picture offered several ways', () => {
    expect(pickPastedImages([file('image/jpeg'), file('image/png'), file('image/webp')])).toEqual([file('image/png')]);
    expect(pickPastedImages([file('image/jpeg'), file('image/gif')])).toEqual([file('image/gif')]);
    expect(pickPastedImages([file('image/jpeg', 10, ''), file('image/webp', 10, '')])).toEqual([file('image/webp', 10, '')]);
  });

  it('keeps every named file, and several of one type', () => {
    const named = [file('image/png', 10, 'a.png'), file('image/jpeg', 10, 'b.jpg')];
    expect(pickPastedImages(named)).toEqual(named);
    const two = [file('image/png'), file('image/png')];
    expect(pickPastedImages(two)).toEqual(two);
    expect(pickPastedImages([named[0]!, file('image/jpeg'), file('image/png')])).toEqual([named[0], file('image/png')]);
  });
});
