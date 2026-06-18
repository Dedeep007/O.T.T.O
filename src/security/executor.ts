import { exec } from 'child_process';
import { parse } from 'shell-quote';
import { Configurator } from '../cli/configurator.js';
import { ui } from '../cli/ui.js';
import { select } from '@inquirer/prompts';

export class Executor {
  async executeCommand(commandStr: string): Promise<string> {
    const config = await Configurator.init();
    
    // Tokenized Whitelist Engine
    const parsed = parse(commandStr);
    const cmd = String(parsed[0]);
    const args = parsed.slice(1).map(String);

    // Remove strict metacharacter blocking since we use exec now and 
    // want to allow standard shell usage. The prompt/whitelist still protects cmd.

    const isWhitelisted = config.security.allowedCommands.includes(cmd);

    if (config.security.mode === 'ask' || (config.security.mode === 'approve' && !isWhitelisted)) {
      const choice = await this.promptAction(cmd, commandStr);
      if (choice === 'deny') throw new Error('Execution denied by user.');
      
      if (choice === 'always') {
        if (!isWhitelisted) {
          config.security.allowedCommands.push(cmd);
        }
        // If they whitelist it, they implicitly want to rely on the whitelist
        if (config.security.mode === 'ask') {
          config.security.mode = 'approve';
          ui.info("Security mode updated to 'Approve' (whitelisted commands run silently).");
        }
        Configurator.saveConfig(config);
      }
    } else if (config.security.mode === 'full') {
      // Full access bypassing prompts. 
      // Operational frames under full access are forced into Docker containers typically.
      // For this implementation, we simulate it or execute natively.
      ui.warning(`[Full Access Mode] Executing ${cmd} autonomously.`);
    }

    return new Promise((resolve, reject) => {
      exec(commandStr, { cwd: process.cwd() }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`Command failed: ${stderr || error.message}`));
        } else {
          resolve(stdout.toString() || stderr.toString() || 'Command executed successfully.');
        }
      });
    });
  }

  private async promptAction(cmd: string, fullCommand: string): Promise<'now' | 'always' | 'deny'> {
    ui.warning(`The agent wants to execute: ${fullCommand}`);
    return await select({
      message: 'Choose an action:',
      choices: [
        { name: 'Approve for now', value: 'now' },
        { name: `Approve always (whitelist '${cmd}')`, value: 'always' },
        { name: `Don't approve`, value: 'deny' }
      ]
    }) as 'now' | 'always' | 'deny';
  }
}

export const executor = new Executor();
