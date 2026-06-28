/**
 * O.T.T.O Skills & Agents System
 * Inspired by Understand-Anything's agentic skill architecture.
 * 
 * Skills are YAML-frontmatter + Markdown instruction documents.
 * Agents are specialized LLM personas with scoped tool access.
 */

export interface SkillFrontmatter {
  name: string;
  description: string;
  'argument-hint'?: string[];
  /** Optional list of agent names this skill orchestrates */
  agents?: string[];
  /** If true, skill can run without user confirmation */
  autonomous?: boolean;
}

export interface Skill {
  /** Unique name derived from frontmatter or directory name */
  name: string;
  /** Human-readable description */
  description: string;
  /** Hint shown in autocomplete for arguments */
  argumentHint?: string[];
  /** Full markdown body (instructions for the LLM) */
  body: string;
  /** Absolute path to the SKILL.md file */
  filePath: string;
  /** Directory containing the skill (for bundled scripts) */
  skillDir: string;
  /** List of agents this skill orchestrates */
  agents?: string[];
  /** Whether this skill runs autonomously */
  autonomous?: boolean;
  /** Bundled helper scripts (.mjs, .py, .js, .ts) found in the skill directory */
  scripts: string[];
}

export interface AgentDefinition {
  /** Unique agent name from frontmatter */
  name: string;
  /** Description of the agent's role */
  description: string;
  /** Full markdown body (persona/task instructions) */
  body: string;
  /** Absolute path to the agent definition file */
  filePath: string;
}

export interface SkillRegistry {
  /** All discovered skills, keyed by name */
  skills: Map<string, Skill>;
  /** All discovered agents, keyed by name */
  agents: Map<string, AgentDefinition>;
  /** Timestamp of last discovery scan */
  lastScanned: number;
}

export interface SkillExecutionContext {
  /** The skill being executed */
  skill: Skill;
  /** User-provided arguments after the slash command */
  arguments: string;
  /** Current working directory */
  projectRoot: string;
}
