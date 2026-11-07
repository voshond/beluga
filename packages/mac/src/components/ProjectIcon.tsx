import { useProjectIcon } from '../lib/projects.js';
import { cx } from './ui.js';
import s from './ProjectIcon.module.css';

/** A calm colour for a project without an icon, the same every time for the same name. */
function hue(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

/**
 * A project's own icon (its app icon, favicon or logo, or one you chose), else a tile with its
 * initial: you find a project by its look, like apps in the Dock.
 */
/**
 * `id`: a project's id, or `path:<folder>` for a folder that isn't one yet. `round`: a circle (in a
 * stack of repos), an icon filling it over a grey.
 */
export function ProjectIcon({ id, name, size = 16, round }: { id: string; name: string; size?: number; round?: boolean }) {
  const icon = useProjectIcon(id);
  const radius = round ? '50%' : Math.round(size * 0.24);
  if (icon) return <img className={cx(s.image, round && s.round)} src={icon} alt="" width={size} height={size} style={{ borderRadius: radius }} draggable={false} />;
  return (
    <span className={s.tile} style={{ width: size, height: size, borderRadius: radius, fontSize: size * 0.58, ['--h' as string]: hue(name) }} aria-hidden="true">
      {/* Before the icon is known, an empty tile (no flash of a letter, then a picture). */}
      {icon === null ? (name.match(/[a-z0-9]/i)?.[0] ?? '?').toUpperCase() : null}
    </span>
  );
}
