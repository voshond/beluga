import { useState } from 'react';
import { Attention } from '../chat/Attention.js';
import { Markdown } from '../chat/Markdown.js';
import { Button } from '../components/ui.js';
import { BelugaProvider, useApp } from '../lib/beluga.js';
import { PlanAsk } from '../plans/PlanAsk.js';
import { CHAT_CHANNEL, type DemoAnswer, PLAN_CHANNEL, makeDemoClient } from './run-ask-demo-client.js';
import s from './run-ask-demo.module.css';

type PaneProps = {
  readonly title: string;
  readonly sub: string;
  readonly answer?: DemoAnswer;
  readonly children: React.ReactNode;
};

const Pane = ({ title, sub, answer, children }: PaneProps) => (
  <section className={s.pane} aria-label={title}>
    <header className={s.paneHead}>
      <span className={s.paneTitle}>{title}</span>
      <span className={s.paneSub}>{sub}</span>
    </header>
    <div className={s.paneBody}>
      {children}
      {answer ? (
        <div className={s.got} data-testid="agent-got">
          <div className={s.gotHead}>Your agent got back</div>
          <Markdown text={answer.text} />
        </div>
      ) : null}
    </div>
  </section>
);

const PlanCard = () => {
  const q = useApp((st) => st.questions.find((x) => x.channel === PLAN_CHANNEL));
  return q ? <PlanAsk key={q.qid} q={q} /> : null;
};

export function RunAskDemo() {
  const [answers, setAnswers] = useState<Record<string, DemoAnswer>>({});
  const [client] = useState(() => makeDemoClient((a) => setAnswers((prev) => ({ ...prev, [a.channel]: a }))));

  const handleReset = (): void => {
    setAnswers({});
    (client as unknown as { reset: () => void }).reset();
  };

  return (
    <BelugaProvider client={client}>
      <div className={s.stage}>
        <div className={s.top}>
          <div>
            <div className={s.title}>Run it for me</div>
            <div className={s.sub}>Your agent prepares the commands. You click once and type the password. The agent gets the output.</div>
          </div>
          <Button variant="quiet" icon="refresh" onClick={handleReset}>
            Reset demo
          </Button>
        </div>
        <div className={s.panes}>
          <Pane title="Worktree chat" sub="AskUserQuestion · ssh nas" {...(answers[CHAT_CHANNEL] ? { answer: answers[CHAT_CHANNEL] } : {})}>
            <Attention channel={CHAT_CHANNEL} />
          </Pane>
          <Pane title="Plan mode" sub="plan_ask with run · this machine" {...(answers[PLAN_CHANNEL] ? { answer: answers[PLAN_CHANNEL] } : {})}>
            <PlanCard />
          </Pane>
        </div>
      </div>
    </BelugaProvider>
  );
}
