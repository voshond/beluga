# The desktop app as a thin client

Beluga can run on one always-on computer (a server, see [docs/headless.md](headless.md)) while you
work from others. The desktop app can be a client of that server: it starts no Beluga of its own
and opens the server's page in its own window, with the app's notifications, clipboard, tray and
links instead of a browser tab. The server's agents can then ask that client for a command, a file
or a screenshot, and you approve each one at the client.

## On the server

The app reaches the server's web port (`beluga web`, [docs/web.md](web.md)) at its own https
address. Put the web port behind your reverse proxy on your own domain, and let it answer to that
name ([Your own domain](web.md#your-own-domain)):

```sh
beluga web --allow-host beluga.example.com
beluga web link            # a join link for the app (one use, 10 minutes)
beluga web passwd <name>   # or: a name and password to sign in with
```

The app accepts `https://` addresses, and plain `http://` only for `127.0.0.1` or `localhost`.
Typed without a scheme, an address means `https://`, except `127.0.0.1` and `localhost`, which mean
`http://` (an SSH tunnel). Before the window opens the server, the app loads it once itself: a TLS
error or an error status shows **Can't reach the server** with the reason, **Retry** and **Change
server**, never a blank window.

## Connect the app

1. Install the desktop app on the client (the same app as for Running Beluga here).
2. On first launch pick **Connect to a server**. Later: Settings › Server › **Connect to a
   Server…** (or **Change Server…**).
3. **Server address**: `https://beluga.example.com`, or the join link itself with
   `127.0.0.1:7777` replaced by your domain (`https://beluga.example.com/join#…`).
4. **This device's name**: how the server's agents name this computer. It starts as the
   computer's host name; change it later in Settings › Server.
5. The server's page opens in the window. A join link signs you in at once; otherwise sign in
   there with your name and password. The session cookie stays in the app's own web storage, so
   the next launch goes straight in.

Nothing runs on the client: projects, agents, worktrees and files are the server's. Anything about
files acts as in a browser (the server's folder picker, uploads for what you drop, downloads for
what you save); the window's own bits (notifications, tray, clipboard, the app's updates) are the
app's. If the server can't be reached the window says why, with **Retry** and **Change server**
(where Run Beluga here is too).

## Device reach

While the app is connected, the server's agents see it as a device: `list_devices` names it,
with its OS and what it allows. They can ask it for three things:

| Tool | What happens at the client after you approve |
| --- | --- |
| `run_on_device` | runs one command in your login shell (`$SHELL -lc`), with no input. It stops after 120 s (the agent may ask for up to 600 s); stdout and stderr come back cut at 64 KB each, with the exit code. |
| `get_device_file` | reads that one file and uploads it to the server. Files over 512 MB are refused. |
| `device_screenshot` | takes a screenshot of your screens and uploads it to the server as a png. |

Files and screenshots land on the server in `~/.beluga/uploads/<day>/<random>/`, and the agent is
told the path there.

### What an approval looks like

Each request opens a small window of the app, on top of the others:

- **What**: the exact command with its folder and time limit, the file's full path and size (read
  from the disk's listing: nothing is read before you approve), or that a screenshot of your screens
  will be sent.
- **Who and why**: which agent asked, from which conversation, and the reason it gave.
- **Run** (or **Send**) and **Deny**. Deny has the focus, so Return or Space denies; so does Escape.
  Closing the window denies. With no answer, it denies by itself after 25 seconds (the window counts
  down).

A denial reaches the agent as "refused", and it is told not to ask again for the same thing. Only
one approval shows at a time; others wait their turn, and their 25 seconds include the wait.
Requests are approved only at the client: they never go to the phone or to other screens.

Commands and files that touch secrets (`.env` files, keys, `.ssh`, `.aws`, credential files,
`~/.beluga`) are refused on the server and again in the app, without asking you.

### Screenshots on each system

- **Linux**: through xdg-desktop-portal's Screenshot. On GNOME (Wayland too) it takes the picture
  without a dialog of its own. The portal saves a copy in `~/Pictures`; the app removes that copy
  once it has read it.
- **macOS**: through `screencapture`. The first time, macOS asks for Screen Recording: allow
  Beluga in System Settings › Privacy & Security › Screen Recording, then ask again.
- **Windows**: not supported yet. The app offers commands and files only, and a screenshot request
  answers that.

## Also works

- **Tailscale**: `beluga web --tailscale` gives a `https://<machine>.<tailnet>.ts.net` address;
  enter it as the server address ([Through Tailscale](headless.md#through-tailscale)).
- **An SSH tunnel**: `ssh -L 7777:127.0.0.1:7777 <server>`, then `http://127.0.0.1:7777`
  ([Through SSH](headless.md#through-ssh)).

## When something doesn't work

- **"Nothing answers at …"**: the address or port is wrong, or `beluga web` isn't running on the
  server.
- **The window shows only "Unknown host"**: the web port doesn't answer to your domain yet. Run
  `beluga web --allow-host <your domain>` on the server.
- **The Ask for a link page**: this app's session was revoked or expired. Make a new join link
  on the server (`beluga web link`) and open it as the server address.
- **An agent says no device is connected**: the app must be open and connected, and the device
  shows in `list_devices` only while it is.
