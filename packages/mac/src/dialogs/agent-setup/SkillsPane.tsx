import { AgentsDocSettings } from './AgentsDocSettings.js';
import { BuiltInInstructions } from './BuiltInInstructions.js';
import { MachineNoteSettings } from './MachineNoteSettings.js';
import { MemorySettings } from './MemorySettings.js';
import { ReflectionSettings } from './ReflectionSettings.js';
import { SharedSkillsSettings } from './SharedSkillsSettings.js';

export const SkillsPane = () => (
  <>
    <MachineNoteSettings />
    <MemorySettings />
    <ReflectionSettings />
    <SharedSkillsSettings />
    <AgentsDocSettings />
    <BuiltInInstructions />
  </>
);
