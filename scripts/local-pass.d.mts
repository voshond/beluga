// Types for scripts/local-pass.mjs (used by vitest.config.ts and the tests).

export const TRAILER: string;
export function trailerFor(tree: string): string;
export function workingTree(cwd?: string): string | undefined;
export function suiteSize(dir?: string): number;
export function wholeSuitePassed(run: { reason: string; errors: number; modules: number; suite: number; namePattern?: RegExp | string }): boolean;
export default class LocalPass {
  onInit(vitest: unknown): void;
  onTestRunEnd(testModules: readonly unknown[], unhandledErrors: readonly unknown[], reason: string): void;
}
