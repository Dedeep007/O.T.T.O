import React, { useState, useEffect } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
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
  onResize?: () => void;
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function strip(s: string) { return s.replace(/\x1B\[[0-9;]*m/g, ''); }
function vlen(s: string)  { return strip(s).length; }

export class PhoneOS {
  public history: PhoneView[]    = [];
  public forward:  PhoneView[]   = [];
  public cursor:   number        = 0;
  public active:    boolean       = false;
  public config:   OttoConfig;
  public listening: boolean      = false;
  public notification: string = '';
  private notificationTimeout?: NodeJS.Timeout;
  private ctrlKHandler?: () => void;
  private listeners: (() => void)[] = [];

  constructor(c: OttoConfig) {
    this.config = c;
  }

  showNotification(msg: string) {
    this.notification = msg;
    if (this.notificationTimeout) {
      clearTimeout(this.notificationTimeout);
    }
    this.notify();
    this.notificationTimeout = setTimeout(() => {
      this.notification = '';
      this.notify();
    }, 2000);
  }

  subscribe(listener: () => void) {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  notify() {
    this.listeners.forEach(l => l());
  }

  updateConfig(c: OttoConfig) { 
    this.config = c; 
    this.notify();
  }

  registerCtrlKHandler(handler: () => void) {
    this.ctrlKHandler = handler;
  }

  public getCtrlKHandler() {
    return this.ctrlKHandler;
  }

  public goBack() {
    if (this.history.length > 1) {
      this.forward.push(this.history.pop()!);
      this.cursor = 0;
      const prev = this.history[this.history.length - 1];
      if (prev.onBack) prev.onBack();
      this.notify();
    }
  }

  public async select() {
    const view = this.history[this.history.length - 1];
    if (!view || !view.options.length) return;
    const opt = view.options[this.cursor];
    
    this.active = false;
    this.listening = false;
    this.notify();

    await opt.action();
    this.forward = [];
    
    this.active = true;
    this.listening = true;
    this.notify();
  }

  pushView(view: PhoneView) {
    this.history.push(view);
    this.cursor = 0;
    this.notify();
  }

  startListening() {
    this.active = true;
    this.listening = true;
    this.notify();
  }

  cleanup() {
    this.active = false;
    this.listening = false;
    this.notify();
  }

  render() {
    this.notify();
  }

  drawToString(): string {
    const view = this.history[this.history.length - 1];
    if (!view) return '';

    let out = '';
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
    
    const BG_HL = chalk.bgHex('#374151'); 

    // ── Header Box ────────────────────────────────────────────────
    const hLine = GOLD('═'.repeat(W));
    out += GOLD(' ╔') + hLine + GOLD('╗\n');

    const isOllama = prov === 'ollama';
    const isLocal = isOllama && !!providerConfig?.baseUrl;
    const dot = (hasKey || isLocal) ? GREEN('●') : RED('●');
    const provPill = dot + ' ' + CYAN.bold(prov.toUpperCase());
    const provLen = 2 + prov.length;

    let barChalk = GREEN;
    if (ratio > 0.55) barChalk = chalk.hex('#F4A261');
    if (ratio > 0.85) barChalk = RED;
    
    const BAR = 6;
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
    out += GOLD(' ║') + content + ' '.repeat(spaces) + GOLD('║\n');
    out += GOLD(' ╚') + hLine + GOLD('╝\n');

    // ── Breadcrumbs ───────────────────────────────────────────────
    if (this.history.length > 1) {
      const crumbs = this.history.map((v, i) =>
        i === this.history.length - 1
          ? WHITE.bold(v.title)
          : MUTED(v.title)
      ).join(MUTED(' › '));
      out += '  ' + crumbs + '\n';
    }

    if (this.notification) {
      out += '  ' + chalk.bgHex('#1F2937').hex('#10B981').bold(`  ✓ ${this.notification}  `) + '\n';
    }

    // ── Section Body / Dashboard Stats ────────────────────────────
    let hasBody = false;
    
    if (chatSession.pendingApprovals && chatSession.pendingApprovals.length > 0) {
      out += '  ' + RED.bold(`[!] Pending Approvals: ${chatSession.pendingApprovals.length} command(s) waiting for your permission!`) + '\n';
      for (const p of chatSession.pendingApprovals) {
        out += '      ' + CYAN(p.cmd) + MUTED(` (Thread: ${p.threadId})`) + '\n';
      }
      out += '\n';
      hasBody = true;
    }

    if (view.subtitle) {
      out += '  ' + BOLD(WHITE(view.subtitle)) + '\n';
      hasBody = true;
    }

    let bodyLineCount = 0;
    if (view.renderBody) {
      const bodyLines: string[] = [];
      const orig = console.log;
      console.log = (...a: any[]) => a.join(' ').split('\n').forEach(l => bodyLines.push(l));
      try { view.renderBody(); } finally { console.log = orig; }
      bodyLineCount = bodyLines.length;
      for (const l of bodyLines) out += l + '\n';
      hasBody = true;
    }

    // ── Menu Box ──────────────────────────────────────────────────
    const hBoxLine = GOLD('═'.repeat(W));
    out += GOLD(' ╔') + hBoxLine + GOLD('╗\n');

    const LABEL_COL_WIDTH = 28;
    
    // Dynamic menu rows calculation to fit the terminal window
    const rows = process.stdout.rows || 24;
    const nonMenuHeight = 3 + 
      (this.history.length > 1 ? 2 : 0) +
      ((chatSession.pendingApprovals && chatSession.pendingApprovals.length > 0) ? (6 + chatSession.pendingApprovals.length * 2) : 0) +
      (view.subtitle ? 1 : 0) +
      bodyLineCount +
      2;
    const maxMenuOptions = Math.max(3, rows - nonMenuHeight - 3);
    const MAX_OPTIONS = Math.min(10, maxMenuOptions);
    
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
      out += GOLD(' ║') + ' '.repeat(padLeft) + MUTED(char) + ' '.repeat(padRight) + GOLD('║\n');
    };

    if (startIdx > 0) printIndicator('▲');

    const visibleOptions = view.options.slice(startIdx, endIdx);
    visibleOptions.forEach((opt, idx) => {
      const realIdx = startIdx + idx;
      const isSel = realIdx === this.cursor;
      const plainLabel = strip(opt.label);

      const prefix = isSel 
        ? '  ' + GOLD('█') + '  ' + GOLD.bold(plainLabel) 
        : '     ' + MUTED(plainLabel);
      
      const rawLen = 5 + plainLabel.length;
      const space1 = Math.max(0, LABEL_COL_WIDTH - rawLen);

      const descStrPlain = opt.description ? opt.description.slice(0, Math.max(0, W - LABEL_COL_WIDTH - 2)) : '';
      const descLen = descStrPlain.length;
      
      const descStr = opt.description 
        ? (isSel ? MUTED(descStrPlain) : DIM(descStrPlain)) 
        : '';
        
      const space2 = Math.max(0, W - rawLen - space1 - descLen);

      const rowAnsi = prefix + ' '.repeat(space1) + descStr + ' '.repeat(space2);
      const coloredRow = isSel ? BG_HL(rowAnsi) : rowAnsi;

      out += GOLD(' ║') + coloredRow + GOLD('║\n');
    });

    if (endIdx < view.options.length) printIndicator('▼');

    out += GOLD(' ╚') + hBoxLine + GOLD('╝\n');

    if (chatSession.pendingApprovals && chatSession.pendingApprovals.length > 0) {
      const uniqueThreads = Array.from(new Set(chatSession.pendingApprovals.map(p => p.threadId)));
      const threadList = uniqueThreads.map(id => chalk.hex('#22D3EE').bold(id)).join(', ');
      out += '\n';
      out += '  ' + chalk.hex('#EF4444').bold('⚠️  PENDING APPROVAL: ') + chalk.white(`Agent needs command approval in thread(s): ${threadList}`) + '\n';
      out += '     Please choose "Enter Chat" or select the corresponding thread to approve.\n';
    }

    return out;
  }
}

function PhoneOSInput({ phone, exit }: { phone: PhoneOS; exit: () => void }) {
  useInput((input, key) => {
    if (!phone.active) return;

    if (key.ctrl && input === 'c') {
      process.stdout.write('\x1B[?1049l');
      exit();
      process.exit(0);
    }

    if (key.ctrl && input === 'k') {
      const handler = phone.getCtrlKHandler();
      if (handler) {
        handler();
      }
      return;
    }

    const view = phone.history[phone.history.length - 1];
    if (!view) return;

    if (key.upArrow) {
      phone.cursor = phone.cursor > 0 ? phone.cursor - 1 : view.options.length - 1;
      phone.render();
    } else if (key.downArrow) {
      phone.cursor = phone.cursor < view.options.length - 1 ? phone.cursor + 1 : 0;
      phone.render();
    } else if (key.leftArrow || key.escape || key.backspace || key.delete || input === '\x7f' || input === '\x08') {
      phone.goBack();
    } else if (key.rightArrow) {
      if (phone.forward.length > 0) {
        phone.history.push(phone.forward.pop()!);
        phone.cursor = 0;
        phone.render();
      } else {
        phone.select();
      }
    } else if (key.return) {
      phone.select();
    }
  });
  return null;
}

export function PhoneOSApp({ phone }: { phone: PhoneOS }) {
  const [, forceUpdate] = useState(0);
  const { exit } = useApp();

  useEffect(() => {
    return phone.subscribe(() => {
      forceUpdate(prev => prev + 1);
    });
  }, [phone]);

  useEffect(() => {
    const handleResize = () => {
      const view = phone.history[phone.history.length - 1];
      if (view && view.onResize) {
        view.onResize();
      }
      phone.render();
    };
    process.stdout.on('resize', handleResize);
    return () => {
      process.stdout.off('resize', handleResize);
    };
  }, [phone]);

  const isTTY = !!(process.stdin && process.stdin.isTTY);

  return (
    <Box flexDirection="column">
      <Text>{phone.drawToString()}</Text>
      {isTTY && <PhoneOSInput phone={phone} exit={exit} />}
    </Box>
  );
}
