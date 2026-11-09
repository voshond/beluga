import { z } from 'zod';
import { MACHINE_ICONS } from '../shared/settings-schema.js';
import { MAX_ENV_SEND_BYTES, MAX_ENV_SEND_FILES } from '../shared/env-send.js';
import { MAX_UPLOAD_BYTES, UPLOAD_PIECE } from '../shared/uploads.js';

/**
 * Your devices and computers in the API (BLG-774, src/machines): a computer opening a pairing for
 * your app (`beluga pair --computer`), the app joining one with its link or code after both show
 * the same four pictures, the computers it drives, your device set, and forgetting a device of
 * yours everywhere. Which a phone may call is in src/companion/coverage.ts. Browser-safe: zod only.
 */

const deviceId = z.string().regex(/^[0-9a-f]{16}$/);

export const MACHINE_API = {
  // On a computer: open a one-time pairing for your app (10 minutes, one app) → { link, code, expiresAt }.
  'machines.pair.start': { args: z.tuple([]) },
  // The pairing now: open (with the app waiting and its four pictures), how the last one ended, and whose this computer is.
  'machines.pair.status': { args: z.tuple([]) },
  // Close the pairing (a waiting app hears no).
  'machines.pair.cancel': { args: z.tuple([]) },
  // In the app: dial a computer's pairing link or code → { name, platform, version, fingerprint } once it answers.
  'machines.join.start': { args: z.tuple([z.string().trim().min(12).max(400)]) },
  // The pictures match: sign the computer in with your identity → the computer.
  'machines.join.approve': { args: z.tuple([]) },
  // Don't add it (the computer hears no).
  'machines.join.cancel': { args: z.tuple([]) },
  // Add Over SSH (BLG-781): the hosts your ssh config names, to pick from.
  'machines.ssh.hosts': { args: z.tuple([]) },
  // Add Over SSH: install and start Beluga on user@host (or a Host) when needed, open a pairing there and dial it → the offer, as machines.join.start.
  'machines.ssh.pair': { args: z.tuple([z.string().trim().min(1).max(255).regex(/^[^\s-]\S*$/)]) },
  // Update It on a computer (BLG-777): ask (says what runs there, updates only if nothing does), when-idle, or now → what it does.
  'machines.update': { args: z.tuple([deviceId, z.enum(['ask', 'when-idle', 'now'])]) },
  // Before the app updates to app protocol `ipc`: the computers that update would leave unable to connect.
  'machines.leftBehind': { args: z.tuple([z.number().int().min(0).max(1000)]) },
  // Rename a computer or pick its icon: kept on the computer, so every device shows the same → the computer.
  'machines.look': { args: z.tuple([deviceId, z.object({ name: z.string().trim().min(1).max(64).optional(), icon: z.enum(MACHINE_ICONS).optional() }).strict()]) },
  // Where new work goes now, as Run New Work On says (here, a computer, or the least busy one) and why.
  'machines.placement': { args: z.tuple([]) },
  // The computers this app drives.
  'machines.list': { args: z.tuple([]) },
  // Every device of your set this install knows: phones, apps and computers, with their roles.
  'machines.devices': { args: z.tuple([]) },
  // Forget a device of yours (by id): cut off here at once, and on every other device of yours as they hear.
  'machines.forget': { args: z.tuple([deviceId]) },
  // On a computer (BLG-787): get the project at this git origin ready here (folder, clone, the tools it needs, its setup) → the run to follow.
  'machines.ready.start': { args: z.tuple([z.string().trim().min(4).max(500).regex(/^[^\s-]\S*$/), z.string().trim().min(1).max(100).optional()]) },
  // How a run is going: each step, and what's missing when it waits on you.
  'machines.ready.status': { args: z.tuple([z.string().uuid()]) },
  // You said yes: install what's missing there (a user-level way first), then go on.
  'machines.ready.install': { args: z.tuple([z.string().uuid()]) },
  // .env files for a worktree on a computer (BLG-800). On the computer, asked by your app over its link:
  // the worktree's project and the env files its folder has → { project: { name, remote? }, files } (names only).
  'machines.env.here': { args: z.tuple([z.string().min(1).max(200)]) },
  // On the computer: env files your app sent (base64), written 0600 into those worktrees' project folders and the worktrees, never over one there → { written }.
  'machines.env.receive': {
    args: z.tuple([
      z.array(z.string().min(1).max(200)).min(1).max(16),
      z.array(z.object({ path: z.string().min(1).max(400), data: z.string().max(Math.ceil((MAX_ENV_SEND_BYTES * 4) / 3) + 4) }).strict()).max(MAX_ENV_SEND_FILES),
    ]),
  },
  // Files you add to a chat on a computer (BLG-793). On the computer: one piece of a file your app sends → { received }, or for the last { path, name, size, image } (in ~/.beluga/uploads there).
  'machines.upload.put': {
    args: z.tuple([
      z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      z.object({ name: z.string().min(1).max(200), mime: z.string().max(100), size: z.number().int().min(0).max(MAX_UPLOAD_BYTES), off: z.number().int().min(0), b64: z.string().max(Math.ceil(UPLOAD_PIECE / 3) * 4 + 4), eof: z.boolean() }).strict(),
    ]),
  },
  // In the app: send the piece of a file on this Mac at `off` to computer `id`, upload `n` → { sent, total, name, path?, image? } (path: where it is there, once all of it is).
  // `env`: you said Send Once for this env file (BLG-854); a refused file never goes.
  'machines.upload.send': { args: z.tuple([deviceId, z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), z.string().min(1).max(4096), z.number().int().min(0), z.object({ env: z.boolean().optional() }).strict().optional()]) },
  // In the app: what becomes of files dropped on a chat on a computer → [{ path, name, verdict: send | ask | refuse, reason? }] (an env file asks first; keys and credential folders are refused).
  'machines.upload.check': { args: z.tuple([z.array(z.string().min(1).max(4096)).min(1).max(64)]) },
  // Open in Finder and editors, for a computer (BLG-794). On the computer: the piece of a file (its whole path) at `off`, for your app to download → { b64, total, eof }; never a secret.
  'machines.download.piece': { args: z.tuple([z.string().min(1).max(4096), z.number().int().min(0)]) },
  // In the app: download a file of computer `id` (its whole path there) into ~/Downloads/Beluga → where it's saved.
  'machines.download.fetch': { args: z.tuple([deviceId, z.string().min(1).max(4096)]) },
  // In the app: the editor that opens a computer's folders over Remote-SSH → 'vscode' or 'cursor'.
  'machines.editor': { args: z.tuple([]) },
  // On a computer: every worktree's listening ports (BLG-802), for your app to forward → [{ workspaceId, port, name }].
  'machines.ports': { args: z.tuple([]) },
  // In the app: what's forwarded from your computers now → [{ machineId, workspaceId, port, local, name }].
  'machines.forwards': { args: z.tuple([]) },
  // In the app: share this Mac's localhost:<port> with a worktree on one of your computers (BLG-804), reachable there at localhost:<port> → the shares.
  'machines.share': { args: z.tuple([z.string().min(1).max(200), z.number().int().min(1).max(65535)]) },
  // Stop sharing it with that worktree: closed there at once → the shares.
  'machines.unshare': { args: z.tuple([z.string().min(1).max(200), z.number().int().min(1).max(65535)]) },
  // In the app: answer an ask (Send Once, Always for This Project, Don't Send) → { sent } (file names).
  'machines.env.decide': { args: z.tuple([z.string().uuid(), z.enum(['once', 'always', 'never'])]) },
  // The projects whose env files go to your computers without asking (Settings › Your Computers).
  'machines.env.always': { args: z.tuple([]) },
  // Take Always back for a project (by its folder): asked again next time → the list now.
  'machines.env.forget': { args: z.tuple([z.string().min(1).max(4096)]) },
  // Keep My Secrets in Sync With a computer (BLG-805: your own variables follow, after this one ask per computer), or stop → the computer.
  'machines.secrets': { args: z.tuple([deviceId, z.boolean()]) },
  // How your settings sync across your devices: how many, and conflicts to say (the same setting changed on two while apart).
  'machines.settingsSync': { args: z.tuple([]) },
  // Clear the conflicts Settings says (Got It).
  'machines.settingsSync.clear': { args: z.tuple([]) },
  // Make Always On (BLG-796): your identity and friends network move to that computer ('here': back to this one), after the one confirmation Settings asks → where you are now.
  'machines.alwaysOn': { args: z.tuple([z.union([deviceId, z.literal('here')])]) },
  // Where you are on the network: this install, or your Always On (its id and name), and a handover under way.
  'machines.alwaysOn.status': { args: z.tuple([]) },
} as const;
