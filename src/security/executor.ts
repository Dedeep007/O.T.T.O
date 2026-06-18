import { spawn } from 'child_process';
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

    // Simple security validation against shell metacharacters
    if (parsed.some(token => typeof token !== 'string')) {
      ui.error('Shell metacharacters detected. Execution blocked.');
      throw new Error('Metacharacters blocked');
    }

    const isWhitelisted = config.security.allowedCommands.includes(cmd);

    if (config.security.mode === 'ask') {
      const approved = await this.askApproval(commandStr);
      if (!approved) throw new Error('Execution denied by user.');
    } else if (config.security.mode === 'approve') {
      if (!isWhitelisted) {
        const choice = await this.promptUnknownAction(cmd);
        if (choice === 'deny') throw new Error('Execution denied by user.');
        if (choice === 'always') {
          config.security.allowedCommands.push(cmd);
          Configurator.saveConfig(config);
        }
      }
    } else if (config.security.mode === 'full') {
      // Full access bypassing prompts. 
      // Operational frames under full access are forced into Docker containers typically.
      // For this implementation, we simulate it or execute natively.
      ui.warning(`[Full Access Mode] Executing ${cmd} autonomously.`);
    }

    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'], cwd: process.cwd() });
      
      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => stdout += data.toString());
      child.stderr.on('data', (data) => stderr += data.toString());

      child.on('close', (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`Command failed with code ${code}: ${stderr}`));
        }
      });
      
      child.on('error', (err) => {
         reject(err);
      });
    });
  }

  private async askApproval(command: string): Promise<boolean> {
    ui.warning(`The agent wants to execute: ${command}`);
    const answer = await select({
      message: 'Allow execution?',
      choices: [
        { name: 'Allow', value: true },
        { name: 'Deny', value: false }
      ]
    });
    return answer;
  }

  private async promptUnknownAction(cmd: string): Promise<'now' | 'always' | 'deny'> {
    ui.warning(`Unwhitelisted command intercepted: ${cmd}`);
    return await select({
      message: 'Choose an action:',
      choices: [
        { name: 'Allow for now', value: 'now' },
        { name: 'Allow always (whitelist)', value: 'always' },
        { name: 'Deny', value: 'deny' }
      ]
    }) as 'now' | 'always' | 'deny';
  }
}

export const executor = new Executor();
