# Beluga in a browser

`cli.js web` puts a sign-in in front of Beluga's window, so you can use Beluga from a browser on
another computer. The daemon keeps running on this machine and stays on `127.0.0.1`. The gateway
(`src/web/gateway.ts`):

- serves the built window (`packages/mac/dist`) only after you sign in,
- proxies the window's WebSocket to the daemon and puts the daemon's token into its `hello` on the
  way through, so the token never leaves this machine,
- accepts the socket and form posts only from its own origin, and closes a session's sockets
  when it signs out.

Whoever signs in can run terminals and agents here, so treat the password like a shell login.

```sh
cd packages/mac && npm ci && npm run build      # the window
npx tsx src/cli.ts daemon --keep-alive          # the daemon (from the repo root)
npx tsx src/cli.ts web passwd voshond           # add an account / change its password (stdin)
npx tsx src/cli.ts web                          # http://127.0.0.1:8420, this machine only
npx tsx src/cli.ts web --tunnel                 # plus a public https://…trycloudflare.com address
```

- **Accounts and sessions** are kept in `~/.beluga/web.json` (0600): scrypt password hashes and
  SHA-256 hashes of session cookies. A session lasts 30 days. Changing a password signs that
  account out everywhere.
- **Wrong passwords:** five per address in 15 minutes, then that address waits. After 30 across
  all addresses, sign-in waits for everyone.
- **The tunnel** is a Cloudflare quick tunnel: free and needs no account, but its address changes
  every time it starts and has no uptime guarantee. For a fixed address, run a named Cloudflare
  tunnel (or any reverse proxy with HTTPS) to `127.0.0.1:8420`. It must set `X-Forwarded-Proto: https`
  so the cookie is marked `Secure`.
- **Not yet:** GitHub sign-in, more than one person's own space (every account is this machine's
  user), and the Mac-only parts of the window (native notifications, the floating pop-up, Finder).
