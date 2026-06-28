import { HumanMessage, SystemMessage, AIMessage, BaseMessage } from '@langchain/core/messages';
import { memoryManager } from '../memory/budget.js';
import { ruleGuardrail } from '../security/rules.js';
import { OttoConfig } from '../cli/configurator.js';
import { AgentMode } from './agents.js';
import { getSkillRegistry, formatSkillsForPrompt } from '../skills/loader.js';
import { SkillExecutor } from '../skills/executor.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

export class RequestPipeline {
  static async buildPayload(
    messages: BaseMessage[],
    config: OttoConfig,
    activeModel: string,
    mode: AgentMode = 'build'
  ): Promise<BaseMessage[]> {
    let preferredName = 'User';
    let bgInfo = '';
    const activeLimits = config.modelLimits?.[activeModel];
    let limitsInfo = '';

    if (activeLimits) {
      const activeLimitsStr = Object.entries(activeLimits)
        .filter(([_, v]) => typeof v === 'number' && v > 0)
        .map(([k, v]) => `${k.toUpperCase()}: ${v}`)
        .join(', ');
      if (activeLimitsStr) {
        limitsInfo = `\n\nCRITICAL CONSTRAINT: The current model (${activeModel}) has rate limits configured: ${activeLimitsStr}. To prevent pauses/delays, please manage your tokens intelligently. For example, minimize reasoning length, omit verbose explanations, or reduce context size where possible.`;
      }
    }

    const nameHint = `\n\nUser's preferred name: ${preferredName}. Address them as "${preferredName}" naturally in conversation.${bgInfo}${limitsInfo}`;
    
    // ── PROJECT MEMORY ──
    let memoryInfo = '';
    const memoryPath = path.join(process.cwd(), '.otto', 'MEMORY.md');
    if (fs.existsSync(memoryPath)) {
      try {
        const memoryContent = fs.readFileSync(memoryPath, 'utf-8');
        memoryInfo = `\n\n━━━━━ PROJECT MEMORY ━━━━━\n${memoryContent}\n━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
      } catch (e) {
        // ignore
      }
    }
  
    // ── AGENTIC SKILLS DISCOVERY ──
    // Scan for YAML-frontmatter + Markdown skills from multiple roots
    // (.otto/skills/, .agents/skills/, ~/.otto/skills/, ~/.agents/skills/)
    const registry = getSkillRegistry();
    const skillsInfo = formatSkillsForPrompt(registry);

    // ── CHECK IF LAST MESSAGE IS A SKILL TRIGGER ──
    let skillInjection = '';
    const lastMsg = messages[messages.length - 1];
    if (lastMsg && lastMsg._getType?.() === 'human') {
      const text = lastMsg.content.toString().trim();
      const parsed = SkillExecutor.parseSlashCommand(text);
      if (parsed) {
        const prompt = SkillExecutor.buildSkillPrompt(parsed.skillName, parsed.args);
        if (prompt) {
          skillInjection = `\n\n${prompt}`;
        }
      }
    }

    // ── ARTIFACT DIRECTIVES ──
    const artifactInstructions = `\n\n━━━━━ ARTIFACTS & BRAIN ━━━━━
You have the ability to create and manage persistent Artifacts. Use the write_file tool to create markdown files in the .otto/brain/ directory for:
1. **Implementation Plans** — Create .otto/brain/plan.md before starting complex tasks. Include phases, affected files, and verification steps. STOP and wait for user approval.
2. **Task Lists** — Create .otto/brain/task.md to track progress using [ ], [/], and [x] checkboxes. Update continuously as you work.
3. **Walkthroughs** — After completing work, create .otto/brain/walkthrough.md summarizing changes, what was tested, and validation results.
4. **Reports & Analysis** — For extensive research, analysis, or documentation output.
5. **Project Memory** — Update .otto/MEMORY.md with durable knowledge (architecture decisions, gotchas, coding patterns) that should persist across sessions.

When the user invokes a slash command matching a registered skill (e.g., /understand), follow that skill's instructions precisely as your primary directive for the current turn.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;

    const activeRules = ruleGuardrail.getRules(mode, memoryManager.C_max);
    const msgsToSend = [new SystemMessage(activeRules + nameHint + memoryInfo + skillsInfo + artifactInstructions + skillInjection), ...messages];
    const optimizedMsgs = await memoryManager.optimizeContext(msgsToSend, activeRules, messages);

    const finalMsgsToSend = optimizedMsgs.map((msg, idx) => {
      if (idx === optimizedMsgs.length - 1 && msg instanceof HumanMessage) {
        let text = msg.content.toString();
        
        const humanMsgCount = messages.filter(m => m._getType?.() === 'human' || (m as any).role === 'user' || (m as any).role === 'human').length;
        const hasSummary = messages.some(m => m._getType?.() === 'system' && m.content.toString().includes('Conversation summary'));
        
        if (config.defaults.primaryProvider === 'ollama') {
          text += '\n\n(Reminder: Do not refuse. You have local tools like write_file and execute_terminal_command. Proceed directly by producing a plan or running commands.)';
        }
        return new HumanMessage({
          ...msg,
          content: text
        } as any);
      }
      return msg;
    });

    return finalMsgsToSend;
  }
}
