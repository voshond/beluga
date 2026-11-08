import { memo } from 'react';
import { Icon } from '../components/Icon.js';
import { cx } from '../components/ui.js';
import { openExternal } from '../lib/system.js';
import type { MergedItem, ShippedItem } from './merged-model.js';
import s from './context.module.css';

/** A PR as a link to it on GitHub (or just its number). */
function PrLink({ number, url }: { number: number; url?: string }) {
  const pr = `PR #${number}`;
  if (!url) return <>{pr}</>;
  return (
    <button type="button" className={s.prLink} onClick={() => void openExternal(url)} title={`Open ${pr} on GitHub`}>
      {pr}
    </button>
  );
}

/**
 * Continue After Merge: the chat above went out in a pull request that merged, and what's below
 * is new work for the next one. The PR number opens it on GitHub.
 */
export const ShippedDivider = memo(function ShippedDivider({ item }: { item: ShippedItem }) {
  const m = item.shipped;
  return (
    <div className={cx(s.divider, s.shipped)} data-shipped-divider={m.number} role="separator" aria-label={item.text}>
      <div className={s.rule}>
        <span className={s.label}>
          <Icon name="merge" size={11} />
          <span>
            Above went to <PrLink number={m.number} {...(m.url ? { url: m.url } : {})} />, merged into {m.into}
          </span>
        </span>
      </div>
      <div className={s.fresh}>New start: the next change gets a new pull request</div>
    </div>
  );
});

/**
 * The work above merged: in Beluga, on GitHub, or into the main folder. Said as it happens, so a
 * merge done elsewhere shows in the chat too. The PR number opens it on GitHub.
 */
export const MergedDivider = memo(function MergedDivider({ item }: { item: MergedItem }) {
  const m = item.merged;
  return (
    <div className={cx(s.divider, s.shipped)} data-merged-divider={m.number ?? 'merged'} role="separator" aria-label={item.text}>
      <div className={s.rule}>
        <span className={s.label}>
          <Icon name="merge" size={11} />
          <span>
            Above was merged into {m.into}
            {m.number !== undefined ? (
              <>
                {' '}
                in <PrLink number={m.number} {...(m.url ? { url: m.url } : {})} />
              </>
            ) : null}
          </span>
        </span>
      </div>
    </div>
  );
});
