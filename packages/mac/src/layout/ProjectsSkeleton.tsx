import k from './projects-skeleton.module.css';

/** How wide each placeholder's name is (%), so they read as different projects. */
const WIDTHS = [58, 42, 66, 36] as const;

/**
 * The sidebar's projects while Beluga is still finding them (it just started): rows drawn in
 * outline, softly moving, where your projects are about to be. Never "Add a project…" here: that
 * comes only once Beluga has looked and found none (lib/projects-state.ts).
 */
export function ProjectsSkeleton() {
  return (
    <div className={k.skeleton} role="status" aria-label="Loading your projects…" aria-busy>
      {WIDTHS.map((w) => (
        <div key={w} className={k.row} aria-hidden>
          <span className={k.icon} />
          <span className={k.bar} style={{ width: `${w}%` }} />
        </div>
      ))}
    </div>
  );
}
