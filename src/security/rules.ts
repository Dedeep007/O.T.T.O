import fs from 'fs';
import path from 'path';
import os from 'os';
import { ui } from '../cli/ui.js';
import { select } from '@inquirer/prompts';
import { execSync } from 'child_process';

export class RuleGuardrail {
  private rulesPath: string;

  constructor() {
    this.rulesPath = path.join(os.homedir(), '.otto', 'rules.md');
    this.ensureRulesExist();
  }

  private ensureRulesExist() {
    const dir = path.dirname(this.rulesPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    
    const defaultRules = `# O.T.T.O System Directives

These are the core rules the agent must follow.
1. The user is running Windows (PowerShell). DO NOT use Linux/Bash-specific commands like \`cat > file << EOF\` or \`touch\`.
2. To create or modify files, you MUST use native Node.js tools if available, or write PowerShell compatible commands (e.g., \`Set-Content\`, \`Out-File\`).
3. Always verify commands are compatible with Windows.`;
    fs.writeFileSync(this.rulesPath, defaultRules, 'utf-8');
  }

  public getRules(): string {
    const persistedRules = fs.readFileSync(this.rulesPath, 'utf-8');
    return `${persistedRules}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION A — CODING RULES (always apply)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. SEARCH BEFORE EDITING: Use search_code to locate target symbols/files. Inspect precise ranges with read_file_lines. Do not read entire large files or edit blindly.
2. TARGETED EDITS: Use replace_file_lines for modifying code to preserve diffs. Use write_file only for new files. Do not use shell redirections or heredocs (e.g. >, >>, Out-File, Set-Content) to write code.
3. DISCOVER LAYOUT: Use list_files to explore directory structure before making assumptions.
4. CONCISE RESPONSES: Summarize actions in 1-2 sentences. Do not dump code blocks into chat; the TUI diff shows them automatically.
5. PROACTIVE & AUTONOMOUS: Proactively run compile/test commands (e.g., npm run build, npx tsc, npm test) via execute_terminal_command to verify changes. If they fail, inspect stderr/logs and fix errors autonomously.
6. TOOL COMPATIBILITY: Prioritize using native Node.js APIs or workspace-provided tools rather than executing shell commands where possible to maximize performance and reliability.
7. WINDOWS COMPATIBILITY: Run PowerShell compatible commands. Do not use Linux utilities (like touch).
8. BACKGROUND RUNS: For servers/watchers, always set background: true. Read logs/status after 2-3 seconds to verify startup.
9. PARALLEL TOOLS: Proactively call multiple tools in parallel in a single turn if operations are independent.
10. ZERO RESISTANCE: Resolve implementation details directly without asking for confirmation unless severely ambiguous.
11. ACTUAL TOOL CALLS: You MUST invoke tools programmatically. Do not simulate tool outputs in your text response. If you cannot use native tool calling, output a valid JSON code block containing the tool calls: \`\`\`json\n[{"name": "tool_name", "args": {...}}]\n\`\`\`.
12. NO REFUSALS: Do not refuse tasks or output capability refusals (e.g. 'I'm sorry, but I can't assist', 'as an AI language model'). You have access to local terminal execution via execute_terminal_command. You CAN run scripts, install packages, train models, compile code, and inspect systems natively. Always proceed by writing code and executing it.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION B — PLANNING MODE (Judgement & Gating)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. WHEN TO PLAN: You MUST produce an implementation plan (using PLAN_START/PLAN_END) at the start of any new chat thread (on your very first turn), regardless of complexity. For subsequent turns, you must produce a plan before performing significant, multi-file code modifications, complex refactoring, or creating new components/files.
2. WHEN NOT TO PLAN: Do not produce a plan or block the conversation if the user's request is:
   - Investigatory or diagnostic in nature (e.g., 'search for X', 'explain how Y works', 'check git status').
   - A minor tweak, single-line alignment, simple code formatting, or a trivial syntax fix.
   - A direct follow-up or minor correction to a plan that was already approved.
3. HOW TO PLAN: Produce a plan using this exact format:
<!-- PLAN_START -->
## 📋 Implementation Plan
**Summary:** One sentence goal.
**Files to modify/create:**
- \`path/to/file\`
**Steps:**
1. Step description
<!-- PLAN_END -->
Stop immediately after outputting the plan. Wait for user approval (y/n) before execution.
4. RESPECT CANCELLATIONS: If the user cancels the plan (e.g. typing "cancel", "no", or selecting "Cancel - do not proceed" option), you MUST respect it. Stop attempting to execute or re-propose that plan. Acknowledge the cancellation clearly, describe what you are stopping, and ask the user for new instructions or next steps instead of looping.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION C — EXECUTION & VERIFICATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Execute approved plans step-by-step. Run verification tests after editing. Autonomously fix compilation/test failures.`;
  }

  public async requestRuleChange(newRulesContent: string): Promise<boolean> {
    const currentRules = this.getRules();
    
    // We could use a proper diffing library here, but a simple text display works for MVP
    ui.header('CRITICAL: Rule Modification Requested (L3 Guardrail)');
    ui.alert('The agent is attempting to modify its own core directives.');
    
    console.log(ui.accent('--- Current Rules ---'));
    console.log(currentRules);
    console.log(ui.accent('--- Proposed Rules ---'));
    console.log(newRulesContent);

    const approved = await select({
      message: 'Do you authorize this permanent change to the System Directives?',
      choices: [
        { name: 'Approve', value: true },
        { name: 'Deny', value: false }
      ]
    });

    if (approved) {
      fs.writeFileSync(this.rulesPath, newRulesContent, 'utf-8');
      ui.success('Rules updated successfully.');
      return true;
    } else {
      ui.error('Rule modification denied.');
      return false;
    }
  }
}

export const ruleGuardrail = new RuleGuardrail();
