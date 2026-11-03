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
`inApp()` branch, and what a served page does instead:

| Where (`packages/mac/src/…`) | In the app | In a served browser |
| --- | --- | --- |
| `main.tsx`, `popup/main.tsx`: `data-app="tauri"` | the window's own look (vibrancy, title bar) | a plain page (`data-web="true"`) |
| `lib/boot.ts` `endpoint()` | asks Tauri for the daemon's port and token | `/__beluga/endpoint` says `{ web: true }`; the socket is this origin's `/ws`, its session cookie lets it in |
| `lib/boot.ts` `copyText` cap, `lib/copy.ts` | the app's clipboard | `navigator.clipboard` (needs https or localhost) |
| `lib/boot.ts` `notify` cap | macOS banners with actions, the pop-up for requests | Web Notifications (asked once; needs https or localhost), clicking one goes to its chat or request; a friend's message is the in-window banner as in the app |
| `lib/boot.ts` `openExternal`, `lib/system.ts` | the default browser | a new tab |
| `lib/boot.ts` `raise` | brings the window forward | `window.focus()` |
| `lib/projects.ts` `pickFolders` (Add Project › Choose Folders…, New Project › Change…, Share a Folder, `FormSheet` folders, Settings › People & access › Add Folder…) | the Open panel | Beluga's own folder picker over the server's folders (`dialogs/FolderBrowser.tsx`, `local.browse`) |
| `lib/projects.ts` `pickImage` (a project's Change Icon…) | the Open panel | the browser's file picker; the image is uploaded and used from there |
| `dialogs/AddProjectSheet.tsx` folder drop | folders dropped on the window are added | not offered (your computer's folders aren't the server's): "Choose a project folder where Beluga runs" with Choose Folders… |
| `chat/use-attachments.tsx` Finder drop | files dropped on a conversation attach by their path | files dropped on the message box are uploaded (`/upload`, into `~/.beluga/uploads`) and attach by their path there; images attach as pictures as before |
| `chat/paste-paths.ts` Paste as Plain Text | the app's clipboard | `navigator.clipboard.readText()` |
| `network/NetComposer.tsx` paper clip | the Open panel | the browser's file picker, sent as data |
| `network/ConversationView.tsx` drop | the app's drop event | the browser's drop event, sent as data |
| `network/ChatFiles.tsx` Open, Show in Finder, Save As… | open, reveal, the Save panel | Download (a one-time `/download/<token>` link, `web.download`) |
| `lib/files.ts` `revealInFinder`, `openWithDefaultApp`, `saveFile` | Finder, the default app, the Save panel | a file is downloaded; a folder's path is copied and said |
| `lib/save-text.ts` Save As… (tables) | the Save panel | a browser download |
| `tasks/TaskSections.tsx` Add Files, Proof › Picture or File… | the Open panel | the browser's file picker, uploaded |
| `tasks/use-task-drop.tsx` | Finder drops on a task, its card or row | the browser's drop on the same places, uploaded |
| `layout/Sidebar.tsx` folder drop | folders dropped on the sidebar become projects | not offered (as Add Project) |
| `network/AddFriendSheet.tsx` paste a code | the app's clipboard | `navigator.clipboard.readText()` |
| `network/net-native.ts` idle, your status | the Mac's idle time; the menu bar | the page's own input; nothing |
| `lib/native.ts` tray, Dock badge, deep links, window focus, notification taps | the menu bar icon, the Dock, `beluga://` links | hidden: the page's title and in-window banners only |
| `lib/updates.ts`, `dialogs/UpdateSettings.tsx` | checks, downloads and installs updates | hidden: the server's Beluga updates, not the page |
| `dialogs/Settings.tsx` Menu Bar pane, Reduce transparency | the menu bar icon, vibrancy | hidden |
| `dialogs/VoiceSettings.tsx` From any app, `lib/dictation.ts` global shortcut | a shortcut that works in any app | hidden: the shortcut works while the page has focus |
| `lib/shortcuts.ts` menu keys | the app's menu shows your shortcuts | nothing to send (the page has no menu bar) |
| `lib/sounds/*` | macOS sounds, installed for banners | Beluga's own sounds in the page; macOS system sounds are left out |
| `lib/sounds/access.ts`, `lib/privacy.ts` | asks macOS about notifications, the screen, the microphone | the browser's permissions |
| `lib/window-active.ts` | the window's focus | the page's visibility and focus |
| `gateway/popup-bridge.ts`, `gateway/request-native.ts` | the floating request pop-up, notification buttons | requests in the window (NeedsYou and the Requests view) |
| `gateway/AccessSettings.tsx` Add Folder… | the Open panel | Beluga's folder picker |
| `layout/ProjectTree.tsx` Change Icon… | the Open panel | the browser's file picker, uploaded |
| `lib/native-routes.ts` Share a Folder… | the Open panel, then who | the Share a Folder sheet with Choose… (Beluga's folder picker) |

Uploads (`src/daemon/web-files.ts`) go to `~/.beluga/uploads/<day>/<random>/<name>` (0600 files in
0700 folders), up to 512 MB each, only from the page's own origin and a browser that's let in.
Downloads are one-time links, good for a minute; a friend's shared file is fetched to the server
first and deleted once it's sent.
