# Beluga on Linux and Windows

The same Beluga runs on Linux and Windows. Some things stay Mac only.

## What's different there

| | macOS | Linux | Windows |
|---|---|---|---|
| Main shortcut key | ⌘ | Ctrl | Ctrl |
| Keys shown as | ⇧⌘F | Ctrl+Shift+F | Ctrl+Shift+F |
| Copy and paste in the terminal | ⌘C / ⌘V | Ctrl+Shift+C / V | Ctrl+Shift+C / V |
| Shell for setup and run commands | your shell | your shell | Git Bash (Git for Windows), the shell Claude Code uses too |
| A friend's screenshot | screen or one app's window | whole screen (grim, gnome-screenshot, spectacle, scrot or ImageMagick) | screen or one app's window |
| Device info | sw_vers, system_profiler, pmset | os-release, /sys | PowerShell (CIM) |
| Keeping awake for the phone | caffeinate | systemd-inhibit | SetThreadExecutionState |
| Moving to the Trash | Finder / trash | gio trash | Recycle Bin |
| Window | blur, traffic lights | solid, Beluga's own title bar: close, minimize and maximize at the sidebar's top left, then the gear with the menus (no GTK menu bar); a page that doesn't draw it (an older server's) keeps the desktop's | solid, the system title bar |
| Window size and place | saved when you quit, close the window or leave it | saved when you quit, close the window or leave it, so a logout or a kill keeps it (Wayland restores the size only) | saved when you quit, close the window or leave it |
| Packages | .dmg | AppImage (updates itself), .deb, .rpm | installer (updates itself) |
| Sound and media in the window | built in | GStreamer: the AppImage carries its plugins (so it works on Arch, CachyOS and the like); the .deb and .rpm depend on the base and good plugins | built in |

Mac only: desktop widgets, Focus, the macOS permission steps in the welcome, the Dock badge,
sleeping only after the outbox is mailed (BLG-277), and notification sounds played from files
(on Linux and Windows the window plays them).

Shortcuts that use ⌃ on a Mac have their own keys elsewhere: Toggle Sidebar is Ctrl+B,
Approve / Decline / Always Allow are Alt+Shift+Y / N / A, Move Project is Alt+Shift+↑/↓, and
Archive has no key (it's in the menu and ⌘K).

## Where the platform code lives

- The daemon branches by `process.platform` where the systems differ, behind the ports that
  already existed (SystemPort in `src/core/gateway/device.ts`, `Awake`'s platform option), so
  tests fake Linux and Windows on any machine (`pretendSystem({ platform })`).
- `src/core/process-tree.ts` stops a command together with everything it started: a process
  group on Mac and Linux, `taskkill /T` on Windows (where `detached` would open a console).
- `src/terminal/pty.ts`: `defaultShell` and `posixSh` for each system.
- The shortcut table (`packages/mac/src/lib/shortcuts-model.ts`) reads "Cmd" as the main
  modifier, as Tauri's CmdOrCtrl does. `keyPlatform()` says which keyboard it is.
- The Tauri shell gates Mac-only code with `cfg(target_os = "macos")`.
  `tauri.linux.conf.json` and `tauri.windows.conf.json` set the window and the bundles.
- Windows and Linux give every window the app's menu bar. The small windows (the request card, the
  call card, the call overlay) take it off with `menu::without_menu_bar` and `menu::drop_menu_bar`:
  on Linux they start with an empty menu, because taking the app's menu off a GTK window makes GTK
  warn once per shortcut ("no accelerator … installed in accel group"). A language switch clears
  the old menu's shortcuts (`menu::clear_keys`) before swapping it out, for the same reason.

## Installing from a checkout

`bash scripts/install-linux-app.sh --build` builds the app and installs it for your user, with no
package: the binaries in `~/.local/opt/beluga-thin` (`BELUGA_APP_DIR` to change it), the icon in
each hicolor size (32 to 512) and `io.github.kayraucklnc.beluga.desktop`, which GNOME matches to
the window (`StartupWMClass=beluga-mac`) and which opens `beluga://` and `klaud://` links. Without
`--build` it installs what's already built. The .deb, .rpm and AppImage get the same icon sizes
from `tauri.linux.conf.json`.

## Checks and releases

- `ci.yml` runs the tests on Ubuntu. macOS and Windows are tested locally.
- `desktop.yml` builds the Rust shell with clippy and runs its tests on Linux and Windows. It
  runs by hand only (Actions → Run workflow).
- `release-desktop.yml` runs when a `-mac` release is published (or by hand for a tag). It
  builds the Linux and Windows packages, uploads them to the same release, and adds
  `linux-x86_64` and `windows-x86_64` to its `latest.json`. `release-mac.mjs` keeps those
  entries when it uploads again.
- The repository needs the `TAURI_SIGNING_PRIVATE_KEY` (and `_PASSWORD`) secrets for update
  signatures. Windows code signing isn't set up yet, so SmartScreen warns on the first install.
