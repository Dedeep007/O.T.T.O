import explorePrompt from './prompts/explore.js';
import planPrompt from './prompts/plan.js';
import fullPrompt from './prompts/full.js';
import condensedPrompt from './prompts/condensed.js';

export type AgentMode = 'build' | 'explore' | 'plan' | 'tasker' | 'coder';

export interface AgentRole {
  id: AgentMode;
  description: string;
  allowedTools: string[];
  prompt: string;
}

export class AgentRegistry {
  private static loadPrompt(name: string): string {
    switch (name) {
      case 'explore': return explorePrompt;
      case 'plan': return planPrompt;
      case 'full': return fullPrompt;
      case 'condensed': return condensedPrompt;
      default: return '';
    }
  }

  public static getAgent(mode: AgentMode): AgentRole {
    switch (mode) {
      case 'explore':
        return {
          id: 'explore',
          description: 'Codebase research specialist. Read-only tools.',
          allowedTools: ['search_code', 'read_file_lines', 'read_file', 'list_directory'],
          prompt: this.loadPrompt('explore')
        };
      case 'plan':
        return {
          id: 'plan',
          description: 'Architect and technical designer. Can write plans but cannot edit source code.',
          allowedTools: ['search_code', 'read_file_lines', 'read_file', 'list_directory', 'write_file'],
          prompt: this.loadPrompt('plan')
        };
      case 'tasker':
        return {
          id: 'tasker',
          description: 'Implementation Tasker. Divides technical plans into atomic sequential steps.',
          allowedTools: ['search_code', 'read_file_lines', 'read_file', 'list_directory'],
          prompt: "You are the Tasker Agent. Break down the provided technical plan into a sequence of atomic, actionable tasks."
        };
      case 'coder':
        return {
          id: 'coder',
          description: 'Execution specialist. Writes code and uses tools.',
          allowedTools: ['*'],
          prompt: "You are the Coding Agent. Execute the given tasks sequentially using the available tools."
        };
      case 'build':
      default:
        return {
          id: 'build',
          description: 'Full-stack developer with read and write access.',
          // '*' means all tools are allowed
          allowedTools: ['*'],
          prompt: this.loadPrompt('full')
        };
    }
  }
}
