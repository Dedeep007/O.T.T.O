import { exec, spawn } from 'child_process';
import { parse } from 'shell-quote';
import { Configurator } from '../cli/configurator.js';
import { ui } from '../cli/ui.js';
import { select } from '@inquirer/prompts';
import { backgroundManager } from './background.js';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { chatSession, sessionEvents } from '../cli/session.js';
import { getExecutingThreadId } from '../cli/threadContext.js';

export class Executor {
  private lastCommands = new Map<string, { cmdStr: string; attempts: number }>();

  async executeCommand(commandStr: string, background: boolean = false): Promise<string> {
    let cleanCmd = commandStr.trim();
    
    // Check if we should auto-background
    const isBgPattern = /&$/i.test(cleanCmd) || 
                        /^(npm\s+(run\s+)?(dev|start|watch)|node\s+server|python\s+-m\s+http\.server)/i.test(cleanCmd) ||
                        /\b(--background|-background|--bg)\b/i.test(cleanCmd);
    if (isBgPattern && !background) {
      background = true;
      ui.info(`Auto-backgrounding command: "${commandStr}"`);
    }

    // Clean comments, background flags, and trailing ampersands
    cleanCmd = cleanCmd.replace(/(?:\s+#|\s+\/\/).*$/, '').trim();
    cleanCmd = cleanCmd.replace(/\b(--background|-background|--bg)\b/gi, '').trim();
    if (process.platform === 'win32') {
      cleanCmd = cleanCmd.replace(/&+\s*$/, '').trim();
    }
    commandStr = cleanCmd;

    const executingThreadId = getExecutingThreadId() || chatSession.threadId || 'default';
    const cmdRecord = this.lastCommands.get(executingThreadId);
    if (cmdRecord && cmdRecord.cmdStr === commandStr && cmdRecord.attempts >= 3) {
      throw new Error(`Command "${commandStr}" has failed consecutively 3 times. O.T.T.O has blocked further retries to prevent an infinite loop. Please analyze the previous errors/logs and try a different command, arguments, or correct the code issues manually first.`);
    }

    const config = await Configurator.init();
    
    // Tokenized Whitelist Engine
    const parsed = parse(commandStr);
    const cmd = String(parsed[0]);
    const args = parsed.slice(1).map(String);

    const isWhitelisted = config.security.allowedCommands.includes(cmd);

    if (config.security.mode === 'ask' || (config.security.mode === 'approve' && !isWhitelisted)) {
      const choice = await this.promptAction(cmd, commandStr, executingThreadId);
      if (choice === 'deny') throw new Error('Execution denied by user.');
      
      if (choice === 'always') {
        if (!isWhitelisted) {
          config.security.allowedCommands.push(cmd);
        }
        if (config.security.mode === 'ask') {
          config.security.mode = 'approve';
          ui.info("Security mode updated to 'Approve' (whitelisted commands run silently).");
        }
        Configurator.saveConfig(config);
      }
    } else if (config.security.mode === 'full') {
      ui.warning(`[Full Access Mode] Executing ${cmd} autonomously.`);
    }

    const runCore = async (): Promise<string> => {
      if (background) {
        const logDir = path.join(os.tmpdir(), 'otto-cli-logs');
        if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
        const logPath = path.join(logDir, `bg-${Date.now()}.log`);
        const out = fs.openSync(logPath, 'a');
        const err = fs.openSync(logPath, 'a');

        const child = spawn(commandStr, {
          cwd: process.cwd(),
          shell: true,
          stdio: ['ignore', out, err],
          detached: process.platform !== 'win32'
        });
        
        fs.closeSync(out);
        fs.closeSync(err);
        
        backgroundManager.addProcess(commandStr, child, executingThreadId);

        let spawnError: Error | null = null;
        const onError = (err: Error) => {
          spawnError = err;
        };
        child.on('error', onError);

        // Wait 1.5 seconds to see if the process is still running or if it crashed on startup
        await new Promise(resolve => setTimeout(resolve, 1500));

        child.off('error', onError);

        if (spawnError) {
          throw spawnError;
        }

        if (child.exitCode !== null && child.exitCode !== undefined) {
          let logs = '';
          if (fs.existsSync(logPath)) {
            logs = fs.readFileSync(logPath, 'utf8').trim();
          }
          throw new Error(`Background process terminated immediately with exit code ${child.exitCode}.\nLogs:\n${logs.slice(-2000)}`);
        }

        child.unref(); // allow the main process to exit even if this is running
        
        let initialLogs = '';
        if (fs.existsSync(logPath)) {
          initialLogs = fs.readFileSync(logPath, 'utf8').trim();
        }
        
        const logMsg = initialLogs 
          ? `\nInitial Output Logs:\n\`\`\`text\n${initialLogs.slice(0, 1000)}\n\`\`\``
          : '\nNo initial output logs yet.';

        return `Background process started successfully with PID: ${child.pid}.\nOutput is being logged to: ${logPath}${logMsg}\nUse the read_file tool to check this log file if you need more details.`;
      }

      return new Promise<string>((resolve, reject) => {
        // Add a 45-second execution timeout to prevent hanging commands
        exec(commandStr, { cwd: process.cwd(), timeout: 45000 }, (error, stdout, stderr) => {
          if (error) {
            const out = stdout.toString().trim();
            const err = stderr.toString().trim();
            let msg = '';
            if ((error as any).killed) {
              msg = `Command timed out and was killed after 45 seconds of inactivity. If this is a long-running process, run it with background: true.`;
            } else {
              msg = `Command failed with exit code ${error.code || 'unknown'}:`;
            }
            if (err) msg += `\nSTDERR:\n${err}`;
            if (out) msg += `\nSTDOUT:\n${out}`;
            if (!err && !out && !(error as any).killed) msg += ` ${error.message}`;
            reject(new Error(msg));
          } else {
            resolve(stdout.toString() || stderr.toString() || 'Command executed successfully.');
          }
        });
      });
    };

    try {
      const result = await runCore();
      this.lastCommands.set(executingThreadId, { cmdStr: commandStr, attempts: 0 });
      return result;
    } catch (err: any) {
      const currentAttempts = (cmdRecord && cmdRecord.cmdStr === commandStr) ? cmdRecord.attempts + 1 : 1;
      this.lastCommands.set(executingThreadId, { cmdStr: commandStr, attempts: currentAttempts });
      throw err;
    }
  }

  private async promptAction(cmd: string, fullCommand: string, executingThreadId: string): Promise<'now' | 'always' | 'deny'> {
    // Only prompt inline if the chat is active and the executing thread is the one currently viewed
    if (!chatSession.isChatActive || executingThreadId !== chatSession.threadId) {
      return new Promise((resolve) => {
        chatSession.pendingApprovals.push({
          threadId: executingThreadId,
          cmd,
          commandStr: fullCommand,
          resolve
        });
        sessionEvents.emit('pending_approval');
      });
    }
    try {
      sessionEvents.emit('prompt_start');
      ui.warning(`The agent wants to execute: ${fullCommand}`);
      const choice = await select({
        message: 'Choose an action:',
        choices: [
          { name: 'Approve for now', value: 'now' },
          { name: `Approve always (whitelist '${cmd}')`, value: 'always' },
          { name: `Don't approve`, value: 'deny' }
        ]
      }) as 'now' | 'always' | 'deny';
      return choice;
    } finally {
      sessionEvents.emit('prompt_end');
    }
  }

  clearAttempts() {
    this.lastCommands.clear();
  }
}

export const executor = new Executor();
