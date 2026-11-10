import type { RuntimeModel } from './agent-runtimes.js';

type Versioned = { readonly family: string; readonly version: readonly number[] };

const VERSION = /(\d+(?:[.-]\d+)*)/;

export const modelFamily = (label: string): Versioned | undefined => {
  const found = label.match(VERSION);
  if (!found?.[1]) return undefined;
  const family = label.replace(found[1], ' ').toLowerCase().replace(/[^a-z]+/g, ' ').trim();
  if (!family) return undefined;
  return { family, version: found[1].split(/[.-]/).map(Number) };
};

const newer = (a: readonly number[], b: readonly number[]): boolean => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
};

export const latestModels = <M extends Pick<RuntimeModel, 'value' | 'label'>>(models: readonly M[], keep: readonly string[] = []): M[] => {
  const best = new Map<string, { readonly value: string; readonly version: readonly number[] }>();
  for (const m of models) {
    const at = modelFamily(m.label);
    if (!at) continue;
    const held = best.get(at.family);
    if (!held || newer(at.version, held.version)) best.set(at.family, { value: m.value, version: at.version });
  }
  return models.filter((m) => {
    if (!m.value || keep.includes(m.value)) return true;
    const at = modelFamily(m.label);
    return !at || best.get(at.family)?.value === m.value;
  });
};
