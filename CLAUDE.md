# Beluga

The engine (`src/`, the daemon) and its two screens: the Mac app (`packages/mac`) and the phone
companion (`packages/companion`). Both screens drive the same core through `src/ipc/api.ts`.
How it fits together: `docs/how-it-works.md`.

## Keep the phone in step with the Mac

The Mac app moves fast; the phone must never fall behind silently. Whenever you change the
daemon or the Mac app, check the phone too, in the same change:

- **A new or changed API method** (`src/ipc/*-api.ts`): classify it in `src/companion/coverage.ts`
  as `phone` or `mac` (the typecheck fails until you do). `phone` only for what fits the phone:
  reading, answering, asking, chatting, and (BLG-42) a worktree's Files and Terminal. Never
  editing, diffs, git beyond Merge, or settings.
- **A change to what a screen shows** (conversations, sub-agents, outputs, plans, approvals,
  questions, friends' requests, chats, usage): update its view in `src/companion/views.ts`, and the
  phone screen that draws it in `packages/companion/app/`. Run `npx vitest run tests/companion-*`.
- **Something new that waits for the user** (a new kind of approval, question or decision): it
  must reach the phone as a `NeedsYou` item with its actions, and notify. A phone that doesn't know
  the kind shows a plain card, so add it to the phone's cards too.
- **The link's frames or the views' shape** (`src/companion/protocol.ts`): additive changes only
  within `COMPANION_PROTO.major`. A breaking change bumps the major, keeps the old one answered for a
  release, and is written up in `docs/companion.md`.
- What goes to the phone, and how (BLG-42):
  - **Source is read-only, and only in Files.** A worktree's own files go only through the
    companion's file gate (`src/companion/worktree-files.ts`): inside that worktree (links followed
    and checked again), never `isSecretPath`, read in 512 KB pages with secrets redacted. Nothing
    on the phone can save, format or otherwise change a file.
  - **Everywhere else, no code.** Outputs still go only through `isArtifact` and never
    `isSecretPath` (`src/companion/files.ts`); Claude's answers still go through `stripCode`.
  - **The terminal is interactive and shared with the Mac.** A worktree's terminals are the
    daemon's own PTY sessions, the ones the Mac's dock shows (`src/companion/terminals.ts`): the
    phone streams them and types into them, the session keeps the Mac's size, and who attached and
    how much they typed is logged (never what). Only terminals of your worktrees; gated by
    `SINCE.terminal`.
  - **Still never:** editing, diffs, git writes beyond Merge, settings, or secrets.
- The phone's look (`packages/companion/lib/theme.ts`): soft pastels and icons, never glows or
  neon. Headers and toolbars are solid with a hairline once scrolled, never a gradient fade. One main action on the surface; advanced options go behind the ••• / long-press sheet or
  Settings › Advanced, never as extra buttons.

## Also kept in step

- `docs/parity.md` lists every command, UI action, menu and API method with where the Mac shows it
  (`tests/parity.test.ts`).
- The core stays free of UI code (`tests/boundaries.test.ts`); what the screens import stays
  browser-safe (`tests/browser-safe.test.ts`), and `src/companion/protocol.ts` too: zod only.

## Releasing the phone app

- Build the APKs only with `npm run apk` in `packages/companion`. It signs both with Beluga's own key (`~/.beluga-release/`, password in the Keychain), checks them against `signing.json`, and writes `dist/Beluga-<version>.apk` and `dist/Beluga-Link.apk`. Attach both to the release under exactly those names: phones update themselves from `releases/latest` by looking for `Beluga-<version>.apk`.
- Never attach an APK from a plain `./gradlew assembleRelease`. It carries the debug key, so phones refuse it as an update and Beluga Link stops trusting the app.
- Raise `android.versionCode` in `packages/companion/app.json` every release.
- The first release with the new key (the one after 1.7.0) must tell phone users, once: uninstall Beluga and Beluga Link, install this version, pair again. More in `docs/updates.md` ("The phone app's signing key").

## Tests that pass everywhere

Your run is on a fast, quiet Mac. CI also runs every test on Linux and Windows, on shared runners
that stall for seconds, and a PR then fails for a test it never touched. Most failed runs were that,
not a real break. So a test you write or change:

- **Waits for a condition, never for a time.** `waitFor(() => …)` (`tests/helpers.ts`), not
  `setTimeout(r, 150)` then an `expect`. A step that needs two things at once holds until both
  are there, not for a set time.
- **Never asserts how long something took** or how idle the machine is (an event loop under
  15 ms, a run within 5 s). Test the rule on fixed numbers, or with a clock passed in (`now`).
- **Never races two changes through a sleep.** Two changes "before either sends" are made back to
  back with no `await` between them, so no timer can run in between. A 5 ms sleep there can last
  200 ms on a busy runner.
- **Uses ports the system gives** (`listen(0)`). A port found free and used later can be taken by
  then: when the code needs a set port, try another one on `EADDRINUSE`.
- **Builds and compares paths with `path.join` and `realpathSync`**, never `/` in a regex or a
  string. Windows paths use `\`, and its temp folder has a short and a long name.
- **Stands in for a program with node, not `#!/bin/sh`** (Windows can't run a shell script by
  name), or skips Windows with `it.skipIf(process.platform === 'win32')` and says why.
- **Stops what it started before deleting its folder:** shells, git, servers, writes still in
  flight. Windows won't delete a folder a process is still in.
- **Gives slow setup room:** a `beforeAll` that builds a demo Mac (`createDemoWorkspaces`) or a
  testnet takes its own timeout (`120_000`), as Windows can take 30 s for it.

A test that fails on CI and not here is almost always one of these: find which, and fix that. A
longer timeout alone only makes it fail less often.

## Checks

`npm run typecheck`, `npx vitest run`, and in `packages/companion`: `npm run typecheck`.

Run the whole `npx vitest run` after your last change, before you commit. When every test passes on
a Mac it ends with a `Tested-on: macOS <tree>` line. Put that line, as it is, at the end of the
commit message, and commit every file it tested (nothing changed since the run). CI then skips its
macOS run for that commit (`scripts/local-pass.mjs`), and Linux and Windows still run there. No line
(a failure, part of the suite, a file changed during the run) means don't add one.
