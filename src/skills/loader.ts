/**
 * O.T.T.O Skill Loader
 * 
 * Discovers and parses YAML-frontmatter + Markdown skill files
 * from multiple discovery roots, following the pattern established
 * by Understand-Anything's plugin architecture.
 * 
 * Discovery roots (scanned in order):
 *   1. <cwd>/.otto/skills/          — Project-local skills
 *   2. <cwd>/.agents/skills/        — Cross-platform compat (Codex, Gemini CLI, etc.)
 *   3. ~/.otto/skills/              — Global user skills
 *   4. ~/.agents/skills/            — Global cross-platform skills
 *
 * Each skill lives in its own directory with a SKILL.md file:
 *   skills/
 *     my-skill/
 *       SKILL.md        — YAML frontmatter + instructions
 *       helper.mjs      — Optional bundled script
 *
 * Agents live in an `agents/` directory alongside skills:
 *   agents/
 *     my-agent.md       — YAML frontmatter + persona instructions
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import type { Skill, AgentDefinition, SkillRegistry, SkillFrontmatter } from './types.js';

/** Simple YAML frontmatter parser (no external dependency needed) */
function parseFrontmatter(content: string): { frontmatter: Record<string, any>; body: string } {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!fmMatch) {
    return { frontmatter: {}, body: content };
  }

  const yamlStr = fmMatch[1];
  const body = fmMatch[2].trim();
  const frontmatter: Record<string, any> = {};

  // Parse simple YAML (key: value, key: [array], key: |multiline)
  let currentKey = '';
  let multilineValue = '';
  let inMultiline = false;

  for (const line of yamlStr.split('\n')) {
    const trimmed = line.trimEnd();

    if (inMultiline) {
      if (/^\S/.test(trimmed) && trimmed.includes(':')) {
        // New key starts — save previous multiline
        frontmatter[currentKey] = multilineValue.trim();
        inMultiline = false;
      } else {
        multilineValue += (multilineValue ? '\n' : '') + trimmed.replace(/^\s{2}/, '');
        continue;
      }
    }

    const kvMatch = trimmed.match(/^(\S[\w-]*)\s*:\s*(.*)$/);
    if (!kvMatch) continue;

    currentKey = kvMatch[1];
    let value = kvMatch[2].trim();

    if (value === '|' || value === '>') {
      inMultiline = true;
      multilineValue = '';
      continue;
    }

    // Array value: ["item1", "item2"] or [item1, item2]
    const arrMatch = value.match(/^\[(.*)\]$/);
    if (arrMatch) {
      frontmatter[currentKey] = arrMatch[1]
        .split(',')
        .map(s => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
      continue;
    }

    // Boolean
    if (value === 'true') { frontmatter[currentKey] = true; continue; }
    if (value === 'false') { frontmatter[currentKey] = false; continue; }

    // Remove surrounding quotes
    value = value.replace(/^["']|["']$/g, '');
    frontmatter[currentKey] = value;
  }

  if (inMultiline) {
    frontmatter[currentKey] = multilineValue.trim();
  }

  return { frontmatter, body };
}

/** Discover helper scripts in a skill directory */
function discoverScripts(skillDir: string): string[] {
  const scriptExts = ['.mjs', '.js', '.ts', '.py', '.sh', '.ps1'];
  try {
    return fs.readdirSync(skillDir)
      .filter(f => scriptExts.some(ext => f.endsWith(ext)))
      .map(f => path.join(skillDir, f));
  } catch {
    return [];
  }
}

/** Load a single skill from a SKILL.md file path */
function loadSkill(skillMdPath: string): Skill | null {
  try {
    const content = fs.readFileSync(skillMdPath, 'utf-8');
    const { frontmatter, body } = parseFrontmatter(content);

    if (!frontmatter.name) return null;

    const skillDir = path.dirname(skillMdPath);
    return {
      name: frontmatter.name,
      description: frontmatter.description || '',
      argumentHint: frontmatter['argument-hint'],
      body,
      filePath: skillMdPath,
      skillDir,
      agents: frontmatter.agents,
      autonomous: frontmatter.autonomous ?? false,
      scripts: discoverScripts(skillDir),
    };
  } catch {
    return null;
  }
}

/** Load an agent definition from a markdown file */
function loadAgent(agentPath: string): AgentDefinition | null {
  try {
    const content = fs.readFileSync(agentPath, 'utf-8');
    const { frontmatter, body } = parseFrontmatter(content);

    if (!frontmatter.name) return null;

    return {
      name: frontmatter.name,
      description: typeof frontmatter.description === 'string' ? frontmatter.description : '',
      body,
      filePath: agentPath,
    };
  } catch {
    return null;
  }
}

/** Scan a single root directory for skills and agents */
function scanRoot(rootDir: string, registry: SkillRegistry): void {
  // Scan skills/ subdirectory
  const skillsDir = path.join(rootDir, 'skills');
  if (fs.existsSync(skillsDir)) {
    try {
      const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const skillMd = path.join(skillsDir, entry.name, 'SKILL.md');
          if (fs.existsSync(skillMd)) {
            const skill = loadSkill(skillMd);
            if (skill && !registry.skills.has(skill.name)) {
              registry.skills.set(skill.name, skill);
            }
          }
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          // Also support flat .md files directly in skills/
          const skill = loadSkill(path.join(skillsDir, entry.name));
          if (skill && !registry.skills.has(skill.name)) {
            registry.skills.set(skill.name, skill);
          }
        }
      }
    } catch { /* ignore unreadable directories */ }
  }

  // Scan agents/ subdirectory
  const agentsDir = path.join(rootDir, 'agents');
  if (fs.existsSync(agentsDir)) {
    try {
      const entries = fs.readdirSync(agentsDir).filter(f => f.endsWith('.md'));
      for (const f of entries) {
        const agent = loadAgent(path.join(agentsDir, f));
        if (agent && !registry.agents.has(agent.name)) {
          registry.agents.set(agent.name, agent);
        }
      }
    } catch { /* ignore */ }
  }
}

/** Full discovery scan across all roots */
export function discoverSkills(): SkillRegistry {
  const registry: SkillRegistry = {
    skills: new Map(),
    agents: new Map(),
    lastScanned: Date.now(),
  };

  const cwd = process.cwd();
  const home = os.homedir();

  // Discovery roots in priority order (project-local first, then global)
  const roots = [
    path.join(cwd, '.otto'),
    path.join(cwd, '.agents'),
    path.join(home, '.otto'),
    path.join(home, '.agents'),
  ];

  for (const root of roots) {
    if (fs.existsSync(root)) {
      scanRoot(root, registry);
    }
  }

  return registry;
}

/** Format discovered skills as a system prompt injection */
export function formatSkillsForPrompt(registry: SkillRegistry): string {
  if (registry.skills.size === 0 && registry.agents.size === 0) {
    return '';
  }

  const lines: string[] = [];
  lines.push('\n\n━━━━━ AGENTIC SKILLS ━━━━━');
  lines.push('The following skills are available. When the user types a slash command matching a skill name, follow that skill\'s instructions precisely.\n');

  // List skill summaries for autocomplete/awareness
  if (registry.skills.size > 0) {
    lines.push('## Available Skills');
    for (const [name, skill] of registry.skills) {
      const hint = skill.argumentHint ? ` ${skill.argumentHint.join(' ')}` : '';
      lines.push(`- **/${name}**${hint} — ${skill.description}`);
    }
    lines.push('');
  }

  // List agent summaries
  if (registry.agents.size > 0) {
    lines.push('## Available Agents');
    for (const [name, agent] of registry.agents) {
      lines.push(`- **${name}** — ${agent.description}`);
    }
    lines.push('');
  }

  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  return lines.join('\n');
}

/** Get the full instruction body for a specific skill (for injection when triggered) */
export function getSkillInstructions(registry: SkillRegistry, skillName: string): string | null {
  const skill = registry.skills.get(skillName);
  if (!skill) return null;

  let instructions = `━━━━━ SKILL ACTIVATED: /${skill.name} ━━━━━\n`;
  instructions += `Description: ${skill.description}\n\n`;
  instructions += skill.body;

  // If the skill has bundled scripts, list them
  if (skill.scripts.length > 0) {
    instructions += '\n\n## Bundled Scripts\n';
    instructions += `Skill directory: ${skill.skillDir}\n`;
    for (const s of skill.scripts) {
      instructions += `- ${path.basename(s)}\n`;
    }
  }

  instructions += '\n━━━━━━━━━━━━━━━━━━━━━━━━━';
  return instructions;
}

/** Get agent instructions for injection */
export function getAgentInstructions(registry: SkillRegistry, agentName: string): string | null {
  const agent = registry.agents.get(agentName);
  if (!agent) return null;
  return agent.body;
}

/** Cached singleton */
let cachedRegistry: SkillRegistry | null = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 30_000; // 30 seconds

export function getSkillRegistry(forceRefresh = false): SkillRegistry {
  const now = Date.now();
  if (!forceRefresh && cachedRegistry && now < cacheExpiry) {
    return cachedRegistry;
  }
  cachedRegistry = discoverSkills();
  cacheExpiry = now + CACHE_TTL_MS;
  return cachedRegistry;
}
