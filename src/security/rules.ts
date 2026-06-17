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

Runtime coding UI rules:
1. Before editing existing code, use search_code to find the relevant function/class/text, then use read_file_lines to inspect only the needed numbered range.
2. For small edits, use replace_file_lines with the exact line range. For new files or full rewrites, use write_file.
3. Do not use terminal redirection, echo, heredocs, Set-Content, Out-File, or shell metacharacters to write code.
4. Use read_file only when a whole file is genuinely needed; prefer read_file_lines for performance and context hygiene.
5. Use list_files when inspecting folder structure.
6. Use execute_terminal_command only for commands like compiling, running tests, listing files, or reading command output, and stay inside the current workspace directory.
7. Keep chat responses concise. Do not paste full source files into chat after writing them; let the diff UI show file changes.
8. After editing files, summarize what changed in one or two short sentences.`;
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
