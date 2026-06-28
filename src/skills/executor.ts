/**
 * O.T.T.O Skill Executor
 * 
 * Routes slash commands to discovered skills,
 * injects skill instructions into the LLM context,
 * and manages skill lifecycle.
 */

import { getSkillRegistry, getSkillInstructions, getAgentInstructions } from './loader.js';
import type { Skill, SkillExecutionContext } from './types.js';

export class SkillExecutor {
  /**
   * Check if a user message is a slash command that matches a discovered skill.
   * Returns the skill name and arguments if matched, null otherwise.
   */
  static parseSlashCommand(input: string): { skillName: string; args: string } | null {
    const trimmed = input.trim();
    if (!trimmed.startsWith('/')) return null;

    // Extract the command name (first word after /)
    const match = trimmed.match(/^\/(\S+)\s*(.*)?$/);
    if (!match) return null;

    const skillName = match[1].toLowerCase();
    const args = (match[2] || '').trim();

    // Check if this is a registered skill
    const registry = getSkillRegistry();
    if (registry.skills.has(skillName)) {
      return { skillName, args };
    }

    return null;
  }

  /**
   * Build the full system prompt injection for a triggered skill.
   * This includes the skill body, any referenced agent personas,
   * and contextual variables like $ARGUMENTS and $PROJECT_ROOT.
   */
  static buildSkillPrompt(skillName: string, userArgs: string): string | null {
    const registry = getSkillRegistry();
    const instructions = getSkillInstructions(registry, skillName);
    if (!instructions) return null;

    // Replace contextual variables
    let prompt = instructions;
    prompt = prompt.replace(/\$ARGUMENTS/g, userArgs || '(none)');
    prompt = prompt.replace(/\$PROJECT_ROOT/g, process.cwd());

    const skill = registry.skills.get(skillName)!;
    if (skill.skillDir) {
      prompt = prompt.replace(/\<SKILL_DIR\>/g, skill.skillDir);
    }

    // If the skill references agents, append their instructions
    if (skill.agents && skill.agents.length > 0) {
      prompt += '\n\n━━━━━ REFERENCED AGENTS ━━━━━\n';
      for (const agentName of skill.agents) {
        const agentBody = getAgentInstructions(registry, agentName);
        if (agentBody) {
          prompt += `\n## Agent: ${agentName}\n${agentBody}\n`;
        }
      }
      prompt += '━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    }

    return prompt;
  }

  /**
   * Get a list of all available skill names for autocomplete.
   */
  static getSkillNames(): string[] {
    const registry = getSkillRegistry();
    return Array.from(registry.skills.keys());
  }

  /**
   * Get autocomplete suggestions for the input field.
   * Returns skill names that match the current input.
   */
  static getAutocompleteSuggestions(input: string): Array<{ name: string; description: string; hint?: string }> {
    if (!input.startsWith('/')) return [];

    const query = input.slice(1).toLowerCase();
    const registry = getSkillRegistry();
    const suggestions: Array<{ name: string; description: string; hint?: string }> = [];

    for (const [name, skill] of registry.skills) {
      if (name.startsWith(query) || query === '') {
        suggestions.push({
          name: `/${name}`,
          description: skill.description,
          hint: skill.argumentHint?.join(' '),
        });
      }
    }

    return suggestions;
  }
}
