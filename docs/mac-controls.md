# Mac controls: sizes and where they go

The Mac app's controls follow AppKit's control sizes (`NSControl.ControlSize`), so a sheet, a
Settings row and a toolbar each look like the same control in the same place on a Mac. This page
is the rule; `styles/tokens.css` ("Controls") holds the numbers, and every control reads them from
there, never a height of its own.

## The scale

Three sizes, one per kind of place. Every control of a size shares its height, so a field, a
pop-up and a button on one row line up without adjusting anything.

| Size | Height | Text | Corner | Icon | Padding (button) | Checkbox | Switch |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Large** | 28px | 13px | 7px | 16px | 0 16px | 14px | 32 × 19 |
| **Regular** (default) | 22px | 13px | 5px | 14px | 0 12px | 14px | 32 × 19 |
| **Small** | 20px | 12px | 4px | 12px | 0 8px | 12px | 26 × 15 |

- AppKit's mini size (16px, 9pt) is left out: Chinese and Japanese text don't read at that size.
- Small uses 12px text, a point above AppKit's 11pt, for the same reason.
- The heights are the whole control, its bezel included.

| Token | Large | Regular | Small |
| --- | --- | --- | --- |
| height | `--control-h-large` | `--control-h` | `--control-h-small` |
| text | `--control-text-large` | `--control-text` | `--control-text-small` |
| corner | `--control-radius-large` | `--control-radius` | `--control-radius-small` |

## Which size where

**Regular** is the size of a window's content. Use it unless a rule below says otherwise.

- Sheets and alerts: every field, pop-up and checkbox, and the buttons at the bottom. Those buttons
  are at least 76px wide; the default button is the rightmost one.
- Settings: every row's control (pop-up, field, segmented control, button).
- Forms anywhere: in the inspector, in a popover, on a project's page.
- The segmented control that switches a sheet's or a page's tabs.

**Small** is for controls that sit inside dense content, beside text that is itself small.

- Rows of a list or table: a row's own actions (Merge, Open, Retry).
- Cards (tasks, sentinels, usage), and the header of a card or panel section.
- The right panel's and the dock's own toolbars and switchers (Changes / History, the shells'
  buttons, the dock's Terminal / Background).
- Controls inside a conversation: an answer's actions, a step's buttons, a question's choices.
- Filter bars over a list.

**Large** is for the one thing a screen is for.

- The main action of onboarding, a welcome or an empty state ("Add Project", "Turn On").
- The window's toolbar: its buttons, icon buttons (28 × 28), segmented control and search field.
  This is AppKit's unified toolbar, whose items are 28px tall. The title row goes across the
  window, so the sidebar's buttons there, its search field and the right panel's view switcher
  (Changes / Files / Scratch / Info) are Large too.

Never more than one large button in a view outside the toolbar. One row never mixes sizes.

## Each control

- **Push button** (`Button`, a sheet's or an alert's buttons): plain, primary (the accent, for the
  default action), danger, merge. Height, padding and text by size; at least 76px wide in a sheet's
  or an alert's button row. A sheet's or an alert's buttons are filled, a light grey on the sheet
  (macOS 26 draws them so; a white one on a white sheet hardly shows). One that can't be pressed is
  drawn as a plain one, its words dimmed, as AppKit draws a disabled default button: a primary,
  default or Merge button never keeps its colour faded (white words on pale blue can't be read).
  This lives in the shared controls (`ui.module.css`, `alert.module.css`), never a page's own CSS.
- **Icon button** (`IconButton`): square at its size (28 × 28, 22 × 22, 20 × 20), the icon
  16, 14 or 13px and centred, no bezel until hovered or pressed. One without a `size` keeps the
  28 × 26 it had until its screen moves onto the scale (steps 3 and 4).
- **Split button** (a button and its ▾, `SplitButton`, the toolbar's branch button): both halves
  are one control of one size and one bezel; a line inside parts them.
- **Pop-up button** (`Select`): the button's height; the chevrons in an accent box at its end,
  16px square in regular and large, 14px in small.
- **Text field** (`TextInput`, Settings' fields, search fields): the button's height for its size,
  6px padding (8px in large). Code is in the monospaced face a pixel under the system text.
  A text area (`TextArea`) is at least three lines tall and grows.
- **Segmented control** (`Segmented`): the button's height for its size; segments are 2px shorter,
  inside the track's 1px inset.
- **Checkbox** and **switch**: by size, from the table above; the label beside them is the system text.

Keyboard focus is the same everywhere: a 3px accent ring outside the control (`--focus-ring`).

## Liquid Glass

On a Mac whose window blurs what's behind it (`data-transparency='full'`: not with macOS's or the
app's Reduce transparency, not on a solid theme), the window is drawn as macOS 26 draws its own apps:

- The sidebar and the right panel are panes of glass, 8px in from the window's edges, with 16px
  corners, a light rim and a soft drop; the window behind them is the content's colour.
- Controls are capsules: `--control-radius-*` are 999px. A text area keeps 8px corners, or its
  corners would cut into the text. A capsule's ring is a real 0.5px border, since WebKit breaks a
  0.5px shadow up round the ends.
- The window toolbar's icon buttons sit on glass capsules.
- A pop-up button is its value and one chevron, with no bezel, as macOS 26's settings draw it; a soft
  capsule shows under it on hover and while its menu is open. Its menu is a rounded card, the row
  under the pointer on a soft grey and the checkmark at the row's end.

It is CSS only and still: nothing follows the pointer, and there is no refraction (the web versions
draw it with an SVG displacement filter, which WebKit doesn't). The tokens are `--glass-*` in
`styles/tokens.css`; each rule sits in its component's own stylesheet under
`:root[data-os='mac'][data-transparency='full']`. Windows, Linux and the flat window keep the look
above.

## Menus

In the app on a Mac, the app's menus are the Mac's own: an `NSMenu` built in
`src-tauri/src/native_menu.rs`, fed by `lib/native-menu.ts`. That covers a pop-up button's choices
(`Select`, its chosen row over the button as an `NSPopUpButton` opens), a button's pull-down
(`ActionsDropdown`, the ••• menus, and the pickers built like them: Runs On, the Overview's
project filter, a task's pickers, a person's card) and right-click menus (`SpecContext`, a
terminal tab, a person in the room). A row keeps what the web menu shows: its name through `t()`,
a hint as the line under it (macOS 14.4's subtitle), its shortcut on the right, a checkmark,
section headers, submenus, and its icon as a template image the system tints.

- A menu never opens squeezed into a scrolling one while the screen has room: one that wouldn't
  fit where it opens moves (above its button, or up over the pointer) first.
- A pop-up whose list is long enough for a search field keeps the web menu and its field, as does
  a picker you type in or tick several things in.
- If the menu can't be shown (an older shell), the web menu opens instead, so a press never does
  nothing.

Browsers, Windows and Linux keep the web menus. Those open on the side they fit on
(`FitContent` in `components/SpecMenu.tsx`: below the button, else above, else beside it) and
scroll without a bar only when the window is too short for them.


The same control has to read well with either language in it (`<html lang>` is `en` or `zh-CN`).

- **Face.** The system face for both: SF for Latin, PingFang SC for Chinese (`--font` names it
  first under `:lang(zh-CN)`, so Han characters never fall to a Japanese face; Microsoft YaHei and
  Noto Sans SC on Windows and Linux). No letter-spacing, no italics, no synthetic bold on Chinese.
- **Size.** No text under 12px, which is why there is no mini size and small text is 12px. A
  control's height is the same in both languages: PingFang's taller glyphs sit centred in it.
- **Width.** Controls with words never get a fixed width: they grow with the label. A sheet's or
  an alert's buttons are at least 76px wide, so a two-character Chinese label (取消, 完成) is as
  big a target as its English one.
- **Labels.** English buttons and menu items are in title case and start with a verb ("New
  Task", "Add Variable"); Chinese ones are a short verb phrase, two to six characters (新建任务,
  添加变量). Form labels have no colon in either language.
- **Punctuation.** An action that asks for more before it acts ends with an ellipsis, the single
  character "…" in both ("Paste Lines…", 粘贴多行…). Chinese text uses full-width punctuation
  (，。：「」), with a space between Chinese and Latin words or numbers (在 Mac 上, 3 个任务).
- **Truncation.** A label too long for its place ends in "…"; a path or branch truncates in the
  middle. Hints and details wrap; Chinese wraps between any two characters, never inside a Latin word.

## Using the sizes

- `Button`, `Select` and `Segmented` take `size`: `'small' | 'regular' | 'large'`, regular by
  default. A screen picks one by the rules above; it doesn't set its own height.
- A screen's own control (a module's `.button`, `.input`…) uses the tokens:
  `height: var(--control-h-small)`, not `height: 20px`.
- A new size is a change to this page first.

## Moving the app onto the scale

Most screens' own controls were sized one by one (about 300 heights between 18px and 34px). They
move in steps, each a PR that changes no behaviour:

1. The shared controls (`components/ui`, `Alert`, `FormSheet`, `Select`, Settings' controls), the
   tokens and the Chinese face. Done with this page.
2. The title row (window toolbar, the sidebar's buttons and search, the panel's view switcher) to
   Large; the right panel's and the dock's own toolbars and tabs to Small. Done.
3. Sheets with their own controls (`dialogs/native/*`, the new-task and new-plan sheets) to Regular:
   their fields, segmented controls and bottom buttons, and a button beside a field. Done; a
   row's own actions in a sheet's list stay Small.
4. Lists, cards and the conversation's own buttons to Small. Done: every `Button`, `IconButton`,
   `Select` and `Segmented` outside Settings, sheets, onboarding, calls and the phone view now names
   its size; the Overview's filter bar and the sentinel page's pickers moved too. Two designs keep
   their own shape on purpose: the composer (its chips and round send button) and the stat pills.
