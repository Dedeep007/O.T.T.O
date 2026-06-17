import open from 'open';
import { Configurator } from '../cli/configurator.js';
import { ui } from '../cli/ui.js';

export class OSController {
  public async launchApp(appNameOrPath: string): Promise<void> {
    const config = await Configurator.init();
    
    // Cross-Platform App Control governed by allowedApps
    if (!config.security.allowedApps.includes(appNameOrPath) && config.security.mode !== 'full') {
      ui.error(`App ${appNameOrPath} is not in the allowedApps whitelist. Execution blocked.`);
      throw new Error(`Unwhitelisted app: ${appNameOrPath}`);
    }

    try {
      await open(appNameOrPath);
      ui.success(`Launched ${appNameOrPath}`);
    } catch (e: any) {
      ui.error(`Failed to launch app: ${e.message}`);
      throw e;
    }
  }
}

export const osController = new OSController();
