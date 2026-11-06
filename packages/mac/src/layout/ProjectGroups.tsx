import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import type { Project } from '@beluga/workspaces/types.js';
import { Icon, type IconName } from '../components/Icon.js';
import { getPrefs, setPrefs, usePrefs } from '../lib/prefs.js';
import { ActionsContext, type ActionItem } from '../components/SpecMenu.js';
import { cx } from '../components/ui.js';
import { editGroups, newGroupFor, useGroupEdit } from '../lib/group-edit.js';
import { useApi, useApp } from '../lib/beluga.js';
import { openSheet } from '../lib/sheets.js';
import { type Entry, type Place, type Target, outOfGroup, stepOf } from './project-layout.js';
import { NO_TALLY, type Tally, tallyTip } from './attention-model.js';
import { DotMark, TallyMark } from './signal-marks.js';
import side from './Sidebar.module.css';
import s from './project-groups.module.css';
import { isShortcut } from '../lib/shortcuts.js';
import { shortcutKeys } from '../lib/shortcuts.js';

/** The project menu's group options, done the Mac way: these spec options become "Move to Group ▸". */
export const isGroupOption = (id: string): boolean => id.startsWith('p-group:') || id === 'p-newgroup' || id === 'p-ungroup';

/** Moving rows with the keyboard (⌥⌘↑/↓ are Previous/Next Workspace in the menu bar). */
export const moveKey = (e: KeyboardEvent): -1 | 1 | undefined => (isShortcut('project-up', e) ? -1 : isShortcut('project-down', e) ? 1 : undefined);

/** "Move Up" and "Move Down" for a row's menu (greyed at the ends). */
export function moveItems(entries: readonly Entry[], item: Target, arrange: (item: Target, place: Place) => void): ActionItem[] {
  const up = stepOf(entries, item, -1);
  const down = stepOf(entries, item, 1);
  return [
    { label: 'Move Up', keys: shortcutKeys('project-up'), disabled: !up, onSelect: () => up && arrange(item, up) },
    { label: 'Move Down', keys: shortcutKeys('project-down'), disabled: !down, onSelect: () => down && arrange(item, down) },
  ];
}

/** "Move to Group ▸": the groups (a check on this project's), New Group…, Remove from Group. */
export function groupItems(p: Project, entries: readonly Entry[], arrange: (item: Target, place: Place) => void): readonly ActionItem[] {
  const groups = entries.flatMap((e) => (e.kind === 'group' ? [e] : []));
  const current = groups.find((g) => g.projects.some((x) => x.id === p.id))?.name;
  if (!p.root) return [];
  return [
    {
      label: 'Move to Group',
      separate: true,
      submenu: [
        ...groups.map((g) => ({ label: g.name, checked: g.name === current, onSelect: () => (g.name === current ? undefined : arrange({ project: p.id }, { into: g.name, before: null })) })),
        { label: 'New Group…', separate: groups.length > 0, onSelect: () => newGroupFor(p.id) },
        ...(current ? [{ label: `Remove from “${current}”`, onSelect: () => arrange({ project: p.id }, outOfGroup(entries, current)) }] : []),
      ],
      onSelect: () => undefined,
    },
  ];
}

/** "Plan Across Group…" on a group's menu: New Plan with its projects ticked (this Mac's, at least two). */
export function planAcrossItems(projects: readonly Project[]): readonly ActionItem[] {
  const local = projects.filter((p) => p.root && !p.error);
  if (local.length < 2) return [];
  return [{ label: 'Plan Across Group…', icon: 'flag', separate: true, onSelect: () => openSheet({ kind: 'new_plan', projectIds: local.map((p) => p.id) }) }];
}

/** A group's name, typed in place: Return keeps it, Esc (or an empty name) gives up. */
function NameField({ initial, onDone, label }: { initial: string; onDone: (name: string | undefined) => void; label: string }) {
  const [name, setName] = useState(initial);
  const box = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const finish = (value: string | undefined): void => {
    if (done.current) return;
    done.current = true;
    onDone(value?.trim() ? value.trim() : undefined);
  };
  useEffect(() => {
    // After the menu that asked for it has closed and given the focus back.
    const t = setTimeout(() => {
      box.current?.focus();
      box.current?.select();
      box.current?.scrollIntoView({ block: 'nearest' });
    }, 30);
    return () => clearTimeout(t);
  }, []);
  return (
    <input
      ref={box}
      className={s.field}
      value={name}
      aria-label={label}
      maxLength={30}
      spellCheck={false}
      onChange={(e) => setName(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(name);
        else if (e.key === 'Escape') finish(undefined);
      }}
      onBlur={() => finish(name)}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

/** Icons a group can wear instead of the folder (Change Icon ▸ on its right-click menu). */
export const GROUP_ICONS: ReadonlyArray<{ readonly icon: IconName; readonly label: string }> = [
  { icon: 'folder', label: 'Folder' },
  { icon: 'grid', label: 'Grid' },
  { icon: 'spark', label: 'Prompt' },
  { icon: 'people', label: 'People' },
  { icon: 'globe', label: 'Globe' },
  { icon: 'coin', label: 'Coin' },
  { icon: 'bulb', label: 'Idea' },
  { icon: 'wand', label: 'Wand' },
  { icon: 'terminal', label: 'Terminal' },
  { icon: 'lock', label: 'Lock' },
  { icon: 'archive', label: 'Archive' },
  { icon: 'important', label: 'Flag' },
];

const iconOfGroup = (icons: Readonly<Record<string, string>>, name: string): IconName => {
  const picked = icons[name];
  return GROUP_ICONS.find((g) => g.icon === picked)?.icon ?? 'folder';
};

/** A group's disclosure triangle and its icon (a folder unless you picked another). */
function GroupIcon({ open, icon = 'folder' }: { open: boolean; icon?: IconName }) {
  return (
    <span className={s.groupIcon}>
      <Icon name="chevronRight" size={9} className={cx(s.disclosure, open && s.disclosureOpen)} />
      <Icon name={icon} size={15} className={s.folder} />
    </span>
  );
}

/** Pick a group's icon; it follows the group when it's renamed. */
function setGroupIcon(name: string, icon: IconName | undefined): void {
  const { [name]: _old, ...rest } = getPrefs().groupIcons;
  setPrefs({ groupIcons: icon && icon !== 'folder' ? { ...rest, [name]: icon } : rest });
}

function renameGroupIcon(from: string, to: string): void {
  const icons = getPrefs().groupIcons;
  const icon = icons[from];
  if (!icon) return;
  const { [from]: _old, ...rest } = icons;
  setPrefs({ groupIcons: { ...rest, [to]: icon } });
}

/** The row of a group being made: a folder and its name field (like Finder's New Folder). */
export function NewGroupRow() {
  const api = useApi();
  const { creating } = useGroupEdit();
  const project = useApp((st) => st.projects.find((p) => p.id === creating?.projectId));
  if (!creating) return null;
  return (
    <div className={cx(side.row, side.groupRow, s.editing)} style={{ paddingLeft: 8 }}>
      <span className={side.rowIcon} style={{ width: 'auto' }}>
        <GroupIcon open />
      </span>
      <NameField
        key={creating.projectId ?? ''}
        initial="New Group"
        label={project ? `Name of the new group for ${project.name}` : 'Name of the new group'}
        onDone={(name) => {
          editGroups({ creating: undefined });
          if (name) void api.workspaces.newGroup(name, project ? { project: project.id } : {});
        }}
      />
    </div>
  );
}

export interface GroupHeaderProps {
  readonly name: string;
  readonly count: number;
  readonly open: boolean;
  readonly busy: boolean;
  /** What its projects add up to (folded, it shows instead of how many projects it holds). */
  readonly tally?: Tally;
  /** A project being dragged would go inside: the folder lights up. */
  readonly dropOn: boolean;
  readonly menu: readonly ActionItem[];
  readonly onToggle: () => void;
  readonly onMove: (dir: -1 | 1) => void;
}

/** A group in the sidebar: click to fold, drag to move, right-click to rename or ungroup. */
export function GroupHeader({ name, count, open, busy, tally = NO_TALLY, dropOn, menu, onToggle, onMove }: GroupHeaderProps) {
  const api = useApi();
  const { renaming } = useGroupEdit();
  const icon = iconOfGroup(usePrefs().groupIcons, name);
  const items: ActionItem[] = [
    { label: 'Rename…', icon: 'pencil', onSelect: () => editGroups({ renaming: name, creating: undefined }) },
    {
      label: 'Change Icon',
      icon,
      submenu: GROUP_ICONS.map((g) => ({ label: g.label, icon: g.icon, checked: g.icon === icon, onSelect: () => setGroupIcon(name, g.icon) })),
      onSelect: () => undefined,
    },
    ...menu,
    count
      ? { label: 'Ungroup', hint: 'Its projects stay, where the group was', icon: 'x', danger: true, separate: true, onSelect: () => void api.workspaces.ungroup(name).then(() => setGroupIcon(name, undefined)) }
      : { label: 'Delete Group', icon: 'x', danger: true, separate: true, onSelect: () => void api.workspaces.ungroup(name).then(() => setGroupIcon(name, undefined)) },
  ];
  if (renaming === name) {
    return (
      <div className={cx(side.row, side.groupRow, s.editing)} style={{ paddingLeft: 8 }} data-head>
        <span className={side.rowIcon} style={{ width: 'auto' }}>
          <GroupIcon open={open} icon={icon} />
        </span>
        <NameField
          initial={name}
          label={`New name for the group ${name}`}
          onDone={(to) => {
            editGroups({ renaming: undefined });
            if (to && to !== name) void api.workspaces.renameGroup(name, to).then(() => renameGroupIcon(name, to), () => undefined);
          }}
        />
      </div>
    );
  }
  return (
    <ActionsContext items={items}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-label={`Group ${name}`}
        title={tallyTip(tally) || undefined}
        className={cx(side.row, side.groupRow, s.groupHead, dropOn && s.dropOn)}
        style={{ paddingLeft: 8 }}
        data-head
        data-drag={`group:${name}`}
        onClick={onToggle}
        onDoubleClick={() => editGroups({ renaming: name })}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          const dir = moveKey(e);
          if (dir) {
            e.preventDefault();
            onMove(dir);
          } else if (e.key === 'Enter') {
            e.preventDefault();
            editGroups({ renaming: name });
          } else if (e.key === ' ' || (e.key === 'ArrowLeft' && open) || (e.key === 'ArrowRight' && !open)) {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <span className={side.rowIcon} style={{ width: 'auto' }}>
          <GroupIcon open={open} icon={icon} />
        </span>
        <span className={side.rowLabel}>{name}</span>
        <span className={side.trailing}>
          {open ? null : (
            <>
              {busy ? <DotMark tone="claude" live signal="busy" /> : null}
              <TallyMark tally={tally} folded fallback={<span className={s.count}>{count}</span>} />
            </>
          )}
          {open && !count ? <span className={s.empty}>Empty</span> : null}
        </span>
      </div>
    </ActionsContext>
  );
}

