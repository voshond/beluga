import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { decideTool } from '../src/agent/policy.js';
import { logStateOf, sourcesOf } from '../src/core/initiatives/log.js';
import { MEETINGS_HOW, meetingNotesFile, meetingsHint, noNotesLine } from '../src/core/initiatives/meetings.js';
import { SuggestionSchema, timelineOf } from '../src/core/initiatives/model.js';
import { CHECK_IN_PROMPT } from '../src/core/initiatives/prompt.js';

describe('meeting notes in the check-in', () => {
  it('the check-in reads held meetings in its own part, and keeps prep notes for coming ones', () => {
    expect(CHECK_IN_PROMPT).toContain(MEETINGS_HOW);
    expect(MEETINGS_HOW).toContain('prep notes');
    expect(MEETINGS_HOW).toContain('status.json’s "at"; a week back when there is none');
    expect(MEETINGS_HOW).toContain('never the rest of the calendar');
  });

  it('looks for notes in the event, then Drive, then Beluga call notes', () => {
    const order = ['get_event', 'drive_search', 'drive_read_file', 'call_notes_search', 'call_notes_read'].map((tool) => MEETINGS_HOW.indexOf(tool));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(MEETINGS_HOW).toContain('Notes by Gemini');
  });

  it('reads an oversized result from its file in parts', () => {
    expect(MEETINGS_HOW).toMatch(/saved to a file, Read that file with offset and limit/);
    expect(MEETINGS_HOW).toContain('never work from the first part alone');
  });

  it('keeps a summary, never the raw transcript', () => {
    expect(MEETINGS_HOW).toContain('sources/meetings/YYYY-MM-DD-title.md');
    expect(MEETINGS_HOW).toContain('never the raw transcript');
  });

  it('turns decisions into decided log entries, action items into task suggestions and asks into waiting-on', () => {
    expect(MEETINGS_HOW).toMatch(/kind "decision".*"answer" what was decided, "state": "approved".*"sources" the meeting’s notes/);
    expect(MEETINGS_HOW).toMatch(/kind "task".*never create a task on your own/);
    expect(MEETINGS_HOW).toContain('(waiting on: Natalia)');
    expect(MEETINGS_HOW).toContain('under "## Open" in decisions.md');
  });

  it('carries on without notes, and proposes meetings to follow when there are none', () => {
    expect(MEETINGS_HOW).toContain('no notes found');
    expect(MEETINGS_HOW).toContain('carry on with the rest of the check-in');
    expect(MEETINGS_HOW).toMatch(/follows no meetings.*one suggestion of kind "calendar"/);
    expect(meetingsHint([])).toContain('No meetings followed yet');
    expect(meetingsHint([{ match: 'Checkout' }])).toContain('call_notes_search');
  });

  it('names the summary file and the no-notes line', () => {
    expect(meetingNotesFile('2026-11-26', 'Go/no-go: Checkout v2!')).toBe('sources/meetings/2026-11-26-go-no-go-checkout-v2.md');
    expect(meetingNotesFile('2026-11-26', '***')).toBe('sources/meetings/2026-11-26-meeting.md');
    expect(timelineOf(`- ${noNotesLine('2026-11-26', 'Go/no-go')}`)).toEqual([
      {
        day: '2026-11-26',
        kind: 'meeting',
        text: 'Go/no-go held, no notes found (looked in the event, Drive and call notes)',
      },
    ]);
  });

  it('a decision made in a meeting reads as decided, with the meeting as its source', () => {
    const made = SuggestionSchema.parse({
      id: 9,
      text: 'Keep manual entry?',
      kind: 'decision',
      answer: 'Keep it',
      state: 'approved',
      resolvedAt: '2026-11-24T10:00:00Z',
      outcome: 'Decided in Design review on 2026-11-24',
      sources: [
        {
          label: 'Design review notes',
          url: 'https://docs.google.com/document/d/1abc/edit',
        },
      ],
    });
    expect(logStateOf(made)).toBe('decided');
    expect(
      sourcesOf(made, {
        epics: [],
        tickets: undefined,
        docs: [],
        slack: [],
        outbox: [],
      }),
    ).toEqual([
      {
        label: 'Design review notes',
        url: 'https://docs.google.com/document/d/1abc/edit',
      },
    ]);
  });
});

describe('a transcript too big for one answer', () => {
  const spilled = path.join(os.homedir(), '.claude', 'projects', '-home-me-initiatives-checkout-v2', '0f3a', 'tool-results', 'mcp-calendar-drive_read_file-1.txt');
  const checkIn = {
    cwd: '/home/me/initiatives/checkout-v2',
    roots: ['/home/me/initiatives'],
    autoEdit: true,
    scope: 'full' as const,
    dotenv: true,
    yourRun: true,
  };

  it('your own initiative chat reads the file Claude Code saved it to, without asking', () => {
    expect(decideTool('Read', { file_path: spilled, offset: 400, limit: 400 }, checkIn)).toBe('allow');
  });
});
