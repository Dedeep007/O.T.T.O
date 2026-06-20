import { osController } from '../src/hardware/os.js';
import { browserAutomation } from '../src/hardware/browser.js';
import { Configurator } from '../src/cli/configurator.js';
import { chatSession } from '../src/cli/session.js';
import fs from 'fs';
import path from 'path';

async function testOSWhitelisting() {
  console.log('Testing OS Controller whitelisting...');
  
  // Clean notepad from allowedApps first
  const config = await Configurator.init();
  config.security.allowedApps = config.security.allowedApps.filter(x => x !== 'notepad');
  config.security.mode = 'ask';
  await Configurator.saveConfig(config);

  // Mock chat session to be active
  chatSession.isChatActive = true;
  // Mock the promptAction callback to simulate user choosing 'always' (whitelist)
  (osController as any).promptAction = async (app: string) => {
    console.log(`[TEST MOCK] Simulating user choice 'always' for: ${app}`);
    return 'always';
  };

  try {
    await osController.launchApp('notepad');
    console.log('OS Launch check: Success!');
    
    // Verify that notepad is now in the whitelisted allowedApps
    const updatedConfig = await Configurator.init();
    const whitelisted = updatedConfig.security.allowedApps.includes('notepad');
    console.log('Verification: Is notepad whitelisted now?', whitelisted);
    
    // Reset whitelisted apps
    updatedConfig.security.allowedApps = updatedConfig.security.allowedApps.filter(x => x !== 'notepad');
    await Configurator.saveConfig(updatedConfig);
  } catch (e: any) {
    console.error('OS Launch check failed:', e.message);
  }
}

async function testBrowser() {
  console.log('\nTesting Browser Automation...');
  const paths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')
  ];

  let chromePath = '';
  for (const p of paths) {
    if (fs.existsSync(p)) {
      chromePath = p;
      break;
    }
  }

  if (!chromePath) {
    console.error('Could not find Google Chrome installation in common paths.');
    return;
  }

  console.log(`Using Chrome path: ${chromePath}`);
  try {
    await browserAutomation.connect(chromePath);
    console.log('Connected to browser successfully.');
    const tree = await browserAutomation.getAccessibilityTree('https://example.com');
    console.log('Accessibility Tree Nodes scraped:', tree.length);
    console.log('First 5 nodes:', tree.slice(0, 5));
    await browserAutomation.close();
    console.log('Browser check: Success!');
  } catch (e: any) {
    console.error('Browser check failed:', e.message);
  }
}

async function run() {
  await testOSWhitelisting();
  await testBrowser();
}

run().catch(console.error);
