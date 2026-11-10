import { needToolbox } from '../core/toolbox/registry.js';
import type { Session } from '../core/session.js';
import type { Args, Method } from './api.js';

/** What each `toolbox.*` method does (see toolbox-api.ts, BLG-75). */

type ToolboxMethod = Extract<Method, `toolbox.${string}`>;
type ToolboxHandlers = { readonly [M in ToolboxMethod]: (s: Session, ...args: Args<M>) => unknown };

export const TOOLBOX_HANDLERS: ToolboxHandlers = {
  'toolbox.list': (s, root) => needToolbox(s).list(root),
  'toolbox.create': (s, root, draft) => needToolbox(s).create(root, draft),
  'toolbox.update': (s, root, id, patch) => needToolbox(s).update(root, id, patch),
  'toolbox.delete': (s, root, id) => needToolbox(s).delete(root, id),
  'toolbox.run': (s, root, id, params) => {
    const tb = needToolbox(s);
    const projects = s.store.getState().projects;
    const project = projects.find((p) => p.root === root);
    if (!project) throw new Error(`Project not found: ${root}`);
    return tb.run(root, project.id, id, params ?? {});
  },
  'toolbox.approve': (s, root, id) => {
    const tb = needToolbox(s);
    const tool = tb.list(root).find((t) => t.id === id);
    if (!tool) throw new Error(`Tool not found: ${id}`);
    tb.approve(root, tool.command);
  },
  'toolbox.sshHosts': (s) => needToolbox(s).sshHosts(),
  'toolbox.dismissSuggestion': (s, root, sigId) => {
    needToolbox(s).dismissSig(root, sigId);
    s.store.dispatch({ type: 'toolbox_suggestion_remove', id: sigId });
  },
  'toolbox.acceptProposal': (s, root, draft) => {
    const result = needToolbox(s).create(root, draft);
    const suggestion = s.store.getState().toolboxSuggestions.find((sg) => sg.projectRoot === root && sg.command === draft.command && sg.name === draft.name);
    if (suggestion) s.store.dispatch({ type: 'toolbox_suggestion_remove', id: suggestion.id });
    return result;
  },
};
