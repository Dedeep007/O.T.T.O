import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { getSkillRegistry, getSkillInstructions } from '../skills/loader.js';

export const readSkillTool = tool(
  async ({ skillName }) => {
    const registry = getSkillRegistry();
    const instructions = getSkillInstructions(registry, skillName);
    
    if (!instructions) {
      return `Error: Skill '${skillName}' not found in the Knowledge Graph. Please check the exact name in the SKILLS KNOWLEDGE GRAPH block.`;
    }
    
    return instructions;
  },
  {
    name: 'read_skill',
    description: 'Reads the detailed instructional knowledge graph for a specific skill. Use this to learn HOW to implement a pattern.',
    schema: z.object({
      skillName: z.string().describe('The exact name of the skill to read (e.g., "react-components")')
    })
  }
);
