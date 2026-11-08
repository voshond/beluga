import { type Plan, activeDecisions, decisionText, shownBody, taskById } from '@beluga/core/plans/model.js';
import { staleTasks } from '@beluga/core/plans/coherence.js';
import { Icon } from '../components/Icon.js';
import { cx } from '../components/ui.js';
import p from './plans.module.css';

/** The details pane shows what was settled while planning (BLG-8) when this is picked. */
export const DECISIONS = 'decisions';

/** What was settled while planning (the ones in force), what a later decision replaced, and what's still open: from the draft while there is one. */
export const planNotes = (plan: Plan) => {
  const body = shownBody(plan);
  return { decisions: activeDecisions(body), replaced: (body?.decisions ?? []).filter((d) => d.supersededBy), open: body?.openQuestions ?? [] };
};

export function DecisionsHead({ plan }: { plan: Plan }) {
  const { decisions, open } = planNotes(plan);
  const defaults = decisions.filter((d) => d.by === 'default').length;
  return (
    <>
      <div className={p.detailsKind}>
        <Icon name="check" size={12} />
        Plan
      </div>
      <h3 className={p.detailsTitle}>Decided while planning</h3>
      <p className={p.muted}>
        {open.length ? `${open.length} still open. ` : ''}
        {defaults ? `${defaults} ${defaults === 1 ? 'is a default' : 'are defaults'} your agent chose without asking: say in the conversation if one should go another way.` : 'Every agent on the plan reads these.'}
      </p>
    </>
  );
}

/** The open questions first (approving waits on them), then each decision with who settled it and why, then the replaced ones (BLG-772). */
export function DecisionsList({ plan, onPick }: { plan: Plan; onPick: (id: string) => void }) {
  const body = shownBody(plan);
  const { decisions, replaced, open } = planNotes(plan);
  if (!decisions.length && !open.length) return <p className={p.muted}>Nothing was decided yet: your agent asks what it can’t find out in the code, and writes down what it chose.</p>;
  return (
    <div className={p.decisions}>
      {open.length ? (
        <section aria-label="Still open">
          <h4 className={p.decisionsGroup}>Still open</h4>
          <ul className={p.decisionList}>
            {open.map((q) => (
              <li key={q} className={p.decision} data-open="true">
                <Icon name="alert" size={12} className={p.decisionMark} />
                <span className={p.decisionQuestion}>{q}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {decisions.length ? (
        <section aria-label="Decided">
          <h4 className={p.decisionsGroup}>Decided</h4>
          <ul className={p.decisionList}>
            {decisions.map((d) => (
              <li key={d.id} className={p.decision}>
                <Icon name="check" size={12} className={p.decisionMark} />
                <span className={p.decisionText}>
                  <span className={p.decisionQuestion}>{d.question}</span>
                  <span className={p.decisionAnswer}>
                    {d.answer}
                    <span className={p.decisionBy} data-by={d.by}>
                      {d.by === 'user' ? 'You' : 'Default'}
                    </span>
                  </span>
                  {d.why ? <span className={p.decisionWhy}>{d.why}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {replaced.length ? (
        <section aria-label="Replaced">
          <h4 className={p.decisionsGroup}>Replaced</h4>
          <ul className={p.decisionList}>
            {[...replaced].reverse().map((d) => {
              const stale = body ? staleTasks(body, d) : [];
              const by = body?.decisions?.find((x) => x.id === d.supersededBy);
              return (
                <li key={d.id} className={cx(p.decision, p.decisionOld)}>
                  <Icon name="x" size={12} className={p.decisionMark} />
                  <span className={p.decisionText}>
                    <span className={p.decisionQuestion}>{d.question}</span>
                    <span className={p.decisionAnswer}>{d.answer}</span>
                    <span className={p.decisionWhy}>Replaced by “{by ? decisionText(by) : d.supersededBy}”</span>
                    {stale.length ? (
                      <span className={p.decisionStale}>
                        Still written the old way:{' '}
                        {stale.map((id, i) => (
                          <button key={id} type="button" className={p.linkButton} onClick={() => onPick(id)}>
                            {i ? ', ' : ''}
                            {taskById(body, id)?.title ?? id}
                          </button>
                        ))}
                      </span>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
