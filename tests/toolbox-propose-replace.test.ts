import { describe, expect, it } from 'vitest';
import { waitingNeeds } from '../src/companion/needs-you.js';
import { type DomainState, type ToolboxSuggestion, initialState } from '../src/core/store.js';

const withSuggestion = (sg: ToolboxSuggestion): DomainState => ({ ...initialState('room'), toolboxSuggestions: [sg] });

const proposal = (extra: Partial<ToolboxSuggestion> = {}): ToolboxSuggestion => ({ id: 'propose-1', kind: 'propose', projectRoot: '/code/app', name: 'Deploy', command: 'ssh {{host}} ./deploy.sh', params: [{ name: 'host', kind: 'host' }], askedAt: 1000, ...extra });

describe('an agent-proposed Toolbox tool', () => {
  it('new: Keep creates a personal tool', () => {
    const [item] = waitingNeeds(withSuggestion(proposal())).filter((n) => n.id === 'toolbox-propose:propose-1');
    expect(item?.title).toBe('Save tool "Deploy" to app\'s Toolbox?');
    expect(item?.detail).toBe('ssh {{host}} ./deploy.sh');
    expect(item?.actions[0]).toMatchObject({ label: 'Keep', method: 'toolbox.acceptProposal' });
    expect(item?.actions[0]?.args).toHaveLength(2);
  });

  it('a revision: Update passes the tool it replaces, and keeps its source', () => {
    const [item] = waitingNeeds(withSuggestion(proposal({ replaces: 'tool-9', previous: 'ssh old ./deploy.sh' }))).filter((n) => n.id === 'toolbox-propose:propose-1');
    expect(item?.title).toBe('Update tool "Deploy" in app\'s Toolbox?');
    expect(item?.detail).toBe('Now: ssh old ./deploy.sh\nNew: ssh {{host}} ./deploy.sh');
    expect(item?.actions.map((a) => a.label)).toEqual(['Update', 'Discard']);
    expect(item?.actions[0]?.args).toEqual(['/code/app', { name: 'Deploy', command: 'ssh {{host}} ./deploy.sh', params: [{ name: 'host', kind: 'host' }] }, 'tool-9']);
  });
});
