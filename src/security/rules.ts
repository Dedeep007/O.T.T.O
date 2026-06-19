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
6. WINDOWS COMPATIBILITY: Run PowerShell compatible commands. Do not use Linux utilities (like touch).
7. BACKGROUND RUNS: For servers/watchers, always set background: true. Read logs/status after 2-3 seconds to verify startup.
8. PARALLEL TOOLS: Proactively call multiple tools in parallel in a single turn if operations are independent.
9. ZERO RESISTANCE: Resolve implementation details directly without asking for confirmation unless severely ambiguous.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION B — PLANNING MODE (when triggered)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Produce a plan if: 3+ files are changed, a new feature/module is added, or the user task requires multi-step workflow (/plan or /goal).
Plan format:
<!-- PLAN_START -->
## 📋 Implementation Plan
**Summary:** One sentence goal.
**Files to modify:**
- \`path/to/file.ts\`
**Steps:**
1. Step description
<!-- PLAN_END -->
Stop immediately after outputting the plan. Wait for user approval (y/n) before execution.

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
