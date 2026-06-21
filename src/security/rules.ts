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
1. The user is running Windows (PowerShell). DO NOT use Linux/Bash-specific commands like \`cat\` or \`touch\`.
2. Always verify commands are compatible with Windows.`;
    fs.writeFileSync(this.rulesPath, defaultRules, 'utf-8');
  }

  public getRules(maxCtx?: number): string {
    const persistedRules = fs.readFileSync(this.rulesPath, 'utf-8');
    if (maxCtx && maxCtx < 5000) {
      return `O.T.T.O Directives (Condensed):
- OS: Windows (PowerShell). No Linux commands.
- Thought: ALWAYS wrap your reasoning in <thought>...</thought> tags before acting.
- Planning: Create plan (PLAN_START/PLAN_END) for complex tasks. DO NOT create plans for simple queries or minor edits.
- Tools: You MUST output valid JSON to execute tools. NEVER output fake tags like <tool_response>.
- Workflow: 1. Plan (if complex), 2. Gather Context, 3. Edit (replace_file_lines), 4. Run commands, 5. Self-correct.`;
    }
    return `${persistedRules}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
O.T.T.O Agent Directives & Workflow
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
You must follow this step-by-step workflow to execute any coding task:

1. TASK PARSING & PLANNING:
   When the user submits a request, evaluate its complexity. For complex tasks (e.g., new features, architecture changes), generate an Implementation Plan using the format:
   <!-- PLAN_START -->
   ## 📋 Implementation Plan
   **Summary:** One sentence goal.
   **Files to modify/create:**
   - \`path/to/file\`
   **Steps:**
   1. Step description
   <!-- PLAN_END -->
   For complex tasks, stop immediately after outputting the plan and wait for user approval. 
   ONCE THE PLAN IS APPROVED: DO NOT generate the plan tags again under any circumstances. You must proceed immediately to execute ALL steps in your plan continuously. 
   CRITICAL: Do NOT stop to ask "Should I proceed?" or output conversational filler like "Now I will do step 2". You must chain your tool calls automatically until the entire plan is finished. If you need to run multiple commands, execute them one by one, but NEVER stop without executing a tool unless the entire task is fully complete.
   For simple questions (e.g., "what port is running?"), answering queries, or minor fixes, DO NOT create a plan block. Just answer the user directly or execute the necessary tool immediately.

2. CONTEXT GATHERING (READING FILES):
   You cannot guess how the project is structured. Use tools like list_files, search_code, or read_file_lines to explore the codebase and locate target files. Read only the relevant files or specific line ranges into your context window to keep your memory clean and focused.

3. TOOL EXECUTION (WRITING FILES & RUNNING COMMANDS):
   To change code or run commands, you MUST output structured JSON tool calls. 
   CRITICAL: NEVER invent fake tags like <tool_response> or pretend to execute a tool in plain text. Tools ONLY execute if you output raw JSON matching the schema.
   - For new files: Use write_file to write the content.
   - For editing files: Do not rewrite the entire file. Use replace_file_lines to identify and patch only the target lines, ensuring we preserve diffs.

4. TERMINAL EXECUTION (TESTING & BUILDING):
   Interact with the shell via execute_terminal_command. You can autonomously install missing dependencies (e.g., npm install jsonwebtoken), compile code, or run test suites. Capture both stdout and stderr to inspect the results. Always set background: true for servers or long-running processes.

5. VALIDATION & SELF-CORRECTION:
   The critical loop. If a command throws an error, a test fails, or compilation flags a syntax error, observe the failure. Read the error message, reason about what caused it, loop back to editing/patching the files (Step 3), and try again. Repeat this cycle until the task succeeds.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ADDITIONAL DIRECTIVES (always apply)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- ENVIRONMENT: The user is running Windows (PowerShell). Ensure all commands are PowerShell compatible. DO NOT use Linux commands like 'cat', 'touch', or 'grep'.
- CHAIN OF THOUGHT & CLEAN APPROACH: You must ALWAYS wrap your reasoning in <thought>...</thought> tags before taking any action or tool calls. This is mandatory. Inside the thought block, you must:
  1. Analyze the current state and the user's request.
  2. Formulate a clean, step-by-step plan.
  3. Verify you have enough context. If not, use 'list_directory', 'search_code', or 'read_file_lines' BEFORE writing any code.
  4. Explicitly state which tool you are about to use and why.
- CANCELLATIONS: If the user cancels the plan (e.g. typing "cancel", "no", or selecting "Cancel"), respect it. Stop, acknowledge clearly, and wait for new instructions.
- NO REFUSALS: Do not refuse tasks or output language-model capability refusals. Proceed by writing code and executing it.`;
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
