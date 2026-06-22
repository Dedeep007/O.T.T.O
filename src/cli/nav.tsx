import React, { useState, useEffect } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import chalk from 'chalk';
import { memoryManager } from '../memory/budget.js';
import { OttoConfig } from './configurator.js';
import { chatSession } from './session.js';
import { ui } from './ui.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json');
const CLI_VERSION = pkg.version;

// THEME
const THEME = {
  bg: '#0a0a0a',
  gold: '#f5c542',
  text: '#aaaaaa',
  desc: '#555555',
  dim: '#333333',
  green: '#4ecc8a',
  cyan: '#4eccc8',
  hoverBg: '#141414',
  border: '#1a1a1a'
};

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

function strip(s: string) { return s.replace(/\x1B\[[0-9;]*m/g, ''); }

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
    if (this.notificationTimeout) clearTimeout(this.notificationTimeout);
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

  notify() { this.listeners.forEach(l => l()); }

  updateConfig(c: OttoConfig) { 
    this.config = c; 
    memoryManager.setConfig(c);
    this.notify();
  }

  registerCtrlKHandler(handler: () => void) { this.ctrlKHandler = handler; }
  getCtrlKHandler() { return this.ctrlKHandler; }

  goBack() {
    if (this.history.length > 1) {
      this.forward.push(this.history.pop()!);
      this.cursor = 0;
      const prev = this.history[this.history.length - 1];
      if (prev.onBack) prev.onBack();
      this.notify();
    }
  }

  async select() {
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

  render() { this.notify(); }

  drawToString(): string { return ''; }
}

const Topbar = ({ config }: { config: OttoConfig }) => {
  const stats  = memoryManager.getBudgetStatsForMessages(chatSession.getMessages());
  const ratio  = stats.max > 0 ? Math.min(stats.filled / stats.max, 1) : 0;
  const pct    = Math.round(ratio * 100);
  const prov   = config.defaults.primaryProvider;
  const providerConfig = (config.providers as any)[prov];
  const hasKey = !!(providerConfig?.activeApiKey || providerConfig?.apiKey || providerConfig?.apiKeys?.length);
  const isLocal = prov === 'ollama' && !!providerConfig?.baseUrl;
  const isGreen = hasKey || isLocal;
  
  const mem = process.memoryUsage();
  const ramMB = Math.round(mem.rss / 1024 / 1024);

  const fill = Math.round(ratio * 6);
  const ctxBar = Array(6).fill(0).map((_, i) => (
    <Text key={i} color={i < fill ? THEME.gold : '#222'}>▰</Text>
  ));

  return (
    <Box paddingX={2} borderBottomColor={THEME.gold} borderStyle="single" borderTop={false} borderLeft={false} borderRight={false} alignItems="center">
      <Text color={THEME.gold} bold>orchestrated task & tool operator</Text>
      <Text color={THEME.dim}> · </Text>
      <Text color={isGreen ? THEME.green : THEME.gold}>● </Text>
      <Text color={THEME.text}>{prov.toLowerCase()}</Text>
      
      {config.defaults.showContextBar !== false && (
        <Box marginLeft={2} alignItems="center">
          <Text color={THEME.dim}>ctx </Text>
          <Box marginLeft={1} marginRight={1}>{ctxBar}</Box>
          <Text color={THEME.dim}> {stats.filled}/{stats.max} </Text>
          <Text color={THEME.gold}>{pct}%</Text>
        </Box>
      )}

      <Box marginLeft={2}>
        <Text color={THEME.dim}>ram </Text>
        <Text color={THEME.text}>{ramMB}mb</Text>
      </Box>

      <Box flexGrow={1} />

      <Box marginRight={2}>
        <Text color={THEME.dim}>security </Text>
        <Text color={THEME.gold}>{config.security.mode}</Text>
      </Box>

      <Text color={THEME.dim}>v{CLI_VERSION}</Text>
    </Box>
  );
};

const MainPanel = ({ config }: { config: OttoConfig }) => {
  const model = config.providers[config.defaults.primaryProvider]?.activeModel || 'unknown';
  const cwd = process.cwd();

  const logo = [
    " ██████╗ ████████╗████████╗ ██████╗",
    "██╔═══██╗╚══██╔══╝╚══██╔══╝██╔═══██╗",
    "██║   ██║   ██║      ██║   ██║   ██║",
    "██║   ██║   ██║      ██║   ██║   ██║",
    "╚██████╔╝   ██║      ██║   ╚██████╔╝",
    " ╚═════╝    ╚═╝      ╚═╝    ╚═════╝"
  ].join("\n");

  return (
    <Box borderBottomColor={THEME.border} borderStyle="single" borderTop={false} borderLeft={false} borderRight={false}>
      <Box width="50%" paddingY={1} paddingX={3} flexDirection="column" borderRightColor={THEME.border} borderStyle="single" borderTop={false} borderBottom={false} borderLeft={false}>
        <Box marginBottom={1}>
          <Text color={THEME.dim}>o.t.t.o </Text>
          <Text color={THEME.border}>──────────────────</Text>
        </Box>
        <Box marginBottom={1}>
          <Text color={THEME.desc}>welcome back, </Text>
          <Text color={THEME.text}>{config.profile?.username || 'user'}</Text>
        </Box>
        <Box marginBottom={1}>
          <Text color={THEME.gold}>{logo}</Text>
        </Box>
        <Box flexDirection="column">
          <Box><Box width={7}><Text color={THEME.dim} wrap="truncate-end">model</Text></Box><Text color={THEME.text}>{model} </Text><Text color={THEME.dim}>· </Text><Text color={THEME.green}>active</Text></Box>
          <Box><Box width={7}><Text color={THEME.dim} wrap="truncate-end">path</Text></Box><Text color={THEME.text}>{cwd}</Text></Box>
        </Box>
      </Box>

      <Box width="50%" paddingY={1} paddingX={3} flexDirection="column">
        <Box flexDirection="column" marginBottom={1}>
          <Box marginBottom={1}><Text color={THEME.gold}>[ system status ]</Text></Box>
          <Box><Box width={10}><Text color={THEME.dim} wrap="truncate-end">agent</Text></Box><Text color={THEME.green}>● ready</Text></Box>
          <Box><Box width={10}><Text color={THEME.dim} wrap="truncate-end">security</Text></Box><Text color={THEME.gold}>● {config.security.mode}</Text></Box>
          <Box><Box width={10}><Text color={THEME.dim} wrap="truncate-end">thread</Text></Box><Text color={THEME.cyan}>● {chatSession.threadId}</Text></Box>
        </Box>

        <Box flexDirection="column">
          <Box marginBottom={1} marginTop={1}><Text color={THEME.gold}>[ navigation ]</Text></Box>
          <Box>
            <Box width="50%"><Box width={5}><Text color={THEME.gold} wrap="truncate-end">↑↓</Text></Box><Text color={THEME.desc}>navigate</Text></Box>
            <Box width="50%"><Box width={5}><Text color={THEME.gold} wrap="truncate-end">↵</Text></Box><Text color={THEME.desc}>select</Text></Box>
          </Box>
          <Box>
            <Box width="50%"><Box width={5}><Text color={THEME.gold} wrap="truncate-end">↔</Text></Box><Text color={THEME.desc}>switch</Text></Box>
            <Box width="50%"><Box width={5}><Text color={THEME.gold} wrap="truncate-end">^C</Text></Box><Text color={THEME.desc}>quit</Text></Box>
          </Box>
        </Box>
      </Box>
    </Box>
  );
};

const MenuPanel = ({ phone, view }: { phone: PhoneOS, view: PhoneView }) => {
  const visibleCount = Math.max(3, (process.stdout.rows || 24) - 20);
  
  let startIdx = 0;
  let endIdx = view.options.length;
  
  if (view.options.length > visibleCount) {
    startIdx = Math.max(0, phone.cursor - Math.floor(visibleCount / 2));
    endIdx = startIdx + visibleCount;
    if (endIdx > view.options.length) {
      endIdx = view.options.length;
      startIdx = Math.max(0, endIdx - visibleCount);
    }
  }

  const visibleOptions = view.options.slice(startIdx, endIdx);

  return (
    <Box flexDirection="column">
      <Box paddingX={3} paddingBottom={1} borderBottomColor={THEME.border} borderStyle="single" borderTop={false} borderLeft={false} borderRight={false}>
        <Text color={THEME.text}>menu </Text><Text color={THEME.dim}>— select an action</Text>
      </Box>
      
      {startIdx > 0 && <Box justifyContent="center"><Text color={THEME.dim}>▲</Text></Box>}
      
      {visibleOptions.map((opt, idx) => {
        const realIdx = startIdx + idx;
        const isActive = realIdx === phone.cursor;
        
        return (
          <Box 
            key={realIdx}
            paddingX={2} 
            paddingY={0}
          >
            <Box width={2}><Text backgroundColor={isActive ? THEME.hoverBg : undefined} color={isActive ? THEME.gold : THEME.bg}>{isActive ? '┃' : ' '}</Text></Box>
            <Box width={30}>
              <Text color={isActive ? THEME.gold : THEME.text} bold={isActive}>{strip(opt.label).toLowerCase().padEnd(28)}</Text>
            </Box>
            <Box>
              <Text color={isActive ? THEME.desc : THEME.dim}>{opt.description ? strip(opt.description).toLowerCase().padEnd(80) : ' '.repeat(80)}</Text>
            </Box>
          </Box>
        );
      })}
      
      {endIdx < view.options.length && (
        <Box justifyContent="center" borderTopColor="#131313" borderStyle="single" borderBottom={false} borderLeft={false} borderRight={false}>
          <Text color="#2a2a2a">▼</Text>
        </Box>
      )}
    </Box>
  );
};

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
      if (view && view.onResize) view.onResize();
      phone.render();
    };
    process.stdout.on('resize', handleResize);
    return () => {
      process.stdout.off('resize', handleResize);
    };
  }, [phone]);

  useInput((input, key) => {
    if (!phone.active) return;

    if (key.ctrl && input === 'c') {
      process.stdout.write('\x1B[?1049l');
      exit();
      process.exit(0);
    }

    if (key.ctrl && input === 'k') {
      const handler = phone.getCtrlKHandler();
      if (handler) handler();
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

  const view = phone.history[phone.history.length - 1];
  if (!view) return null;

  let bodyLines: string[] = [];
  if (view.renderBody) {
    const orig = console.log;
    console.log = (...a: any[]) => a.join(' ').split('\n').forEach(l => bodyLines.push(l));
    try { view.renderBody(); } finally { console.log = orig; }
  }

  return (
    <Box flexDirection="column" width="100%">
      <Topbar config={phone.config} />
      <MainPanel config={phone.config} />
      
      {phone.history.length > 1 && (
        <Box paddingX={3} paddingTop={1}>
          <Text color={THEME.dim}>
            {phone.history.map(v => strip(v.title).toLowerCase()).join(' › ')}
          </Text>
        </Box>
      )}

      {view.subtitle && (
        <Box paddingX={3} paddingTop={1}>
          <Text color={THEME.text} bold>{strip(view.subtitle).toLowerCase()}</Text>
        </Box>
      )}

      {bodyLines.length > 0 && (
        <Box paddingX={3} paddingTop={1} flexDirection="column">
          {bodyLines.map((l, i) => <Text key={i}>{l}</Text>)}
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        <MenuPanel phone={phone} view={view} />
      </Box>

      {phone.notification && (
        <Box paddingX={3} marginTop={1}>
          <Text color={phone.notificationType === 'error' ? '#EF4444' : '#10B981'} bold>
            {phone.notificationType === 'error' ? '✘ ' : '✓ '} {phone.notification.toLowerCase()}
          </Text>
        </Box>
      )}

      {chatSession.pendingApprovals?.length > 0 && (
        <Box paddingX={3} marginTop={1}>
          <Text color="#EF4444" bold>⚠️ pending approval: </Text>
          <Text color="#fff">agent needs command approval</Text>
        </Box>
      )}

      {chatSession.pendingPlans?.size > 0 && (
        <Box paddingX={3} marginTop={1}>
          <Text color="#F59E0B" bold>📋 pending plan: </Text>
          <Text color="#fff">agent proposed a plan</Text>
        </Box>
      )}
    </Box>
  );
}
