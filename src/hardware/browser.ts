import puppeteer, { Browser, Page } from 'puppeteer-core';
import { ui } from '../cli/ui.js';

export class BrowserAutomation {
  private browser: Browser | null = null;
  private page: Page | null = null;

  public async connect(executablePath: string): Promise<void> {
    try {
      this.browser = await puppeteer.launch({
        executablePath,
        headless: true,
        args: ['--remote-debugging-port=9222']
      });
      this.page = await this.browser.newPage();
      ui.success('Connected to headless Chromium via CDP.');
    } catch (e: any) {
      ui.error(`Failed to connect browser: ${e.message}`);
      throw e;
    }
  }

  public async getAccessibilityTree(url: string): Promise<any> {
    if (!this.page) throw new Error('Browser not connected');
    
    await this.page.goto(url, { waitUntil: 'networkidle2' });
    
    // Use CDP to extract accessibility tree
    const client = await this.page.target().createCDPSession();
    const { nodes } = await client.send('Accessibility.getFullAXTree');
    
    // Clean and token-optimize tree by stripping visual DOM clutter
    const cleanNodes = nodes.filter(n => n.name && n.name.value).map(n => ({
      role: n.role?.value,
      name: n.name?.value
    }));

    return cleanNodes;
  }

  public async close() {
    if (this.browser) await this.browser.close();
  }
}

export const browserAutomation = new BrowserAutomation();
