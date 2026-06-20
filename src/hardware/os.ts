import open from 'open';
import { Configurator } from '../cli/configurator.js';
import { ui } from '../cli/ui.js';
import { select } from '@inquirer/prompts';
import { chatSession, sessionEvents } from '../cli/session.js';

export class OSController {
  public async launchApp(appNameOrPath: string): Promise<void> {
    const config = await Configurator.init();
    const isWhitelisted = config.security.allowedApps.includes(appNameOrPath);

    if (config.security.mode === 'ask' || (config.security.mode === 'approve' && !isWhitelisted)) {
      const choice = await this.promptAction(appNameOrPath);
      if (choice === 'deny') {
        throw new Error(`App launch denied by user: ${appNameOrPath}`);
      }
      
      if (choice === 'always') {
        if (!isWhitelisted) {
          config.security.allowedApps.push(appNameOrPath);
        }
        if (config.security.mode === 'ask') {
          config.security.mode = 'approve';
        }
        Configurator.saveConfig(config);
      }
    } else if (config.security.mode === 'full') {
      ui.warning(`[Full Access Mode] Launching ${appNameOrPath} autonomously.`);
    }

    try {
      await open(appNameOrPath);
      ui.success(`Launched ${appNameOrPath}`);
    } catch (e: any) {
      ui.error(`Failed to launch app: ${e.message}`);
      throw e;
    }
  }

  private async promptAction(appNameOrPath: string): Promise<'now' | 'always' | 'deny'> {
    if (!chatSession.isChatActive) {
      return 'deny';
    }
    const executingThreadId = chatSession.threadId || 'default';
    return new Promise((resolve) => {
      chatSession.pendingApprovals.push({
        threadId: executingThreadId,
        type: 'app',
        cmd: appNameOrPath,
        commandStr: appNameOrPath,
        resolve
      });
      sessionEvents.emit('pending_approval');
    });
  }
}

export const osController = new OSController();
