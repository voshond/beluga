import { randomBytes } from 'node:crypto';
import { type MeshKeys, openSealed, sealTo } from '../keys.js';
import { checkMessage, extrasFields, parseExtras } from '../extras.js';
import { type Body, type Entry, type EntryType, MAX_PARENTS, type Profile } from '../schemas.js';
import type { ChatExtras } from '../views.js';
import { type GroupReact, parseGroupReact } from './reactions.js';
import { bodyOf, signEntry } from './entry.js';
import { GroupLog } from './log.js';
import { type GroupModel, MAX_MEMBERS, buildModel, chainKey } from './model.js';
import { Ratchets, decrypt, encrypt, keyAad, messageAad, newChainId, newChainKey } from './sender-keys.js';

/** The longest message text. */
export const MAX_TEXT = 8_000;

/** A group message as you read it: its text (and extras), or undefined while you have no key for it. */
export interface ReadMessage {
  readonly entry: Entry;
  readonly text?: string;
  readonly extras?: ChatExtras;
  /** Not a message: its author's reaction to one (BLG-702; `text` is what older Macs show). */
  readonly react?: GroupReact;
}

interface Plain {
  readonly text: string;
  readonly extras?: ChatExtras;
  readonly react?: GroupReact;
}

/**
 * One group on this Mac: its log, what it adds up to (see model.ts), and writing to it as you.
 * Sending keys and message keys stay in here; nothing outside sees them.
 */
export class GroupEngine {
  private cached: GroupModel | undefined;
  private readonly ratchets = new Ratchets();
  private readonly texts = new Map<string, Plain | null>();
  private readonly chainKeys = new Map<string, Buffer | null>();
  /** Next message number per chain of yours (counts sends not yet folded into the model). */
  private readonly nextN = new Map<string, number>();

  constructor(
    private readonly keys: MeshKeys,
    readonly log: GroupLog,
  ) {
    // Only an admin's add (as the log stands right then) makes someone's entries checkable.
    log.canIntroduce = (e) => buildModel(log.ordered())?.members.get(e.author)?.admin === true;
  }

  get id(): string {
    return this.log.groupId;
  }

  /** Start a new group with you as its admin. */
  static create(keys: MeshKeys, groupName: string, myName: string, logFile?: (groupId: string) => string): GroupEngine {
    const genesis = signEntry(keys.identity, {
      group: '',
      author: keys.identity.peerId,
      lamport: 0,
      parents: [],
      type: 'create',
      ts: Date.now(),
      body: { name: groupName, creator: { card: keys.card, name: myName }, nonce: randomBytes(12).toString('hex') },
    });
    const groupId = genesis.id.slice(0, 32);
    const engine = new GroupEngine(keys, new GroupLog(groupId, logFile?.(groupId)));
    engine.ingest([genesis]);
    return engine;
  }

  get model(): GroupModel | undefined {
    this.cached ??= buildModel(this.log.ordered());
    return this.cached;
  }

  get me(): string {
    return this.keys.identity.peerId;
  }

  isMember = (peerId = this.me): boolean => this.model?.members.has(peerId) === true;
  isAdmin = (peerId = this.me): boolean => this.model?.members.get(peerId)?.admin === true;

  /** Take entries from someone (or from your own writing); returns the ones that are new. */
  ingest(raws: readonly unknown[]): { added: Entry[]; rejected: number } {
    const added: Entry[] = [];
    let rejected = 0;
    for (const raw of raws) {
      const r = this.log.add(raw);
      added.push(...r.added);
      if (r.rejected) rejected += 1;
    }
    if (added.length) this.cached = undefined;
    return { added, rejected };
  }

  /** Write an entry as you, after everything you have. */
  write<T extends EntryType>(type: T, body: Body<T>): Entry {
    const heads = this.log
      .heads()
      .map((id) => this.log.get(id)!)
      .sort((a, b) => b.lamport - a.lamport)
      .slice(0, MAX_PARENTS);
    const entry = signEntry(this.keys.identity, {
      group: this.id,
      author: this.me,
      lamport: Math.max(...heads.map((h) => h.lamport)) + 1,
      parents: heads.map((h) => h.id),
      type,
      ts: Date.now(),
      body,
    });
    if (this.ingest([entry]).rejected) throw new Error('That change is too big for the group log');
    return entry;
  }

  addMember(profile: Profile): Entry {
    this.mustAdmin();
    if (this.isMember(profile.card.peerId)) throw new Error(`${profile.name} is already in the group`);
    if ((this.model?.members.size ?? 0) >= MAX_MEMBERS) throw new Error(`Groups have at most ${MAX_MEMBERS} people`);
    return this.write('member_add', { member: { card: profile.card, name: profile.name } });
  }

  removeMember(peerId: string): Entry {
    if (peerId !== this.me) this.mustAdmin();
    if (!this.isMember(peerId)) throw new Error('They are not in the group');
    return this.write('member_remove', { peerId });
  }

  setAdmin(peerId: string, admin: boolean): Entry {
    this.mustAdmin();
    if (!this.isMember(peerId)) throw new Error('They are not in the group');
    return this.write(admin ? 'admin_add' : 'admin_remove', { peerId });
  }

  rename(name: string): Entry {
    this.mustMember();
    return this.write('rename', { name });
  }

  /** Send a message (and first a new sending key, when the group changed since your last one). */
  send(text: string, extras?: ChatExtras): Entry[] {
    this.mustMember();
    checkMessage(text, extras, MAX_TEXT);
    return this.seal({ text, ...extrasFields(extras) });
  }

  /**
   * Put an emoji on message `react.to` or take it off (BLG-702): an encrypted message like any
   * other, read as a reaction by Macs that know them; `text` is what older ones show instead.
   */
  react(react: GroupReact, text: string): Entry[] {
    this.mustMember();
    return this.seal({ text: text.slice(0, MAX_TEXT), react });
  }

  private seal(payload: { readonly text: string } & Record<string, unknown>): Entry[] {
    const out: Entry[] = [];
    let chain = this.myChain();
    if (!chain) {
      const made = this.newChain();
      out.push(made.entry);
      chain = made.chain;
    }
    const key = this.keyOf(this.me, chain);
    if (!key) throw new Error('Your sending key for this group is unreadable');
    const n = this.nextN.get(chain) ?? 0;
    this.nextN.set(chain, n + 1);
    const box = encrypt(this.ratchets.messageKey(chainKey(this.me, chain), key, n), JSON.stringify(payload), messageAad(this.id, this.me, chain, n));
    out.push(this.write('message', { chain, n, ...box }));
    return out;
  }

  /** The group's messages in order, with their text when you hold the key. */
  messages(): ReadMessage[] {
    return (this.model?.messages ?? []).map((entry) => this.readMessage(entry));
  }

  /** One message as you read it (its text and extras, when you hold the key). */
  readMessage(entry: Entry): ReadMessage {
    const plain = this.open(entry);
    return plain === undefined ? { entry } : { entry, text: plain.text, ...(plain.extras ? { extras: plain.extras } : {}), ...(plain.react ? { react: plain.react } : {}) };
  }

  read(entry: Entry): string | undefined {
    return this.open(entry)?.text;
  }

  private open(entry: Entry): Plain | undefined {
    const known = this.texts.get(entry.id);
    if (known !== undefined) return known ?? undefined;
    const body = bodyOf(entry, 'message');
    const chain = this.model?.chains.get(chainKey(entry.author, body.chain));
    const key = chain ? this.keyOf(entry.author, body.chain) : undefined;
    let out: Plain | undefined;
    if (key) {
      const plain = decrypt(this.ratchets.messageKey(chainKey(entry.author, body.chain), key, body.n), body, messageAad(this.id, entry.author, body.chain, body.n));
      try {
        const parsed = plain === undefined ? undefined : (JSON.parse(plain) as { text?: unknown });
        if (typeof parsed?.text === 'string') {
          const extras = parseExtras(parsed);
          const react = parseGroupReact(parsed);
          out = { text: parsed.text.slice(0, MAX_TEXT), ...(extras ? { extras } : {}), ...(react ? { react } : {}) };
        }
      } catch {
        out = undefined;
      }
    }
    // Remember failures only once the chain is known: its key may simply not have arrived yet.
    if (out !== undefined || chain) this.texts.set(entry.id, out ?? null);
    return out;
  }

  /** Your chain for the group as it is now (made after the last change to who's in it). */
  private myChain(): string | undefined {
    const model = this.model;
    if (!model) return undefined;
    const mine = [...model.chains.values()].filter((c) => c.author === this.me && c.basis === model.basis);
    const chain = mine.at(-1)?.body.chain;
    if (chain && !this.nextN.has(chain)) {
      const used = model.messages.filter((m) => m.author === this.me && bodyOf(m, 'message').chain === chain).map((m) => bodyOf(m, 'message').n);
      this.nextN.set(chain, used.length ? Math.max(...used) + 1 : 0);
    }
    return chain;
  }

  private newChain(): { chain: string; entry: Entry } {
    const model = this.model!;
    const chain = newChainId();
    const key = newChainKey();
    // Sealed for each member; someone whose box key is unusable just can't read (and doesn't stop the rest).
    const keys = Object.fromEntries(
      [...model.members.values()].flatMap((m) => {
        try {
          return [[m.card.peerId, sealTo(m.card.box, key, keyAad(this.id, this.me, chain, m.card.peerId))]];
        } catch {
          return [];
        }
      }),
    );
    const entry = this.write('sender_key', { chain, basis: model.basis, keys });
    this.chainKeys.set(chainKey(this.me, chain), key);
    this.nextN.set(chain, 0);
    return { chain, entry };
  }

  private keyOf(author: string, chain: string): Buffer | undefined {
    const id = chainKey(author, chain);
    const known = this.chainKeys.get(id);
    if (known !== undefined) return known ?? undefined;
    const c = this.model?.chains.get(id);
    if (!c) return undefined;
    const sealed = c.body.keys[this.me];
    const key = sealed ? openSealed(this.keys, sealed, keyAad(this.id, author, chain, this.me)) : undefined;
    this.chainKeys.set(id, key ?? null);
    return key;
  }

  private mustMember(): void {
    if (!this.isMember()) throw new Error("You're not in this group");
  }

  private mustAdmin(): void {
    if (!this.isAdmin()) throw new Error('Only admins can do that');
  }
}
