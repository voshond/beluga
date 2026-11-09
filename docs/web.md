# Beluga in a browser

The daemon can serve the whole Beluga UI, the same React app the Mac shows, to any browser: on the
computer it runs on, through an SSH tunnel, Tailscale or a public link. This note is how that works
and what the app's native bits become in a browser. How to use it on a server:
[docs/headless.md](headless.md).

## The web port

`beluga web` opens a second listener beside the token socket the Mac app and tools use
(`src/daemon/web.ts`, `web-access.ts`):

- **Where**: `127.0.0.1:7777` by default, a fixed port so an SSH line stays the same
  (`ssh -L 7777:127.0.0.1:7777 box`). `--listen host:port` picks another address or port;
  `--allow-host name` adds a host name the page may be reached by (a Tailscale or tunnel name).
  It reopens at every start of the daemon until `beluga web stop` or Settings › Advanced › Web
  access, turned off (`~/.beluga/web.json`). An address others reach over plain http
  (`0.0.0.0`, a LAN address) is refused unless `--insecure-http` says so; Tailscale's `100.x`
  addresses are fine (see docs/security.md, Web access).
- **What**: the built UI (`packages/mac`'s `vite build`: `BELUGA_WEB_ROOT`, a packaged `web/`
  beside the engine, or the repo's `packages/mac/dist`). Hashed assets are cached for a year,
  everything else is revalidated; text goes br or gzip. Never a dotfile, a folder listing, a path
  out of the root, or Beluga's own files; Beluga's home is refused as a root.
- **The socket**: `/ws` hands a browser's socket to the daemon's own accept path, the one the Mac
  app uses, with the hello's token never read. The daemon's token never reaches the browser
  (`/__beluga/endpoint` only says `{ web: true }`; the page then connects to its own origin).
- **Checks**: the Host header must be a loopback name, an IP address or an allowed host (no DNS
  rebinding of 127.0.0.1); `/ws`, `/join`'s POST and `/upload` need the page's own Origin; every
  answer says `nosniff`, `no-referrer` and may not be framed, and the app's files come with the
  Mac app's content security policy.

## Installing it

The page is an installable web app (Add to Home Screen on a phone, Install or Add to Dock on a
computer): `packages/mac/public/manifest.webmanifest` opens it standalone with Beluga's icon
(`public/icons/`, made from the app's own). Only the manifest and the icons are served without a
session. There is no service worker: nothing of yours is kept offline.

## Browser sessions

Each browser is a device of yours, like a phone (`src/daemon/web-sessions.ts`, `web-join.ts`):

- `beluga web` (or Settings › Advanced › Web access › New Link) gives a **join link**,
  `http://127.0.0.1:7777/join#<128-bit secret>`: one use, 10 minutes. The secret is in the
  fragment, so it never reaches a server log or a Referer.
- The join page clears the fragment from the address bar at once, then trades the secret (a
  same-origin JSON POST, rate-limited: 10 wrong tries per address and 50 in all per 10 minutes)
  for a **session cookie**: `HttpOnly`, `SameSite=Strict`, `Path=/`, and on https `Secure` with the
  `__Host-` prefix. Only its SHA-256 is kept, in `~/.beluga/web-sessions.json` (0600), with the
  browser's name (browser and OS from its User-Agent), when it joined and when it was last seen. A
  browser not seen for 90 days has to join again.
- Without a valid cookie the web port serves only the **Ask for a link** page (and 401s), never the
  UI's files, and refuses the socket.
- **Revoking** one (`beluga web revoke <id or name>`, or Remove in Settings › Advanced › Web
  access) forgets it and closes its sockets at once (code 4401); its page reloads into the Ask page.
- The `web.*` API (`src/ipc/web-api.ts`): `web.link`, `web.sessions.list`, `web.sessions.revoke`,
  `web.stop`, `web.public`, `web.tailscale`, `web.download`. A browser is a `web` screen: it may list browsers and download, but
  links, revokes and closing the port are the Mac app's and the command line's. The CLI is
  `src/web-cli.ts`.

### Passwords instead of links

A name with a password lets a browser in without a join link: `beluga web passwd <name>` asks for
one (at least 10 characters; piped stdin works too) and `beluga web passwd --remove <name>` takes the
name away. Once a name exists, the Ask page becomes a sign-in form (`src/daemon/web-passwords.ts`,
`loginRoute` in `web-join.ts`); join links keep working beside it.

- Passwords are scrypt hashes in `~/.beluga/web-passwords.json` (0600), read on every sign-in, so a
  change counts at once. Accounts an older build kept in `web.json` move there once.
- `POST /login` takes JSON from the page's own origin only, and wrong passwords count against the
  join links' limiter (10 per address and 50 in all per 10 minutes; a public link's own, stricter one).
- A signed-in browser is a session like a joined one, named `<name>: <browser> on <OS>` and
  recorded with its name: changing or removing a password signs that name's browsers out.

## Reaching it from elsewhere

- **Through SSH** (`beluga connect user@host`, `src/cli/connect.ts`): run on the laptop. It asks
  the server for a join link over ssh (`beluga web link`, starting Beluga there first when it isn't
  running), opens `ssh -N -L 127.0.0.1:<free port>:127.0.0.1:7777 host`, and opens the browser at
  its near end. The tunnel comes back when it drops; Ctrl+C closes it. The host goes to ssh as
  typed, so aliases, users, ports and keys from the ssh config apply. Nothing is opened on the
  server. Without Beluga on the laptop, `beluga web` on the server prints the plain `ssh -N -L`
  line to paste.
- **On your tailnet** (`beluga web --tailscale`, `src/daemon/reach/tailscale.ts`): reads this
  machine's name and login from `tailscale status --json`, then runs `tailscale serve --bg
  --https=443 http://127.0.0.1:7777` (Serve, never Funnel: only the tailnet reaches it) and prints
  `https://<box>.<tailnet>.ts.net` with a QR for a phone's browser. Your own Tailscale login (this
  machine's owner, BLG-655) gets in without a join link; anyone else on the tailnet needs one; on a
  tagged machine nobody's login is trusted. The `Tailscale-User-Login` header is believed only on
  requests from loopback (tailscaled), under the ts.net name, while Serve is on; another local
  account on a shared box could forge it, so on such a box use join links. Missing Tailscale, a
  logged-out one, Serve needing an operator (`sudo tailscale set --operator=$USER`) or HTTPS
  certificates being off each get a one-line fix. Reopened at every start until `--off`, which runs
  `tailscale serve --https=443 off`.
- **A public link** (`beluga web --public`, `src/daemon/reach/public.ts`): a Cloudflare quick
  tunnel (the cloudflared the rooms and the phone relay use) to the web port. It prints the
  `https://<name>.trycloudflare.com` address and a join link under it, and says plainly what that
  exposes: **anyone with a join link gets in**. The address alone shows only the Ask for a link
  page. The web port answers to that name only while the tunnel is up. Wrong join links through it
  are limited harder (5 per visitor, by Cloudflare's `CF-Connecting-IP`, and 20 in all per 10
  minutes; a good link always works). When cloudflared stops or its name stops answering, a new
  tunnel opens (more slowly each time it fails) and its new address shows in `beluga status`
  and `web.sessions.list`. It is reopened at every start until `beluga web --off`.
- **In the Mac app**: Settings › Advanced › Web access, off by default. One switch, then Reached
  from: This computer only, Tailscale (offered when it's installed and logged in, `web.ways`) or
  Public link; the address, New Link with the link as a QR and Copy, and the browsers let in, each
  with Remove.
- **Off**: `beluga web --off` closes the web port, the public link and Tailscale Serve
  (`web.stop`), and they stay closed across restarts.

### Your own domain

A quick tunnel's name changes each time. With a Cloudflare account, a named tunnel keeps one
(`cloudflared tunnel create beluga`, then `cloudflared tunnel route dns beluga beluga.example.com`
and `cloudflared tunnel run --url http://127.0.0.1:7777 beluga`); with a server that has a public
address and a domain, Caddy gets the certificate itself:

```caddyfile
beluga.example.com {
	reverse_proxy 127.0.0.1:7777
}
```

Either way, let the web port answer to that name and take a link under it:
`beluga web --allow-host beluga.example.com`, then open the link with `127.0.0.1:7777` replaced by
`beluga.example.com`. The join limits there are the local port's (Caddy's requests all come from
loopback, so they share one count): keep the proxy for yourself.

## The app's native bits in a browser

A page served by the web port knows it (`webServed()` in `lib/boot.ts`); one from the development
server (vite, the e2e demo) is a plain browser and keeps its development behaviour. Every
`inApp()` branch, and what a served page does instead.

The Beluga app can also be a client of a server (Settings › Server, or "Connect to a server" on
first launch): it opens the server's page in its window. There the window's own bits take the
app's path and anything about files takes the browser's, since the files are the server's. Each
row's choice is a key of `REMOTE_APP_PATHS` in `lib/boot-mode.ts` (`native('<key>')` asks it);
the app commands the server's page may call go through the shell's `beluga` plugin
(`CLIENT_COMMANDS`, `src-tauri/src/remote.rs`), and only the saved server's origin gets IPC. How
to set one up, and what the server's agents may ask of it (device reach): [docs/thin-client.md](thin-client.md).

| Where (`packages/mac/src/…`) | In the app | In a served browser | In the Beluga app as a client |
| --- | --- | --- | --- |
| `main.tsx`, `popup/main.tsx`: `data-app="tauri"` | the window's own look (vibrancy, title bar) | a plain page (`data-web="true"`) | `look` the app's: the window's own look |
| `lib/boot.ts` `endpoint()` | asks Tauri for the daemon's port and token | `/__beluga/endpoint` says `{ web: true }`; the socket is this origin's `/ws`, its session cookie lets it in | `endpoint` the browser's: `/__beluga/endpoint` on the server, its session cookie |
| `lib/boot.ts` `copyText` cap, `lib/copy.ts` | the app's clipboard | `navigator.clipboard` (needs https or localhost) | `clipboard` the app's clipboard |
| `lib/term-clipboard.ts` a terminal's paste | the app's clipboard | `navigator.clipboard.readText()`; over plain http Ctrl+Shift+V is left to the browser, whose own paste reaches the terminal (right-click › Paste is off there), and an OSC 52 copy from a program only lands over https | `terminalPaste` the app's (copies through the app's clipboard) |
| `lib/boot.ts` `notify` cap | macOS banners with actions, the pop-up for requests | Web Notifications (asked once; needs https or localhost), clicking one goes to its chat or request; a friend's message is the in-window banner as in the app | `notify` the app's banners (sounds as in the app); requests show in the window, not the pop-up |
| `layout/NotificationCenter.tsx` the bell's list | a popover under the toolbar bell | the same; in a window too narrow to show the bell (a phone's browser) it opens as the Notifications page instead (`layout/NotificationsView.tsx`) | `noticeList` the same |
| `lib/boot.ts` `openExternal`, `lib/system.ts` | the default browser | a new tab | `openExternal` the app's: the default browser |
| `lib/boot.ts` `raise` | brings the window forward | `window.focus()` | `raise` the app's: brings the window forward |
| `lib/projects.ts` `pickFolders` (Add Project › Choose Folders…, New Project › Change…, Share a Folder, `FormSheet` folders, Settings › People & access › Add Folder…) | the Open panel | Beluga's own folder picker over the server's folders (`dialogs/FolderBrowser.tsx`, `local.browse`) | `pickFolders` the browser's: Beluga's folder picker over the server's folders |
| `lib/projects.ts` `pickImage` (a project's Change Icon…) | the Open panel | the browser's file picker; the image is uploaded and used from there | `pickImage` the browser's: uploaded to the server |
| `dialogs/AddProjectSheet.tsx` folder drop | folders dropped on the window are added | not offered (your computer's folders aren't the server's): "Choose a project folder where Beluga runs" with Choose Folders… | `addProjectDrop` the browser's: not offered |
| `chat/use-attachments.tsx` Finder drop | files dropped on a conversation attach by their path | files dropped on the message box are uploaded (`/upload`, into `~/.beluga/uploads`) and attach by their path there; images attach as pictures as before | `chatDrop` the browser's: uploaded to the server |
| `chat/paste-paths.ts` Paste as Plain Text | the app's clipboard | `navigator.clipboard.readText()` | `pastePlain` the app's clipboard |
| `network/NetComposer.tsx` paper clip | the Open panel | the browser's file picker, sent as data | `netAttach` the browser's file picker |
| `network/ConversationView.tsx` drop | the app's drop event | the browser's drop event, sent as data | `netDrop` the browser's drop event |
| `network/ChatFiles.tsx` Open, Show in Finder, Save As… | open, reveal, the Save panel | Download (a one-time `/download/<token>` link, `web.download`) | `chatFiles` the browser's: Download |
| `lib/files.ts` `revealInFinder`, `openWithDefaultApp`, `saveFile` | Finder, the default app, the Save panel | a file is downloaded; a folder's path is copied and said | `files` the browser's: downloaded from the server |
| `lib/save-text.ts` Save As… (tables) | the Save panel | a browser download | `saveText` the browser's: a download |
| `tasks/TaskSections.tsx` Add Files, Proof › Picture or File… | the Open panel | the browser's file picker, uploaded | `taskFiles` the browser's: uploaded |
| `tasks/use-task-drop.tsx` | Finder drops on a task, its card or row | the browser's drop on the same places, uploaded | `taskDrop` the browser's: uploaded |
| `layout/Sidebar.tsx` folder drop | folders dropped on the sidebar become projects | not offered (as Add Project) | `sidebarDrop` the browser's: not offered |
| `network/AddFriendSheet.tsx` paste a code | the app's clipboard | `navigator.clipboard.readText()` | `friendPaste` the app's clipboard |
| `network/net-native.ts` idle, your status | the Mac's idle time; the menu bar | the page's own input; nothing | `idle` the app's: this computer's idle time; the menu bar |
| `lib/native.ts` tray, Dock badge, deep links, window focus, notification taps | the menu bar icon, the Dock, `beluga://` links | hidden: the page's title and in-window banners only | `tray` the app's: menu bar icon, badge, focus, taps and widget or network links; room invites aren't (they restart a local Beluga) |
| `lib/updates.ts`, `dialogs/UpdateSettings.tsx` | checks, downloads and installs updates | hidden: the server's Beluga updates, not the page | `updates` the app's: the client app updates itself, never the server |
| `dialogs/Settings.tsx` Menu Bar pane, Reduce transparency | the menu bar icon, vibrancy | hidden | `menuBarPane` the app's |
| `dialogs/VoiceSettings.tsx` From any app, `lib/dictation.ts` global shortcut | a shortcut that works in any app | hidden: the shortcut works while the page has focus | `globalShortcut` the app's: a shortcut that works in any app |
| `layout/AppMenu.tsx`, `lib/app-menu-model.ts` the menu bar | the menu bar: Settings… (⌘,) and the rest | a gear button at the sidebar's top left (in the toolbar while the sidebar is hidden): Settings…, Keys and Commands, Everything You Can Do…, then File, View and Go, run as the menu bar's items are. Left out: what does nothing in a browser (updates, Window, Quit, Open the Log) and the Conversation and Workspace menus, which the toolbar shows | `appMenu` the app's menu bar |
| `lib/web-history.ts`, `layout/WebBack.tsx` where you are | the window remembers nothing across a reload; each page's own Back | the address follows the view (`#/task?id=BLG-12`, `lib/web-history-model.ts`; drafts are left out), so a reload or a shared address opens the same place; the browser's Back and Forward step through the views, and a Back button sits beside the gear (greyed out when there's nowhere to go back to) | `webHistory` the browser's: a reload keeps your place |
| `lib/shortcuts.ts` menu keys | the app's menu shows your shortcuts | nothing to send (the page has no menu bar) | `menuKeys` the app's |
| `lib/sounds/*` | macOS sounds, installed for banners | Beluga's own sounds in the page; macOS system sounds are left out | `sounds` the app's |
| `lib/sounds/access.ts`, `lib/privacy.ts` | asks macOS about notifications, the screen, the microphone | the browser's permissions | `access` the app's: asks this computer's OS |
| `lib/window-active.ts` | the window's focus | the page's visibility and focus | `windowActive` the app's: the window's focus |
| `gateway/popup-bridge.ts`, `gateway/request-native.ts` | the floating request pop-up, notification buttons | requests in the window (NeedsYou and the Requests view) | `requestPopup` the browser's: requests in the window |
| `gateway/AccessSettings.tsx` Add Folder… | the Open panel | Beluga's folder picker | `accessFolder` the browser's: Beluga's folder picker |
| `layout/ProjectTree.tsx` Change Icon… | the Open panel | the browser's file picker, uploaded | `projectIcon` the browser's: uploaded |
| `lib/native-routes.ts` Share a Folder… | the Open panel, then who | the Share a Folder sheet with Choose… (Beluga's folder picker) | `shareFolder` the browser's: the Share a Folder sheet |

Uploads (`src/daemon/web-files.ts`) go to `~/.beluga/uploads/<day>/<random>/<name>` (0600 files in
0700 folders), up to 512 MB each, only from the page's own origin and a browser that's let in.
Downloads are one-time links, good for a minute; a friend's shared file is fetched to the server
first and deleted once it's sent.

## The same bits on one of your computers' pages

A page of one of your computers (BLG-784) draws in your own app, so the app's native bits work, but
what they name is on this Mac while the work runs there. The same list applies, done this way
(BLG-793):

- A pasted or dropped picture goes as bytes (`attachments.add` runs on the computer), as in a browser.
- Files dropped from Finder on the message box go there a piece at a time (`machines.upload.send`:
  this Mac's daemon reads each piece and puts it there with `machines.upload.put`, into
  `~/.beluga/uploads` there), with their progress in the box, then wait by their path there.
- Folder pickers on its page (`pickFolders` with the page's computer: a form's folder, Import a
  Conversation) walk that computer's folders with Beluga's own picker (`local.browse` there).
