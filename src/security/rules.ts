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
    
    if (!fs.existsSync(this.rulesPath)) {
      const defaultRules = `# O.T.T.O System Directives

These are the core rules the agent must follow.
1. The user is running Windows (PowerShell). DO NOT use Linux/Bash-specific commands like \`cat > file << EOF\` or \`touch\`.
2. To create or modify files, you MUST use native Node.js tools if available, or write PowerShell compatible commands (e.g., \`Set-Content\`, \`Out-File\`).
3. Always verify commands are compatible with Windows.`;
      fs.writeFileSync(this.rulesPath, defaultRules, 'utf-8');
    }
  }

  public getRules(): string {
    const persistedRules = fs.readFileSync(this.rulesPath, 'utf-8');
    return `${persistedRules}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION A — CODING RULES (always apply)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
A1. Before editing existing code, use search_code to locate the relevant function/class, then use read_file_lines to inspect only the needed range.
A2. For small targeted edits, use replace_file_lines with the exact line range. For new files or full rewrites, use write_file.
A3. Never use terminal redirection, heredocs, Set-Content, Out-File, or shell metacharacters to write code — use the write_file or replace_file_lines tools.
A4. Use read_file only when a whole file is genuinely needed; prefer read_file_lines for performance.
A5. Use list_files to inspect folder structure before making assumptions about project layout.
A6. PROACTIVELY use execute_terminal_command to run commands (like installing packages, compiling, or running tests) instead of telling the user to run them. Do not be shy about executing commands; the user has a security approval UI that will intercept and ask them for permission first. Always stay inside the current workspace.
A7. KEEP RESPONSES EXTREMELY CONCISE. NEVER dump full source files into the chat. When writing or modifying files, the UI automatically displays the changes using a rich diff view. Your text response should only include a 1-2 sentence summary of what changed.
A8. When making edits, ONLY show the specific lines modified in your response if absolutely necessary to explain something, otherwise rely on the automatic UI diffs.
A9. Never leave TODO comments or placeholder logic — always implement fully.
A10. When adding a new feature to an existing file, read the surrounding code first to match style and patterns.
A11. NEVER run TypeScript files directly with 'node file.ts'. TypeScript must be executed via: (1) 'npx ts-node file.ts', (2) 'npx tsx file.ts', or (3) compile first with 'npx tsc' then run the compiled JS. Always check package.json scripts first — prefer 'npm run dev' or 'npm start' if they exist.
A12. Terminal Execution Rules: (a) Always check if a package.json exists and use its scripts (npm run dev, npm start, npm test) before crafting raw commands. (b) For servers/long-running processes, ALWAYS use background:true so the tool returns immediately. (c) After starting a background server, wait 2-3 seconds then read its log file to confirm the port it is listening on before telling the user it is ready. (d) On Windows, use PowerShell-compatible syntax — no bash heredocs, no 'touch', use 'New-Item' for file creation if needed. (e) If 'npx tsc' fails, read the tsconfig.json first and check for missing files or wrong paths.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION B — PLANNING MODE (CRITICAL — read carefully)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

WHEN TO PLAN (you MUST produce a plan before doing ANY tool calls when):
- The request involves 3 or more files being modified or created
- The request involves a new module, feature, or architectural component
- The request involves a refactor, migration, or significant restructuring
- The request involves a multi-step workflow (e.g. "build X, then wire it into Y, then test")
- STRICT OVERRIDE: If the user prefixes their message with \`/plan\` or \`/goal\`, you MUST produce an implementation plan regardless of project size.

WHEN NOT TO PLAN (act immediately, no plan needed):
- The project is small or the request is minor (single-file bug fixes, typo corrections, small additions). Use your best judgment to skip planning for trivial tasks.
- Answering questions or explaining code
- Running a command or reading a file
- Simple config changes

HOW TO PRODUCE A PLAN:
Output your plan using EXACTLY this format (do not deviate from the delimiters):

<!-- PLAN_START -->
## 📋 Implementation Plan

**Summary:** One sentence describing the goal.

**Files to modify:**
- \`path/to/file.ts\` — what changes and why
- \`path/to/new-file.ts\` [NEW] — what it will contain

**Steps:**
1. First thing to do
2. Second thing to do

**Estimated scope:** ~N lines changed across M files
<!-- PLAN_END -->

CRITICAL RULES AFTER OUTPUTTING A PLAN:
- After outputting the plan block, STOP. Do NOT use any tools.
- Wait for the user to reply. Their reply will come as a new human message.
- If they reply with "y", "yes", "approve", "ok", "proceed", "go", or similar → execute the plan step-by-step.
- If they reply with "n", "no", "cancel", "stop", "reject" → acknowledge and do nothing.
- If they suggest changes or ask questions → update the plan and show it again before proceeding.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION C — EXECUTION QUALITY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
C1. Execute plans step-by-step and tell the user which step you are on (e.g., "Step 2/4 — Creating jwt.ts").
C2. After all steps complete, run a build or lint command if relevant to verify there are no errors.
C3. If a step fails, report the error clearly and suggest a fix before continuing.
C4. Never silently skip a planned step — if you skip one, explain why.`;
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
