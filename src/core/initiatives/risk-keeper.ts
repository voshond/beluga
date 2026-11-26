import { readFileSync } from 'node:fs';
import path from 'node:path';
import { addTimeline, readFolder, writeRisks, writeText } from './files.js';
import { type Risk, type RiskDraft, RiskDraftSchema, RisksSchema, blockerRisks, ownerRisk, ownerRiskLine, riskOf, withOwnerEdits } from './risks.js';

/**
 * The owner's edits to an initiative's risks, mirrored outside its folder (`<dir>/<slug>/risks-owned.json`),
 * where its chats never write: a turn that drops or rewrites them gets them back.
 */
export class RiskKeeper {
  constructor(
    private readonly root: string,
    private readonly dir: string | null,
  ) {}

  private file(slug: string): string | undefined {
    return this.dir ? path.join(this.dir, slug, 'risks-owned.json') : undefined;
  }

  private kept(slug: string): Risk[] {
    const file = this.file(slug);
    if (!file) return [];
    try {
      const parsed = RisksSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
      return parsed.success ? parsed.data : [];
    } catch {
      return [];
    }
  }

  private keep(slug: string, risk: Risk): void {
    const file = this.file(slug);
    if (file) writeText(file, `${JSON.stringify([...this.kept(slug).filter((r) => r.id !== risk.id), risk], null, 2)}\n`);
  }

  /** The owner adds, changes or closes a risk: kept as theirs, with a line in the timeline. */
  save(slug: string, draft: RiskDraft, at: string, day: string): Risk {
    const parsed = RiskDraftSchema.parse(draft);
    const folder = readFolder(this.root, slug);
    if (folder.trouble?.includes('risks.json')) throw new Error(`Fix ${slug}/risks.json first`);
    const was = parsed.id === undefined ? undefined : folder.risks.find((r) => r.id === parsed.id);
    const risk = ownerRisk(folder.risks, parsed, at);
    const risks = was ? folder.risks.map((r) => (r.id === risk.id ? risk : r)) : [...folder.risks, risk];
    writeRisks(this.root, slug, risks);
    this.keep(slug, risk);
    addTimeline(this.root, slug, `${day} [risk]: ${ownerRiskLine(was, risk)}`);
    return risk;
  }

  /** After a turn: the owner's edits back where it changed them, and a risk for each outside blocker none names. */
  settle(slug: string, at: string, day: string): boolean {
    try {
      const folder = readFolder(this.root, slug);
      if (folder.trouble?.includes('risks.json')) return false;
      const restored = withOwnerEdits(folder.risks, this.kept(slug));
      const raised = blockerRisks(folder.tickets?.tickets ?? [], restored.risks, at);
      if (!restored.changed && !raised.length) return false;
      writeRisks(this.root, slug, [...restored.risks, ...raised]);
      for (const risk of raised) addTimeline(this.root, slug, `${day} [risk]: raised risk ${risk.id} “${riskOf(risk).title}”: ${risk.why ?? ''}`.trim());
      return true;
    } catch {
      return false;
    }
  }
}
