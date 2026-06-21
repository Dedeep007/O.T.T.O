import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { browserAutomation } from '../../hardware/browser.js';

export const readBrowserAccessibility = tool(
  async ({ url }: { url: string }) => {
    try {
      const paths = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser'
      ];
      let chromePath = '';
      for (const p of paths) {
        if (p && fs.existsSync(p)) {
          chromePath = p;
          break;
        }
      }
      if (!chromePath) {
        throw new Error('Google Chrome / Chromium could not be located in standard paths. Please ensure Chrome is installed.');
      }
      await browserAutomation.connect(chromePath);
      const tree = await browserAutomation.getAccessibilityTree(url);
      await browserAutomation.close();
      return JSON.stringify(tree, null, 2);
    } catch (e: any) {
      return `Error scraping browser tree: ${e.message}`;
    }
  },
  {
    name: "read_browser_accessibility",
    description: "Launches Chrome to navigate to a URL and extracts the semantic Accessibility Tree. Use this to read web pages visually.",
    schema: z.object({
      url: z.string().describe("The full URL to navigate to (e.g. 'https://example.com')."),
    }),
  }
);
