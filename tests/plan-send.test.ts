import { describe, expect, it } from 'vitest';
import { attachment, expandChips, registerAttachment } from '../src/core/attachments.js';
import { type PlanSendApi, planMessage, sendPlanMessage } from '../packages/mac/src/plans/plan-send.js';

/** A fake API: `expand` fails the first `failExpand` times, `submit` answers with `went`. */
function fakeApi({ failExpand = 0, went = true as boolean | void } = {}): PlanSendApi & { sent: string[]; ids: string[]; expands: number; answers: Array<[string, string]> } {
  const sent: string[] = [];
  const ids: string[] = [];
  const answers: Array<[string, string]> = [];
  let fails = failExpand;
  const api = {
    sent,
    ids,
    answers,
    expands: 0,
    questions: {
      answer: async (qid: string, answer: { feedback: string }) => void answers.push([qid, answer.feedback]),
    },
    attachments: {
      expand: async (text: string) => {
        api.expands++;
        if (fails-- > 0) throw new Error('the image is busy');
        return text.replace(/\[image (\d+)\]/g, '![image $1](/tmp/$1.png)');
      },
    },
    session: {
      submit: async (text: string, opts: { channel: string; id: string }) => {
        sent.push(text);
        ids.push(opts.id);
        return went;
      },
    },
  };
  return api;
}

describe('plan chat send (KLD-66)', () => {
  it('Retry after a failed image expand sends the expanded message exactly once', async () => {
    const api = fakeApi({ failExpand: 1 });
    const message = planMessage('look at [image 3]');
    await expect(sendPlanMessage(api, message, 'ws:plan')).rejects.toThrow("Couldn't send the images: the image is busy");
    expect(api.sent).toEqual([]);
    // Retry sends the same message again; its images are expanded this time.
    await sendPlanMessage(api, message, 'ws:plan');
    expect(api.sent).toEqual(['look at ![image 3](/tmp/3.png)']);
  });

  it('passes the numbers the box showed along with the images', async () => {
    const api = fakeApi();
    const seen: unknown[][] = [];
    const expand = api.attachments.expand;
    api.attachments.expand = async (text, channel, only, shown) => (seen.push([only, shown]), expand(text, channel));
    await sendPlanMessage(api, planMessage('look at [image 1]', [7], [1]), 'ws:plan');
    expect(seen).toEqual([[[7], [1]]]);
  });

  it('a send that resolves but did not go is an error', async () => {
    await expect(sendPlanMessage(fakeApi({ went: false }), planMessage('hi'), 'ws:plan')).rejects.toThrow("The agent can't be asked here");
    // Older daemons answer nothing: that's a send.
    await expect(sendPlanMessage(fakeApi({ went: undefined }), planMessage('hi'), 'ws:plan')).resolves.toBeUndefined();
  });

  it('a rejected send keeps its reason, and commands go as typed', async () => {
    const api = fakeApi();
    api.session.submit = async () => {
      throw new Error('not connected');
    };
    await expect(sendPlanMessage(api, planMessage('hi'), 'ws:plan')).rejects.toThrow('not connected');
    const plain = fakeApi();
    await sendPlanMessage(plain, planMessage('/compact [image 1]'), 'ws:plan');
    expect(plain.sent).toEqual(['/compact [image 1]']);
  });
});

describe('plan chat while the plan waits for approval', () => {
  it('what you type is what to change in the plan, not a message to the held run', async () => {
    const api = fakeApi();
    await sendPlanMessage(api, planMessage('split milestone 2 and see [image 3]'), 'ws:plan', true, 'q1');
    expect(api.answers).toEqual([['q1', 'split milestone 2 and see ![image 3](/tmp/3.png)']]);
    expect(api.sent).toEqual([]);
  });

  it('a command still goes to the conversation', async () => {
    const api = fakeApi();
    await sendPlanMessage(api, planMessage('/compact'), 'ws:plan', false, 'q1');
    expect(api.answers).toEqual([]);
    expect(api.sent).toEqual(['/compact']);
  });

  it('an answer that fails keeps its reason for Retry', async () => {
    const api = fakeApi();
    api.questions.answer = async () => {
      throw new Error('not connected');
    };
    await expect(sendPlanMessage(api, planMessage('hi'), 'ws:plan', false, 'q1')).rejects.toThrow('not connected');
  });
});

describe('plan chat Retry (KLD-69)', () => {
  it('every Retry of a message carries its one id (klaud says and asks it once), and a new message gets a new one', async () => {
    const api = fakeApi();
    let failing = true;
    const submit = api.session.submit;
    // The send reached klaud (it may have been said in the chat), but its answer was lost.
    api.session.submit = async (text, opts) => {
      await submit(text, opts);
      if (failing) throw new Error('timed out');
      return true;
    };
    const message = planMessage('tighten the plan');
    await expect(sendPlanMessage(api, message, 'ws:plan')).rejects.toThrow('timed out');
    failing = false;
    await sendPlanMessage(api, message, 'ws:plan');
    expect(api.ids).toEqual([message.id, message.id]);
    await sendPlanMessage(api, planMessage('tighten the plan'), 'ws:plan');
    expect(new Set(api.ids).size).toBe(2);
  });

  it('Retry with images reuses the links made the first time (the box already gave its images up)', async () => {
    const api = fakeApi({ went: false });
    const message = planMessage('look at [image 3]');
    await expect(sendPlanMessage(api, message, 'ws:plan')).rejects.toThrow("The agent can't be asked here");
    // Anything expand would say now (the images left the box with the first try) doesn't matter.
    api.attachments.expand = async () => {
      throw new Error('no such image');
    };
    api.session.submit = async (text, opts) => (api.sent.push(text), api.ids.push(opts.id), true);
    await sendPlanMessage(api, message, 'ws:plan');
    expect(api.sent).toEqual(['look at ![image 3](/tmp/3.png)', 'look at ![image 3](/tmp/3.png)']);
    expect(api.expands).toBe(1);
  });

  it('klaud keeps an image after its message took it, so a later expand still links it', () => {
    const a = registerAttachment('/tmp/klaud-test/shot.png', 2048);
    const first = expandChips(`see [image ${a.n}]`, 'me');
    // Sending (and the box's take) doesn't forget it: a Retry expands it the same way.
    expect(attachment(a.n)).toEqual(a);
    expect(expandChips(`see [image ${a.n}]`, 'me').text).toBe(first.text);
    expect(first.text).toContain('shot.png');
  });
});
