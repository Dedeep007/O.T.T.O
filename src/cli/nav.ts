import * as readline from 'readline';
import { ui } from './ui.js';
import chalk from 'chalk';
import { memoryManager } from '../memory/budget.js';
import { OttoConfig } from './configurator.js';
import { chatSession } from './session.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json');
const CLI_VERSION = pkg.version;

export interface PhoneMenuOption {
  label: string;
  description?: string;
  action: () => Promise<void> | void;
}

export interface PhoneView {
  id: string;
  title: string;
  subtitle?: string;
  renderBody?: () => void;
  options: PhoneMenuOption[];
  onBack?: () => void;
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function strip(s: string) { return s.replace(/\x1B\[[0-9;]*m/g, ''); }
function vlen(s: string)  { return strip(s).length; }


export class PhoneOS {
  public history: PhoneView[]    = [];
  private forward:  PhoneView[]   = [];
  private cursor:   number        = 0;
  public active:    boolean       = false;
  private config:   OttoConfig;
  private firstRender: boolean    = true;
  private lastRenderLines: number = 0;
  private listening: boolean      = false;
  private ctrlKHandler?: () => void;

  constructor(c: OttoConfig) {
    this.config = c;
    process.stdout.on('resize', () => {
      if (this.active) {
        this.firstRender = true;
        this.render();
      }
    });
  }
  updateConfig(c: OttoConfig) { this.config = c; }

  registerCtrlKHandler(handler: () => void) {
    this.ctrlKHandler = handler;
  }

  private onKey = async (_: string, key: any) => {
    try {
      const fs = await import('fs');
      fs.appendFileSync('C:\\Users\\dedeep vasireddy\\keypresses.log', `onKey: active=${this.active} key=${JSON.stringify(key)}\n`);
    } catch {}
    if (!this.active) return;
    if (key.ctrl && key.name === 'c') { this.cleanup(); process.exit(0); }
    if (key.ctrl && key.name === 'k') {
      if (this.ctrlKHandler) {
        this.ctrlKHandler();
      }
      return;
    }
    const view = this.history[this.history.length - 1];

    if      (key.name === 'up')    { this.cursor = this.cursor > 0 ? this.cursor - 1 : view.options.length - 1; this.render(); }
    else if (key.name === 'down')  { this.cursor = this.cursor < view.options.length - 1 ? this.cursor + 1 : 0; this.render(); }
    else if (key.name === 'left' || key.name === 'escape' || key.name === 'backspace')  { this.goBack(); }
    else if (key.name === 'right') { if (this.forward.length) { this.history.push(this.forward.pop()!); this.cursor = 0; this.render(); } else { this.select(); } }
    else if (key.name === 'return' || key.name === 'enter'){ this.select(); }
  };

  public goBack() {
    if (this.history.length > 1) {
      this.forward.push(this.history.pop()!);
      this.cursor = 0;
      const prev = this.history[this.history.length - 1];
      if (prev.onBack) prev.onBack();
      this.render();
    }
  }

  private async select() {
    const view = this.history[this.history.length - 1];
    if (!view.options.length) return;
    const opt = view.options[this.cursor];
    this.cleanup();
    await opt.action();
    this.forward = [];
    if (!this.listening) { this.startListening(); this.render(); }
  }

  pushView(view: PhoneView) {
    this.history.push(view);
    this.cursor = 0;
    this.firstRender = true; // Full clear on view change
    if (this.active) this.render();
  }

  startListening() {
    if (this.listening) {
      this.active = true;
      return;
    }
    this.active = true;
    this.listening = true;
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('keypress', this.onKey);
  }

  cleanup() {
    this.active = false;
    this.listening = false;
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.removeListener('keypress', this.onKey);
  }

  // ─── Render ──────────────────────────────────────────────────────
  render() {
    let out = '';
    const writeOrig = process.stdout.write;
    const logOrig = console.log;
    
    // Intercept all output to buffer it
    const captureWrite = (chunk: any) => { out += chunk; return true; };
    const captureLog = (...args: any[]) => { out += args.join(' ') + '\n'; };
    
    (process.stdout as any).write = captureWrite;
    console.log = captureLog;
    
    try {
      this._renderInternal();
    } finally {
      process.stdout.write = writeOrig;
      console.log = logOrig;
    }

    const lines = out.split('\n');
    let frameStr = '';
    
    // Wipe the entire screen and scrollback buffer on every render
    // to guarantee no duplicates are left behind in the history.
    frameStr = '\x1B[2J\x1B[3J\x1B[H' + out;
    
    process.stdout.write(frameStr);
  }

  private _renderInternal() {
    const view   = this.history[this.history.length - 1];
    const stats  = memoryManager.getBudgetStatsForMessages(chatSession.getMessages());
    const ratio  = stats.max > 0 ? Math.min(stats.filled / stats.max, 1) : 0;
    const pct    = Math.round(ratio * 100);
    const prov   = this.config.defaults.primaryProvider;
    const providerConfig = (this.config.providers as any)[prov];
    const hasKey = !!(providerConfig?.activeApiKey || providerConfig?.apiKey || providerConfig?.apiKeys?.length);
    const mem    = process.memoryUsage();
    const ramMB  = Math.round(mem.rss / 1024 / 1024);
    const W = process.stdout.columns ? Math.max(Math.min(process.stdout.columns - 8, 150), 60) : 95;

    // Palette
    const GOLD  = chalk.hex('#F5C400');
    const CYAN  = chalk.hex('#56CFE1');
    const GREEN = chalk.hex('#57CC99');
    const RED   = chalk.hex('#EF233C');
    const PURP  = chalk.hex('#9D4EDD');
    const MUTED = chalk.hex('#6B7280');
    const DIM   = chalk.hex('#374151');
    const WHITE = chalk.white;
    const BOLD  = chalk.bold;
    
    // Background color for active menu item (Tailwind Gray-700 mapped)
    const BG_HL = chalk.bgHex('#374151'); 

    // ── Header Box ────────────────────────────────────────────────
    const hLine = GOLD('═'.repeat(W));
    process.stdout.write(GOLD(' ╔') + hLine + GOLD('╗\n'));

    // Left Section

    // Right Section Components
    const isOllama = prov === 'ollama';
    const isLocal = isOllama && !!providerConfig?.baseUrl;
    const dot = (hasKey || isLocal) ? GREEN('●') : RED('●');
    const provPill = dot + ' ' + CYAN.bold(prov.toUpperCase());
    const provLen = 2 + prov.length;

    let barChalk = GREEN;
    if (ratio > 0.55) barChalk = chalk.hex('#F4A261');
    if (ratio > 0.85) barChalk = RED;
    
    const BAR = 6; // Compact bar for header
    const fill = Math.round(ratio * BAR);
    const ctxBar = barChalk('▰'.repeat(fill)) + DIM('▱'.repeat(BAR - fill));
    const pctStr = `${pct}%`;
    const ctxUsageStr = `${stats.filled}/${stats.max}`;
    const ctxPill = MUTED('ctx ') + ctxBar + ' ' + MUTED(ctxUsageStr) + ' ' + MUTED(pctStr);
    const ctxLen = 4 + BAR + 1 + ctxUsageStr.length + 1 + pctStr.length;

    const ramStr = `${ramMB}mb`;
    const ramPill = MUTED('ram ') + WHITE(ramStr);
    const ramLen = 4 + ramStr.length;

    const secStr = this.config.security.mode;
    const secPill = MUTED('Security: ') + PURP(secStr);
    const secLen = 10 + secStr.length;

    const rightParts = [provPill];
    const rightLens = [provLen];
    if (this.config.defaults.showContextBar !== false) {
      rightParts.push(ctxPill);
      rightLens.push(ctxLen);
    }
    rightParts.push(ramPill, secPill);
    rightLens.push(ramLen, secLen);

    const rightStr = rightParts.join('  ') + '  ';
    const rightTotLen = rightLens.reduce((a, b) => a + b, 0) + (Math.max(0, rightParts.length - 1) * 2) + 2;

    const titleFull = `Orchestrated Task & Tool Operator v${CLI_VERSION}`;
    const titleShort = `O.T.T.O v${CLI_VERSION}`;
    
    let leftStr = '  ' + GOLD.bold(titleFull) + '   ';
    let leftLen = 2 + titleFull.length + 3;

    if (W < leftLen + rightTotLen) {
      leftStr = '  ' + GOLD.bold(titleShort) + '   ';
      leftLen = 2 + titleShort.length + 3;
    }

    const midSpace = Math.max(0, W - leftLen - rightTotLen);
    const content = leftStr + ' '.repeat(midSpace) + rightStr;
    const spaces = Math.max(0, W - vlen(content));
    process.stdout.write(GOLD(' ║') + content + ' '.repeat(spaces) + GOLD('║\n'));
    process.stdout.write(GOLD(' ╚') + hLine + GOLD('╝\n'));

    // ── Breadcrumbs ───────────────────────────────────────────────
    if (this.history.length > 1) {
      const crumbs = this.history.map((v, i) =>
        i === this.history.length - 1
          ? WHITE.bold(v.title)
          : MUTED(v.title)
      ).join(MUTED(' › '));
      console.log('  ' + crumbs);
    }

    // ── Section Body / Dashboard Stats ────────────────────────────
    let hasBody = false;
    
    if (chatSession.pendingApprovals && chatSession.pendingApprovals.length > 0) {
      console.log('  ' + RED.bold(`[!] Pending Approvals: ${chatSession.pendingApprovals.length} command(s) waiting for your permission!`));
      for (const p of chatSession.pendingApprovals) {
        console.log('      ' + CYAN(p.cmd) + MUTED(` (Thread: ${p.threadId})`));
      }
      console.log('');
      hasBody = true;
    }

    if (view.subtitle) {
      console.log('  ' + BOLD(WHITE(view.subtitle)));
      hasBody = true;
    }

    if (view.renderBody) {
      const lines: string[] = [];
      const orig = console.log;
      // Capture and pad body outputs
      console.log = (...a: any[]) => a.join(' ').split('\n').forEach(l => lines.push(l));
      try { view.renderBody(); } finally { console.log = orig; }
      for (const l of lines) process.stdout.write(l + '\n');
      hasBody = true;
    }

    // ── Menu Box ──────────────────────────────────────────────────
    const hBoxLine = GOLD('═'.repeat(W));
    process.stdout.write(GOLD(' ╔') + hBoxLine + GOLD('╗\n'));

    const LABEL_COL_WIDTH = 28;
    const MAX_OPTIONS = 10;
    
    let startIdx = 0;
    let endIdx = view.options.length;
    
    if (view.options.length > MAX_OPTIONS) {
      startIdx = Math.max(0, this.cursor - Math.floor(MAX_OPTIONS / 2));
      endIdx = startIdx + MAX_OPTIONS;
      if (endIdx > view.options.length) {
        endIdx = view.options.length;
        startIdx = Math.max(0, endIdx - MAX_OPTIONS);
      }
    }

    const printIndicator = (char: string) => {
      const padLeft = Math.floor((W - 1) / 2);
      const padRight = Math.max(0, W - 1 - padLeft);
      process.stdout.write(GOLD(' ║') + ' '.repeat(padLeft) + MUTED(char) + ' '.repeat(padRight) + GOLD('║\n'));
    };

    if (startIdx > 0) printIndicator('▲');

    const visibleOptions = view.options.slice(startIdx, endIdx);
    visibleOptions.forEach((opt, idx) => {
      const realIdx = startIdx + idx;
      const isSel = realIdx === this.cursor;
      const plainLabel = strip(opt.label);

      // 1. Setup Menu Prefix and Label
      const prefix = isSel 
        ? '  ' + GOLD('█') + '  ' + GOLD.bold(plainLabel) 
        : '     ' + MUTED(plainLabel);
      
      const rawLen = 5 + plainLabel.length;
      const space1 = Math.max(0, LABEL_COL_WIDTH - rawLen);

      // 2. Setup Description Block
      const descStrPlain = opt.description ? opt.description.slice(0, Math.max(0, W - LABEL_COL_WIDTH - 2)) : '';
      const descLen = descStrPlain.length;
      
      const descStr = opt.description 
        ? (isSel ? MUTED(descStrPlain) : DIM(descStrPlain)) 
        : '';
        
      const space2 = Math.max(0, W - rawLen - space1 - descLen);

      // 3. Assemble Full Padded Row String
      const rowAnsi = prefix + ' '.repeat(space1) + descStr + ' '.repeat(space2);
      
      // 4. Highlight if Active
      const coloredRow = isSel ? BG_HL(rowAnsi) : rowAnsi;

      process.stdout.write(GOLD(' ║') + coloredRow + GOLD('║\n'));
    });

    if (endIdx < view.options.length) printIndicator('▼');

    process.stdout.write(GOLD(' ╚') + hBoxLine + GOLD('╝\n'));

    // Print warning notification below the Menu Box if approvals are pending
    if (chatSession.pendingApprovals && chatSession.pendingApprovals.length > 0) {
      const uniqueThreads = Array.from(new Set(chatSession.pendingApprovals.map(p => p.threadId)));
      const threadList = uniqueThreads.map(id => chalk.hex('#22D3EE').bold(id)).join(', ');
      process.stdout.write('\n');
      process.stdout.write('  ' + chalk.hex('#EF4444').bold('⚠️  PENDING APPROVAL: ') + chalk.white(`Agent needs command approval in thread(s): ${threadList}`) + '\n');
      process.stdout.write('     Please choose "Enter Chat" or select the corresponding thread to approve.\n');
    }
  }
}
