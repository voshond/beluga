import { AgentsDocSettings } from './AgentsDocSettings.js';
import { BuiltInInstructions } from './BuiltInInstructions.js';
import { MachineNoteSettings } from './MachineNoteSettings.js';
import { SharedSkillsSettings } from './SharedSkillsSettings.js';

export const SkillsPane = () => (
  <>
    <MachineNoteSettings />
    <SharedSkillsSettings />
    <AgentsDocSettings />
    <BuiltInInstructions />
  </>
);
