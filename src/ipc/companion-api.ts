import { z } from 'zod';
import { MAX_UPLOADS, PHONE_BRANCH_STEPS, PHONE_USE, PhoneOp, UploadRef, VoiceModelId } from '../companion/protocol.js';
import { NEEDS } from '../core/gateway/protocol.js';
import { AgentRef } from '../protocol.js';
import { KEEP_AWAKE } from '../shared/settings-schema.js';
import { SourceSchema, ViewQuerySchema } from '../shared/view-spec.js';

/**
 * Your phone (the companion, docs/companion.md) in the API (see api.ts): pairing one from the Mac,
 * removing one, and what the phone itself asks for beyond the shared methods (older turns of a
 * conversation). Which of these a phone may call is in src/companion/coverage.ts. Browser-safe: zod only.
 */

const topic = z.string().regex(/^(conv|chat):[\w:.-]{1,200}$/);
const files = z.array(UploadRef).max(MAX_UPLOADS);
/** A worktree's conversation. */
const wsTopic = z.string().regex(/^conv:ws:[\w.-]{1,200}$/);
/** A path inside a worktree ('' is its top); the Mac's file gate checks it (companion/worktree-files.ts). */
const rel = z.string().max(4096);
const termKey = z.string().min(1).max(200);
const conversation = z.string().regex(/^(dm:[\w-]{32}|group:[0-9a-f]{32})$/);

/** A task's draft as the phone sends it back (maybe changed): `for` is the teammate it names (1.24). */
const phoneDraft = z
  .object({
    title: z.string().trim().min(1).max(200),
    goal: z.string().max(20_000),
    acceptance: z.array(z.string().trim().min(1).max(300)).max(12),
    labels: z.array(z.string().min(1).max(32)).max(12),
    priority: z.enum(['urgent', 'high', 'medium', 'low']).optional(),
    for: z.string().min(1).max(80).optional(),
  })
  .strict();

export const COMPANION_API = {
  // Open a one-time pairing (10 minutes, one phone): → { link, code, expiresAt }. Starting another replaces it.
  'companion.pair.start': { args: z.tuple([]) },
  // Pair the phone that's waiting (its name and fingerprint are in companion.pairing.waiting).
  'companion.pair.approve': { args: z.tuple([]) },
  // Close the pairing (a waiting phone is told no).
  'companion.pair.cancel': { args: z.tuple([]) },
  // Remove a phone: its certificate goes, its link drops at once and its key is refused from then on.
  'companion.devices.remove': { args: z.tuple([z.string().regex(/^[0-9a-f]{16}$/)]) },
  // How freely your Claude may use a phone (BLG-150, Settings › Phone): off · ask · use · full.
  'companion.phone.use': { args: z.tuple([z.string().regex(/^[0-9a-f]{16}$/), z.enum(PHONE_USE)]) },
  // Pair this Mac's adb with the phone, using the code it sent (Wireless debugging › Pair with code).
  'companion.phone.pairAdb': { args: z.tuple([z.string().regex(/^[0-9a-f]{16}$/)]) },
  // The phone's Wireless debugging on (over its cable, reached through the link so it carries on unplugged) or off (BLG-187).
  'companion.phone.wifi': { args: z.tuple([z.string().regex(/^[0-9a-f]{16}$/), z.boolean()]) },
  // The phone on the USB cable (BLG-190): pair it over the cable, or show a linked phone its Developer options / About phone.
  'companion.phone.pairCable': { args: z.tuple([]) },
  // Beluga Link on the phone over adb, its Accessibility turned on (BLG-391, Settings › Phone › Beluga Link).
  'companion.phone.setUpLink': { args: z.tuple([z.string().regex(/^[0-9a-f]{16}$/)]) },
  'companion.phone.settings': { args: z.tuple([z.string().regex(/^[0-9a-f]{16}$/), z.enum(['developer', 'about'])]) },
  // One action on the phone from the Mac UI (the live mirror's tap/type, a button): op + its args.
  'companion.phone.act': { args: z.tuple([z.string().regex(/^[0-9a-f]{16}$/), PhoneOp, z.record(z.string(), z.unknown())]) },
  // Saved phone flows (BLG-175): the list, run one by name, delete one.
  'companion.phone.macros': { args: z.tuple([]) },
  'companion.phone.macroRun': { args: z.tuple([z.string().min(1).max(60)]) },
  'companion.phone.macroDelete': { args: z.tuple([z.string().min(1).max(60)]) },
  // A conversation's (or chat's) turns before one the phone has: → { turns | messages, more }.
  'companion.older': { args: z.tuple([topic, z.object({ before: z.string().min(1).max(200), limit: z.number().int().min(1).max(100).optional() }).strict()]) },
  // Ask your Mac from the phone: a new chat in a project (or, 1.12, a new worktree there: `worktree`,
  // with `plan` mode), or a message in a conversation; files the phone `put` go along → { topic }.
  'companion.ask': {
    args: z.tuple([
      z
        .object({
          target: z.union([
            // `agent` (1.35, BLG-506): who works a new worktree; none: your default.
            z.object({ project: z.string().min(1).max(200), worktree: z.literal(true).optional(), plan: z.boolean().optional(), agent: AgentRef.optional() }).strict(),
            z.object({ topic: z.string().regex(/^conv:[\w:.-]{1,200}$/) }).strict(),
          ]),
          text: z.string().max(64_000),
          files: files.optional(),
        })
        .strict()
        .refine((a) => a.text.trim() || a.files?.length, 'Say something, or attach a file'),
    ]),
  },
  // Write in a friends' chat from the phone, with files it `put` → the message.
  'companion.post': {
    args: z.tuple([
      z
        .object({ conversation, text: z.string().max(8_000), files: files.optional(), ask: z.union([z.literal('all'), z.array(z.string().regex(/^[\w-]{32}$/)).min(1).max(100)]).optional() })
        .strict()
        .refine((a) => a.text.trim() || a.files?.length, 'Say something, or attach a file'),
    ]),
  },
  // Ask a friend's Claude yourself (as ask_person does, with their approval and trust rules) → { topic, task }.
  'companion.askPerson': { args: z.tuple([z.object({ peerId: z.string().regex(/^[\w-]{8,64}$/), text: z.string().min(1).max(16_000), needs: z.array(z.enum(NEEDS)).max(5).optional(), project: z.string().min(1).max(80).optional() }).strict()]) },
  // The phone signs out: its own certificate goes (only the calling phone's), and the link closes.
  'companion.signOut': { args: z.tuple([]) },
  // Keep the Mac awake for the phone (Settings › Phone's own switch, from the phone): off, on power, always (BLG-127).
  'companion.keepAwake': { args: z.tuple([z.enum(KEEP_AWAKE)]) },
  // Make one of your providers the default agent, from the phone's usage cards, by its runtime (BLG-459).
  'companion.defaultAgent': { args: z.tuple([z.string().regex(/^[a-z][\w-]{0,31}$/)]) },
  // Open on your Mac: the Mac app's window comes to the front showing what the phone has open (a
  // topic, or a needs-you item without one) → { opened, why? } (why not: the Mac app isn't open).
  'companion.openOnMac': {
    args: z.tuple([
      z
        .object({ topic: z.string().regex(/^(home|work|plans|tasks|chats|people|(conv|plan|chat|task):[\w:.-]{1,200})$/).optional(), need: z.string().min(1).max(300).optional() })
        .strict()
        .refine((a) => a.topic || a.need, 'Say what to open'),
    ]),
  },
  // A project's small icon by the checksum a view handed out → { sum, mime, b64 } (PNG, at most 128 px; or a small SVG).
  'companion.icon': { args: z.tuple([z.string().regex(/^[0-9a-f]{16,64}$/)]) },
  // Merging a worktree of yours (its conversation's topic), the Mac's own way: look first (the
  // Merge sheet's checks) → MergeCheckView; merge → where it stands (merged, conflicts by file name,
  // blocked and why); Claude resolves the conflicts in that worktree → resolving.
  'companion.mergeCheck': { args: z.tuple([wsTopic]) },
  'companion.merge': { args: z.tuple([wsTopic]) },
  'companion.resolve': { args: z.tuple([wsTopic]) },
  // 1.8: one of a worktree's branch steps (BranchView.steps), the Mac's own way → { ok, message }.
  'companion.branchStep': { args: z.tuple([wsTopic, z.enum(PHONE_BRANCH_STEPS), z.enum(['with', 'keep']).optional()]) },
  // A live view's rows (BLG-68): the view is named by its conversation, turn and block (one in your
  // own Claude's answer); `source` is one that view names (an action's, a control's). The Mac runs
  // it as view.fetch does → ViewPage, or { needsApproval, what } for a command that hasn't run before.
  'companion.viewFetch': {
    args: z.tuple([
      z
        .object({
          topic: z.string().regex(/^conv:[\w:.-]{1,200}$/),
          turn: z.string().min(1).max(200),
          block: z.number().int().min(0).max(199),
          source: SourceSchema.optional(),
          query: ViewQuerySchema,
          confirm: z.boolean().optional(),
          fresh: z.boolean().optional(),
          text: z.boolean().optional(),
        })
        .strict(),
    ]),
  },
  // A task described in words: your Claude's draft of it (title, goal, criteria, labels), not added yet → the draft.
  // 1.24 (BLG-322) `several`: the words may ask for several tasks (the draft's `more`), an epic, and who each is for.
  'companion.draftTask': { args: z.tuple([z.object({ projectId: z.string().min(1).max(200), text: z.string().min(1).max(8000), several: z.boolean().optional() }).strict()]) },
  // Add a draft (maybe changed on the phone) as a task in a project → the task ({ id, key }); 1.24: with
  // `more` (under it when `epic`; at most MAX_TASKS in all, agent/task-drafter.ts), those too (`more` in
  // the answer), each for the teammate `for` names. 1.35 (BLG-498) `agent`: who works them when they start (none: your default).
  'companion.addTask': { args: z.tuple([phoneDraft.extend({ projectId: z.string().min(1).max(200), epic: z.boolean().optional(), more: z.array(phoneDraft).max(11).optional(), agent: AgentRef.optional() }).strict()]) },
  // A worktree's files, read-only (BLG-42), through the file gate: never outside the worktree (links
  // followed and checked again), never a secret. A folder → FolderView; names that match → FoundView;
  // a page of a file (512 KB, from `off`) → FilePageView. Nothing on the phone can change a file.
  'companion.files.list': { args: z.tuple([wsTopic, rel]) },
  'companion.files.find': { args: z.tuple([wsTopic, z.string().min(1).max(200)]) },
  'companion.files.read': { args: z.tuple([wsTopic, rel.min(1), z.object({ off: z.number().int().min(0).optional() }).strict().optional()]) },
  // A worktree's terminals (BLG-42), the very sessions the Mac shows → TerminalsView. Open one of
  // them (`key`), its shell, or a new shell in its folder (`fresh`) → TerminalView; the phone then
  // streams it with `term_attach` and types with `term_input`. Close ends the session for every screen.
  'companion.terminals': { args: z.tuple([wsTopic]) },
  'companion.termOpen': { args: z.tuple([wsTopic, z.object({ key: termKey.optional(), fresh: z.boolean().optional() }).strict().optional()]) },
  'companion.termClose': { args: z.tuple([termKey]) },
  // 1.10 (BLG-110): one sub-agent of a conversation's turn (its id as the turn's view names it):
  // its activity in words and, once it ended, the report it gave back with code stripped →
  // SubAgentDetailView. Reads only; never its prompt, its tools' input or output, or a file.
  'companion.subAgent': { args: z.tuple([z.string().regex(/^conv:[\w:.-]{1,200}$/), z.string().min(1).max(200), z.string().min(1).max(200)]) },
  // 1.11 (BLG-124): which of these conversations (ones the phone saved files from) are no longer on
  // the Mac: archived or deleted worktrees and chat folders, deleted chats of Your Mac → { gone }.
  'companion.gone': { args: z.tuple([z.array(z.string().regex(/^conv:[\w:.-]{1,200}$/)).max(500)]) },
  // 1.16 (BLG-140): the Mac writes down what you said on the phone. Its models, here or coming →
  // VoiceMacView; get one now (it comes in the background) → VoiceMacView; the words in a WAV the
  // phone `put` (16 kHz mono; deleted once written down; `prompt`: the words before it, BLG-160) → TranscriptView. A model that isn't here
  // yet starts coming, and the call says how far it is.
  'companion.voice': { args: z.tuple([]) },
  'companion.voicePrepare': { args: z.tuple([VoiceModelId]) },
  'companion.transcribe': { args: z.tuple([z.object({ audio: UploadRef, model: VoiceModelId, language: z.string().regex(/^(auto|[a-z]{2,3})$/), prompt: z.string().max(400).optional() }).strict()]) },
} as const;
