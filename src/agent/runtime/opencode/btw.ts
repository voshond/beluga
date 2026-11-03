import { type BtwRequest, btwPrompt } from '../../btw.js';
import { runConfig } from './config.js';
import { type OneShotDeps, oneShot } from './one-shot.js';
import { openCodeModel } from './runner.js';

/**
 * A side question about an OpenCode conversation (/btw): a fork of its session, so it knows
 * everything said so far, with no tools at all, answered once and the fork dropped (nothing kept,
 * the conversation itself untouched). A conversation with no session yet gets a new one. Every
 * tool asks and Beluga turns each one down (oneShot with no judge), and OpenCode answers on: denied
 * in its own config instead, OpenCode 1.19 never answers at all.
 */
export async function askOpenCodeBtw(req: BtwRequest, deps: OneShotDeps = {}): Promise<string> {
  const { text } = await oneShot(
    {
      cwd: req.cwd,
      config: runConfig(undefined),
      blocks: [{ type: 'text', text: btwPrompt(req.question) }],
      ...(req.resume ? { fork: req.resume } : {}),
      model: (options) => {
        const pick = openCodeModel(req.model);
        return pick && options.find((o) => o.id === 'model')?.options.some((o) => o.value === pick) ? pick : undefined;
      },
      onText: req.onText,
      signal: req.signal,
    },
    deps,
  );
  return text;
}
