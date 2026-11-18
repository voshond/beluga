# Honcho: a model of you, built from your conversations

[Honcho](https://github.com/plastic-labs/honcho) is an open-source memory server by Plastic Labs. It reads conversations and slowly builds a model of the people in them: how you like to work, what you know, what you care about. Beluga can feed it your own conversations so that, later (BLG-101), your agents can ask it about you.

It is **off until you set it up**, and it never runs on a friend's work. Beluga only talks to Honcho over its HTTP API; no Honcho code is part of Beluga (Honcho is AGPL-3.0).

Settings › Advanced › Honcho has everything: the on/off switch, the server, the API key, the workspace, a Test button, how many messages have gone and when, and a switch per project.

## Set up your own server (recommended)

Your own Honcho keeps your conversations on your machines. It runs as a Docker stack: the API (port 8000), a background worker Honcho calls the deriver, Postgres with pgvector, and optionally Redis. The deriver needs a key for one LLM provider (OpenAI, Anthropic, Gemini, or an OpenAI-compatible local endpoint). That is billed by that provider, outside your Claude plan.

1. Follow Honcho's guide: <https://honcho.dev/docs/v3/contributing/self-hosting>. In short: clone the repo, copy its example environment file to `.env`, set your LLM provider key, then start it with `docker compose up -d`.
2. Check it answers from the computer Beluga runs on: `curl http://<host>:8000/health` should answer (it only shows the API runs, not that the deriver or database work).
3. In Beluga, open Settings › Advanced › Honcho:
   - **Server**: `http://localhost:8000` when Honcho runs on the same computer, or `http://<lan-address>:8000` (for example `http://192.168.2.125:8000`) on another one on your network. A plain `http` address is fine there; no domain is needed.
   - **API key**: leave it empty when the server runs without auth (Honcho's default, `AUTH_USE_AUTH=false`). With auth on, paste a JWT made with Honcho's `scripts/generate_jwt_secret.py`.
   - **Workspace**: `beluga` unless you want another name.
4. Press **Test**. It says *Connected* when Honcho answered and the workspace exists, or what went wrong (not reachable, refused key, not a Honcho server).
5. Turn on **Send conversations to Honcho**.

Honcho's compose file binds its ports to `127.0.0.1`. To reach it from another computer on your network, publish port 8000 on the LAN address, or put it behind your reverse proxy. Without auth, anyone who reaches that port can read and write your Honcho: keep it off the internet, or turn auth on.

## Or use Honcho's cloud

1. Make an account and an API key at <https://app.honcho.dev>.
2. In Settings › Advanced › Honcho, set **Server** to `https://api.honcho.dev` and paste the **API key**.
3. Press **Test**, then turn on **Send conversations to Honcho**.

Your messages are then stored and processed by Plastic Labs under their terms.

## What leaves this computer

Only while the switch is on, and only from the moment it was turned on (nothing from before is sent, and nothing from while it was off):

| Sent | Not sent |
|---|---|
| Messages you type in your own chats, worktrees and Your Mac chats | Anything in the room, direct messages or group chats with friends |
| Your own agents' final answers to you, with the runtime and model | Friends' messages, and every run done for a friend |
| The conversation's project name, its title, its kind (chat, worktree, Your Mac) and its channel id | Chats or worktrees shared with someone else |
| When each message was said | Agent threads (chats one agent started for another) and messages an agent or an app wrote for you |
| | Tool calls and their output, and `console` or `beluga-*` blocks inside an answer (shown as `[…]`) |
| | Any message that looks like it holds a secret (an API key, a token, a password in a connection string, a private key): left out whole |
| | Projects you switched off under Projects sent to Honcho |
| | Files, attachments, diffs and terminal output |

In Honcho, everything goes to one workspace (default `beluga`). You are one peer, `user`; each agent runtime is its own peer (`agent-claude`, `agent-codex`, …), set so Honcho models you and not the agents. Each conversation is one session, `beluga-<channel>`. Honcho is yours alone: it is never shared with a room or with friends, and two of your own computers pointed at the same server and workspace both feed the same `user`.

## Never in the way

Messages wait in a queue in the background and go in batches per conversation. A run never waits for Honcho, and Honcho being down never fails one. When it does not answer, Beluga tries again (2 s, 4 s, 8 s… up to 5 minutes between tries) and gives up on a batch after 8 tries; a refusal that won't change (a bad key, a malformed request) drops that batch at once. Settings shows the last problem. What waits is kept in memory only: quitting Beluga drops it.

## The key

The server, the key and the counts live in `~/.beluga/honcho.json`, readable only by you (mode 0600). The key is never shown back in Settings, never sent to the phone, never in a report, a log or the black box, and external agents and friends' runs cannot read or change any of this (`honcho.*` is refused to them). The phone has no Honcho settings at all.

## Turning it off

Turning the switch off stops sending at once and drops what was waiting. What Honcho already has stays on that server: delete the workspace there (Honcho's API or its dashboard) to remove it.
