import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { osController } from '../../hardware/os.js';

export const launchOsApp = tool(
  async ({ appNameOrPath }: { appNameOrPath: string }) => {
    try {
      await osController.launchApp(appNameOrPath);
      return `Successfully launched ${appNameOrPath}`;
    } catch (e: any) {
      return `Error launching app: ${e.message}`;
    }
  },
  {
    name: "launch_os_app",
    description: "Launches an application or executable using the native OS process launcher. It must be in the allowedApps whitelist if not in full security mode.",
    schema: z.object({
      appNameOrPath: z.string().describe("The name or path of the app to launch (e.g. 'notepad', 'chrome', 'calc')."),
    }),
  }
);
