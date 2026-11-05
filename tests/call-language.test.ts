import { describe, expect, it } from 'vitest';
import { SETTLE_SECONDS, addCounts, callLanguage, countPhrase, phraseLanguage, reported } from '../src/shared/call-language.js';
import { bestModel, modelQuality, pickScribe } from '../src/shared/scribe-plan.js';
import type { ScribeStatus } from '../src/shared/scribe-plan.js';
import { parseStage } from '../src/shared/calls.js';

describe('a call settles on one language (BLG-738)', () => {
  it('a short phrase guessed as Russian doesn’t make a Turkish call Russian', () => {
    let kayra = countPhrase({}, 'tr', 4);
    kayra = countPhrase(kayra, 'tr', 3);
    let berca = countPhrase({}, 'tr', 2.5);
    berca = countPhrase(berca, 'ru', 1.8);
    expect(callLanguage([kayra, berca])).toBe('tr');
  });

  it('waits until enough was heard, and for a clear lead', () => {
    expect(callLanguage([countPhrase({}, 'tr', SETTLE_SECONDS - 1)])).toBeUndefined();
    expect(callLanguage([{ tr: 5, en: 5 }])).toBeUndefined();
    expect(callLanguage([{ tr: 9, en: 3 }])).toBe('tr');
    // The same answer on every Mac, whatever order the reports come in.
    expect(callLanguage([{ tr: 6 }, { en: 6 }, { tr: 6 }])).toBe(callLanguage([{ tr: 6 }, { tr: 6 }, { en: 6 }]));
  });

  it('a language set in Voice settings always wins for your own words', () => {
    expect(phraseLanguage('de', 'tr')).toBe('de');
    expect(phraseLanguage('auto', 'tr')).toBe('tr');
    expect(phraseLanguage('auto', undefined)).toBe('auto');
  });

  it('reports only the leading few, and ignores what isn’t a language code', () => {
    expect(Object.keys(reported({ tr: 9, ru: 1, en: 2, de: 0.5, fr: 0.2 }))).toEqual(['tr', 'en', 'ru', 'de']);
    expect(addCounts([{ tr: 2, 'x-y': 9 } as Record<string, number>, { tr: 1 }])).toEqual({ tr: 3 });
    expect(countPhrase({}, 'Turkish', 3)).toEqual({});
  });
});

describe('the best model in the call writes the notes (BLG-738)', () => {
  const s = (by: string, extra: Partial<ScribeStatus> = {}): ScribeStatus => ({ by, ready: true, backlog: 0, speed: 6, ...extra });

  it('Parakeet never writes Turkish; Turbo does', () => {
    expect(modelQuality('parakeet', 'tr')).toBe(0);
    expect(modelQuality('whisper-turbo', 'tr')).toBeGreaterThan(modelQuality('whisper-base', 'tr'));
    expect(bestModel(['parakeet', 'whisper-turbo'], 'tr')?.model).toBe('whisper-turbo');
    expect(bestModel(['parakeet'], 'tr')).toBeUndefined();
  });

  it('your phrase goes to the Mac with the better model, even when yours is faster', () => {
    const call = [s('kayra', { models: ['whisper-base'], speed: 20 }), s('berca', { models: ['whisper-turbo'], speed: 5 })];
    expect(pickScribe('kayra', call, 4, 'tr')).toBe('berca');
    // Both have the best: each writes their own (no sound leaves the Mac).
    const both = [s('kayra', { models: ['whisper-turbo'] }), s('berca', { models: ['whisper-turbo'] })];
    expect(pickScribe('kayra', both, 4, 'tr')).toBe('kayra');
    // A Parakeet-only Mac can't write Turkish: Berca's Turbo does, and nobody when there's none.
    expect(pickScribe('kayra', [s('kayra', { models: ['parakeet'] }), s('berca', { models: ['whisper-turbo'] })], 4, 'tr')).toBe('berca');
    expect(pickScribe('kayra', [s('kayra', { models: ['parakeet'] })], 4, 'tr')).toBeUndefined();
  });

  it('the best Mac far behind: a lesser one writes it rather than leave it waiting', () => {
    const call = [s('kayra', { models: ['whisper-base'], speed: 10 }), s('berca', { models: ['whisper-turbo'], speed: 1, backlog: 120 })];
    expect(pickScribe('kayra', call, 4, 'tr')).toBe('kayra');
  });

  it('Macs say which models they have and what they heard; a phrase says its language', () => {
    expect(parseStage('{"k":"scribe","by":"a","ready":true,"backlog":0,"models":["whisper-turbo","nope"],"langs":{"tr":9.5,"zz-top":3}}')).toMatchObject({ models: ['whisper-turbo'], langs: { tr: 9.5 } });
    expect(parseStage('{"k":"clip","by":"a","id":"p1","part":0,"parts":1,"seconds":2,"b64":"AAAA","lang":"tr"}')).toMatchObject({ lang: 'tr' });
    expect(parseStage('{"k":"clip","by":"a","id":"p1","part":0,"parts":1,"seconds":2,"b64":"AAAA","lang":"<script>"}')).not.toHaveProperty('lang');
    expect(parseStage('{"k":"clip-text","by":"a","id":"p1","text":"merhaba","lang":"tr"}')).toMatchObject({ lang: 'tr' });
  });
});
