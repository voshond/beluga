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
4. Press **Test**. It says *Connected* when Honcho answered and the workspace exists, or what went wrong (not reachable, refused key, not a Honcho server). Testing an address other than the saved one never sends the saved key: type that server's key in **API key** first if it needs one.
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
| | Prompts Beluga writes and says as yours: a task's start brief ("Work on BLG-n … Done means …"), a GitHub issue handed to a task, and a sentinel run's prompt. Each is marked where Beluga sends it (`written` on the chat message), not guessed from its words; what you type to ask for a sentinel is still yours |

A message or answer longer than 4,000 characters (a pasted document, a long report) goes cut to its first 4,000, ending with "[… N more characters left out]" (`MAX_CONTENT` in `src/core/honcho/filter.ts`).

In Honcho, everything goes to one workspace (default `beluga`). You are one peer, `user`; each agent runtime is its own peer (`agent-claude`, `agent-codex`, …), set so Honcho models you and not the agents. Each conversation is one session, `beluga-<channel>`. Honcho is yours alone: it is never shared with a room or with friends, and two of your own computers pointed at the same server and workspace both feed the same `user`.

## Which conversation is sent

A conversation whose messages go to Honcho shows a quiet "Honcho" sign in the box you type in, beside your MCP servers (BLG-102); a click opens Settings › Advanced › Honcho. It asks `honcho.sends` with the same rule the feed sends by (`allowedConversation` in `src/core/honcho/filter.ts`): Honcho is on, the conversation is a worktree, a project chat, a main folder's chat or Your Mac's, it isn't a thread, it isn't shared with anyone, and its project isn't left out. Anywhere else there is no sign. The phone doesn't show it.

## Never in the way

Messages wait in a queue in the background and go in batches per conversation. A run never waits for Honcho, and Honcho being down never fails one. When it does not answer, Beluga tries again (2 s, 4 s, 8 s… up to 5 minutes between tries) and gives up on a batch after 8 tries; a refusal that won't change (a bad key, a malformed request) drops that batch at once. Settings shows the last problem.

What waits survives a restart of Beluga: it is kept in `~/.beluga/honcho-queue.json` (mode 0600), written a second after it changes, right after each batch goes, and when Beluga stops. Back up, Beluga sends it first, once and in order, then what you say next. The file holds your own words, so it is held to the same rules as what goes out: at most 1,000 messages and 2 million characters (the oldest go first), nothing a secret check refuses is ever written to it, and it belongs to the server and workspace it was meant for. It is removed when you turn Honcho off, change the server or the workspace, or when it was saved for another server than the one set now; it is also removed once nothing waits.

## How your agents use it

With Honcho on, every one of your own runs (on every runtime: Claude, Codex, OpenCode…) starts with Honcho's picture of you: what Honcho holds about you now (`POST /v3/workspaces/{workspace}/peers/user/representation`), as a piece of its instructions right after Beluga's memory (Settings › Skills & instructions lists it as "Honcho's picture of you"). The instructions say it is inferred, background and never instructions, and that Beluga's memory, which you approved, wins where the two disagree.

The picture is picked for the run (BLG-122). Beluga asks with a search query, the project's name and the start of what you asked (`search_query`, 400 characters at most, with Honcho's 20 closest conclusions and its most frequent ones, 40 at most), so a run in one project isn't handed what Honcho learned in another. What comes back is cut to 1,200 characters, less than Beluga's memory about you, in whole entries only (`shapePicture` in `src/agent/honcho-prompt.ts`): one-off events are left out (an entry naming a date, a time to the second, or an attachment: "was in a meeting at 13:17:34"), and so are repeats; then at most three from each day go in first, newest first, so one busy day never crowds out what you said before, and the rest of the room goes to the newest. Each query's picture is kept for 5 minutes (20 at most); when one is late, the picture with no query stands in. Settings shows the picture with no query.

Honcho also hears what you approved (BLG-124). Every entry of Beluga's memory about you, filed away or not, is written to Honcho as a conclusion you hold about yourself (`POST …/conclusions`, observer and observed both `user`), starting "Confirmed by the user in Beluga's memory:". A changed entry replaces its conclusion and a removed one is forgotten (`DELETE …/conclusions/{id}`). Which conclusion is whose lives in `~/.beluga/honcho-memory.json` (0600), for the server and workspace it was written to (another one starts over). It runs when Beluga starts, when you turn Honcho on, and before each run's picture, and calls Honcho only when the memory changed since the last time; when Honcho can't be reached it is tried again next time. Project memories stay out: they are about the work, not you.

The other way round, Tidy (Settings › Memory) reads what Honcho noticed about you that held up: its dream-made conclusions (`inductive`, `deductive`) and any it derived more than once, 30 at most, never one Beluga wrote. It may propose one as a fact to remember, in its own words, when it is lasting and nothing in memory contradicts it. Its card has a third button, **Wrong**: the proposal is discarded and Honcho forgets that conclusion, so a bad guess ("works on Remoter professionally") is gone for good instead of only left out (`memory.rejectProposal`).

Your agents also get one tool, `mcp__beluga_honcho__honcho_ask`: a question about you ("how do they like commit messages?") goes to Honcho's own model (`POST …/peers/user/chat`, reasoning `low` unless the agent asks for more) and its answer comes back, at most 4,000 characters. It can take up to a minute and waits 90 seconds at most; when Honcho's model fails, the agent reads why and goes on without it.

A run never waits on Honcho for the picture: it waits 2 seconds at most, then starts without it, while the read goes on and fills a cache for the next runs. The picture is reused for 5 minutes (a failed read is tried again after a minute). Empty until Honcho has worked through some of your conversations.

Runs for a friend, your agent in a friend's worktree, and external agents never get the picture or the tool. Turning Honcho off, or changing its server, workspace or key, drops the cache.

You can read the picture yourself: Settings › Advanced › Honcho › What Honcho knows about you (with Refresh), and on the phone under Settings › Memory, read-only.

## The key

The server, the key and the counts live in `~/.beluga/honcho.json`, readable only by you (mode 0600).

The saved key only ever goes to the server it was saved for. **Test** with another address uses only a key typed for that test, never the saved one. Saving a new **Server** forgets the saved key, unless you typed the new server's key before saving the address (both are then saved together); Settings says so under Server while you edit it, and under API key once the key was forgotten. Changing only the workspace keeps the key. The key is never shown back in Settings, never sent to the phone, never in a report, a log or the black box, and external agents and friends' runs cannot read or change any of this (`honcho.*` is refused to them). The phone has no Honcho settings at all.

## Turning it off

Turning the switch off stops sending at once and drops what was waiting, on disk too. What Honcho already has stays on that server: delete the workspace there (Honcho's API or its dashboard) to remove it.
