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

// Resize-safe width/height readers. No artificial floor: we report the
// terminal's true usable size (clamped only so repeat()/padding never go
// negative). Below COMPACT_BREAKPOINT the caller switches to a 1-column
// layout instead of squeezing the wide layout into too little space.
const ABS_MIN_W = 20;
const COMPACT_BREAKPOINT = 70;

function getTermWidth(margin: number, cap: number): { W: number; compact: boolean } {
  const cols = process.stdout.columns || (95 + margin);
  const W = Math.max(ABS_MIN_W, Math.min(cols - margin, cap));
  return { W, compact: W < COMPACT_BREAKPOINT };
}

function getTermRows(): number {
  return Math.max(1, process.stdout.rows || 24);
}

export class PhoneOS {
  public history: PhoneView[]    = [];
  public forward:  PhoneView[]   = [];
  public cursor:   number        = 0;
  public active:    boolean       = false;
  public config:   OttoConfig;
  public listening: boolean      = false;
  public notification: string = '';
  public notificationType: 'success' | 'warning' | 'error' | 'info' | 'alert' = 'success';
  private notificationTimeout?: NodeJS.Timeout;
  private ctrlKHandler?: () => void;
  private listeners: (() => void)[] = [];

  constructor(c: OttoConfig) {
    this.config = c;
    memoryManager.setConfig(c);
  }

  showNotification(msg: string, type: 'success' | 'warning' | 'error' | 'info' | 'alert' = 'success', timeoutMs: number = 2000) {
    this.notification = msg;
    this.notificationType = type;
    if (this.notificationTimeout) {
      clearTimeout(this.notificationTimeout);
    }
    this.notify();
    this.notificationTimeout = setTimeout(() => {
      this.notification = '';
      this.notify();
    }, timeoutMs);
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
    memoryManager.setConfig(c);
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
    const { W, compact } = getTermWidth(4, 150);

    const GOLD  = chalk.hex('#f5c542');
    const MUTED = chalk.hex('#555555');
    const DIM   = chalk.hex('#333333');
    const TEXT  = chalk.hex('#dddddd');
    const CYAN  = chalk.hex('#4eccc8');
    const GREEN = chalk.hex('#4ecc8a');
    const RED   = chalk.hex('#ff6b6b');

    // ── Header Box (Borderless) ────────────────────────────────────────────────
    const isOllama = prov === 'ollama';
    const isLocal = isOllama && !!providerConfig?.baseUrl;
    const dot = (hasKey || isLocal) ? GREEN('●') : RED('●');
    const provPill = dot + ' ' + GOLD.bold(prov.toUpperCase());
    
    let barChalk = GOLD;
    if (ratio > 0.75) barChalk = RED;
    const BAR = 7;
    const fill = Math.round(ratio * BAR);
    const ctxBar = barChalk('■'.repeat(fill)) + DIM('■'.repeat(BAR - fill));
    const ctxPill = MUTED('ctx ') + ctxBar + ' ' + GOLD(`${stats.filled}/${stats.max} ${pct}%`);
    const ramPill = MUTED('ram ') + TEXT(`${ramMB}mb`);
    const secPill = MUTED('security ') + GOLD(this.config.security.mode);
    const verPill = DIM(`v${CLI_VERSION}`);

    if (compact) {
      out += GOLD.bold('O.T.T.O\n');
      out += `${provPill}  ${ctxPill}\n`;
      out += `${ramPill}  ${secPill}\n`;
    } else {
      const topRows = [
        GOLD.bold('Orchestrated'),
        GOLD.bold('Task & Tool'),
        GOLD.bold('Operator')
      ];
      const rightRow = `${provPill}   ${ctxPill}   ${ramPill}      ${secPill}   ${verPill}`;
      out += topRows[0] + ' '.repeat(Math.max(0, W - vlen(topRows[0]) - vlen(rightRow))) + rightRow + '\n';
      out += topRows[1] + '\n';
      out += topRows[2] + '\n';
    }

    out += GOLD('─'.repeat(W)) + '\n\n';

    if (this.notification) {
      let bg = '#1a1a1a';
      let fg = '#4ecc8a';
      if (this.notificationType === 'warning') { fg = '#f5c542'; }
      else if (this.notificationType === 'error') { fg = '#ff6b6b'; }
      out += chalk.bgHex(bg).hex(fg).bold(` ${this.notification} \n\n`);
    }

    // ── Dashboard Body ────────────────────────────────────────────
    if (view.id === 'home') {
      const username = process.env.USER || process.env.USERNAME || 'User';
      const logoLines = [
        "██████╗ ████████╗████████╗ ██████╗ ",
        "██╔═══██╗╚══██╔══╝╚══██╔══╝██╔═══██╗",
        "██║   ██║   ██║      ██║   ██║   ██║",
        "██║   ██║   ██║      ██║   ██║   ██║",
        "╚██████╔╝   ██║      ██║   ╚██████╔╝",
        " ╚═════╝    ╚═╝      ╚═╝    ╚═════╝ "
      ];
      
      const model = this.config.providers[prov]?.model || 'default';
      const threads = chatSession.getMessages().length > 0 ? chatSession.threadId : 'none';

      const leftWidth = Math.max(40, Math.floor(W * 0.5));
      const logoWidth = 36;
      const logoPad = ' '.repeat(Math.max(0, Math.floor((leftWidth - logoWidth) / 2)));

      const leftRows = [
        MUTED('O.T.T.O'),
        MUTED(`welcome back, ${username}`),
        '',
        ...logoLines.map(l => logoPad + GOLD(l)),
        '',
        MUTED('version ') + TEXT(`v${CLI_VERSION}`),
        MUTED('model ') + TEXT(`${model} `) + GREEN('active'),
        MUTED('path ') + TEXT(process.cwd())
      ];

      const rightRows = [
        GOLD.bold('[ system status ]'),
        '',
        MUTED('agent      ') + GREEN('● ready'),
        MUTED('security   ') + GOLD(`● ${this.config.security.mode}`),
        MUTED('thread     ') + CYAN(`● ${threads}`),
        '',
        GOLD.bold('[ navigation ]'),
        '',
        GOLD('↑↓') + MUTED(' navigate      ') + GOLD('↵') + MUTED(' select'),
        GOLD('←→') + MUTED(' switch        ') + GOLD('^C') + MUTED(' quit')
      ];

      if (compact) {
        leftRows.forEach(r => out += r + '\n');
        out += '\n';
        rightRows.forEach(r => out += r + '\n');
      } else {
        const leftWidth = Math.max(40, Math.floor(W * 0.5));
        const maxLen = Math.max(leftRows.length, rightRows.length);
        for (let i = 0; i < maxLen; i++) {
          const l = leftRows[i] || '';
          const r = rightRows[i] || '';
          const lPad = Math.max(0, leftWidth - vlen(l));
          out += l + ' '.repeat(lPad) + DIM('│ ') + r + '\n';
        }
      }
    } else {
      if (view.subtitle) {
        out += GOLD.bold(view.subtitle) + '\n\n';
      }
      if (view.renderBody) {
        const orig = console.log;
        console.log = (...a: any[]) => out += a.join(' ') + '\n';
        try { view.renderBody(); } finally { console.log = orig; }
      }
    }

    out += '\n' + DIM('─'.repeat(W)) + '\n';
    out += GOLD.bold(view.title.toLowerCase()) + MUTED('   — select an action\n\n');

    // ── Menu List ──────────────────────────────────────────────────
    const rows = getTermRows();
    const nonMenuHeight = out.split('\n').length + 5; 
    const maxMenuOptions = Math.max(3, rows - nonMenuHeight);
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

    if (startIdx > 0) out += MUTED('  ▲\n');

    const LABEL_COL_WIDTH = 25;
    const visibleOptions = view.options.slice(startIdx, endIdx);

    visibleOptions.forEach((opt, idx) => {
      const realIdx = startIdx + idx;
      const isSel = realIdx === this.cursor;
      const plainLabel = strip(opt.label).toLowerCase();
      const plainDesc = (opt.description || '').toLowerCase();

      const prefix = isSel ? GOLD('▌ ') : '  ';
      const label = isSel ? GOLD.bold(plainLabel) : TEXT(plainLabel);
      const desc = isSel ? MUTED(plainDesc) : DIM(plainDesc);

      const space1 = Math.max(1, LABEL_COL_WIDTH - plainLabel.length);
      const space2 = Math.max(0, W - plainLabel.length - space1 - plainDesc.length - 2);

      let bgStr = prefix + label + ' '.repeat(space1) + desc + ' '.repeat(space2);
      if (isSel) bgStr = chalk.bgHex('#141414')(bgStr);

      out += bgStr + '\n';
    });

    if (endIdx < view.options.length) out += MUTED('  ▼\n');

    if (chatSession.pendingApprovals && chatSession.pendingApprovals.length > 0) {
      const uniqueThreads = Array.from(new Set(chatSession.pendingApprovals.map(p => p.threadId)));
      out += `\n  ${RED.bold('⚠️ PENDING APPROVAL')} ${TEXT(`in threads: ${uniqueThreads.join(', ')}`)}\n`;
    }

    if (chatSession.pendingPlans && chatSession.pendingPlans.size > 0) {
      const threadList = Array.from(chatSession.pendingPlans).join(', ');
      out += `\n  ${GOLD.bold('📋 PENDING PLAN')} ${TEXT(`in threads: ${threadList}`)}\n`;
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
    let lastViewId = '';
    return phone.subscribe(() => {
      const activeView = phone.history[phone.history.length - 1];
      const activeViewId = activeView ? activeView.id : '';
      if (activeViewId !== lastViewId) {
        lastViewId = activeViewId;
        ui.clearScreen();
      }
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