import { type SourceLoader, findComponents, looksLikeComponents } from './props.js';
import { SFC_FILE, findSfcComponent } from './sfc.js';
import type { ComponentInfo } from './shape.js';

/**
 * The components a file holds, whatever kind of file: React's (.tsx, .jsx, .ts, .js), or a Vue or
 * Svelte single-file component (one per file). Browser-safe.
 */

export type Framework = 'react' | 'vue' | 'svelte';

export const frameworkOf = (path: string): Framework => (/\.vue$/i.test(path) ? 'vue' : /\.svelte$/i.test(path) ? 'svelte' : 'react');

export function componentsOf(path: string, src: string, load?: SourceLoader): ComponentInfo[] {
  return SFC_FILE.test(path) ? findSfcComponent(path, src, load) : findComponents(src, load);
}

/** A file worth a Preview in Files: React components, or any Vue or Svelte component. */
export function looksLikeComponentFile(path: string, src: string): boolean {
  if (SFC_FILE.test(path)) return /<template\b|<script\b|<[a-z]/i.test(src);
  return looksLikeComponents(path, src);
}
