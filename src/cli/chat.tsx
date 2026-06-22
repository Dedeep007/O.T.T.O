import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import chalk from 'chalk';
import { marked, Marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import fs from 'fs';
import path from 'path';

export interface ChatMessage {
  role: 'user' | 'ai' | 'system' | 'tool';
  content: string;
}

export interface ChatTelemetry {
  ctxMax: number;
  ctxUsed: number;
  ramMB: number;
  showContextBar: boolean;
  isStreaming?: boolean;
}

function stripAnsi(str: string): string {
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}

function getCharWidth(char: string): number {
  const codePoint = char.codePointAt(0);
  if (!codePoint) return 0;
  if (codePoint === 0x25B6) { // ▶
    return 2;
  }
  if (
    (codePoint >= 0x1F300 && codePoint <= 0x1F9FF) ||
    (codePoint >= 0x1F600 && codePoint <= 0x1F64F) ||
    (codePoint >= 0x1F680 && codePoint <= 0x1F6FF) ||
    (codePoint >= 0x2600 && codePoint <= 0x27BF) ||
    (codePoint >= 0x4E00 && codePoint <= 0x9FFF) ||
    (codePoint >= 0xAC00 && codePoint <= 0xD7A3) ||
    (codePoint >= 0xFF00 && codePoint <= 0xFFEF)
  ) {
    return 2;
  }
  if (codePoint === 0xFE0F || codePoint === 0xFE0E) {
    return 0;
  }
  return 1;
}

function getStringWidth(str: string): number {
  const stripped = stripAnsi(str);
  let width = 0;
  for (const char of stripped) {
    width += getCharWidth(char);
  }
  return width;
}

function ansiPadEnd(str: string, targetWidth: number, padChar = ' '): string {
  const currentWidth = getStringWidth(str);
  const padLen = Math.max(0, targetWidth - currentWidth);
  return str + padChar.repeat(padLen);
}

function padVisible(str: string, width: number): string {
  return str + ' '.repeat(Math.max(0, width - getStringWidth(str)));
}

function wrapText(text: string, maxWidth: number, indent: number): string[] {
  const lines: string[] = [];
  const rawLines = text.split('\n');

  rawLines.forEach(rawLine => {
    const words = rawLine.split(' ');
    let currentLine = '';

    words.forEach(word => {
      if (stripAnsi(currentLine + word).length > maxWidth - indent) {
        lines.push(' '.repeat(indent) + currentLine.trim());
        currentLine = word + ' ';
      } else {
        currentLine += word + ' ';
      }
    });

    if (currentLine) lines.push(' '.repeat(indent) + currentLine.trim());
  });

  return lines;
}

function renderDiffBlock(codeStr: string, diffWidth: number, isExpanded: boolean): string {
  let output = '\n';

  const row = (bg: string, fg: string, text: string) =>
    chalk.bgHex(bg).hex(fg)(padVisible(text, diffWidth));

  const allLines = codeStr.split('\n');
  const total = allLines.length;

  let toRender = allLines;
  if (!isExpanded && total > 15) {
    const top = allLines.slice(0, 7);
    const bottom = allLines.slice(total - 3);
    toRender = [...top, `... (${total - 10} hidden lines) [Press Ctrl+E to Expand] ...`, ...bottom];
  }

  toRender.forEach(line => {
    const maxLen = diffWidth;
    const subLines: string[] = [];
    let current = line;
    while (current.length > maxLen) {
      subLines.push(current.substring(0, maxLen));
      current = current.substring(maxLen);
    }
    subLines.push(current);

    subLines.forEach((sl, idx) => {
      let displayLine = sl;
      
      if (line.startsWith('+++') || line.startsWith('---')) {
        output += chalk.bgHex('#0d1929').hex('#888888')(padVisible(displayLine, diffWidth)) + '\n';
      } else if (line.startsWith('@@')) {
        output += chalk.bgHex('#1a3a5c').hex('#4a9eff')(padVisible(displayLine, diffWidth)) + '\n';
      } else if (line.startsWith('+')) {
        const textPart = padVisible(' ' + displayLine, diffWidth - 1);
        output += chalk.bgHex('#4ecc8a')(' ') + chalk.bgHex('#1a3d1a').hex('#4ecc8a')(textPart) + '\n';
      } else if (line.startsWith('-')) {
        const textPart = padVisible(' ' + displayLine, diffWidth - 1);
        output += chalk.bgHex('#cc4e4e')(' ') + chalk.bgHex('#3d1515').hex('#ff6b6b')(textPart) + '\n';
      } else if (line.startsWith('... (')) {
        output += chalk.bgHex('#0d1929').hex('#FBBF24')(padVisible(' ' + displayLine, diffWidth)) + '\n';
      } else {
        output += chalk.bgHex('#0d1929').hex('#6a8a6a')(padVisible(' ' + displayLine, diffWidth)) + '\n';
      }
    });
  });
  return output + '\n';
}

function renderMarkdownWithOttoStyles(content: string, width: number, diffsExpanded: boolean): string {
  content = content.replace(/\r/g, '');
  const diffWidth = Math.max(48, Math.min(width, 96));

  const placeholders: string[] = [];
  const withPlaceholders = content.replace(
    /```([a-zA-Z0-9_.-]*)\n([\s\S]*?)(?:```|$)/g,
    (_match, lang: string, codeStr: string) => {
      if (lang === 'diff') {
        const rendered = renderDiffBlock(codeStr, diffWidth, diffsExpanded);
        const key = `\u0000DIFF${placeholders.length}\u0000`;
        placeholders.push(rendered);
        return key;
      } else {
        let output = '\n';
        const lines = codeStr.replace(/\n$/, '').split('\n');
        lines.forEach(line => {
          output += chalk.bgHex('#0d1929').hex('#888888')(padVisible(` ${line}`, diffWidth)) + '\n';
        });

        const key = `\u0000DIFF${placeholders.length}\u0000`;
        placeholders.push(output + '\n');
        return key;
      }
    }
  );

  const myMarked = new Marked();
  myMarked.use(markedTerminal({
    width,
    reflowText: true,
    codespan: chalk.hex('#F5C400'),
    strong: chalk.white.bold,
    em: chalk.italic,
  }) as any);

  const parsed = myMarked.parse(withPlaceholders) as string;
  return parsed.replace(/\u0000DIFF(\d+)\u0000/g, (_m, idx) => placeholders[Number(idx)]);
}

export class ChatUI {
  public W = 72;
  public lastLineCount = 0;
  public scrollOffset = 0;
  public totalContentLines = 0;
  public notification: string = '';
  public notificationType: 'success' | 'warning' | 'error' | 'info' | 'alert' = 'success';
  private notificationTimeout?: NodeJS.Timeout;

  private BRAND = chalk.hex('#F5C400');
  private DIM   = chalk.hex('#374151');
  private MUTED = chalk.hex('#6B7280');
  private AI_TAG = this.BRAND.bold;

  private listeners: (() => void)[] = [];
  public currentData: any = null;
  private keyHandler?: (str: string, key: any) => void;

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

  registerKeyHandler(handler: (str: string, key: any) => void) {
    this.keyHandler = handler;
  }

  removeKeyHandler() {
    this.keyHandler = undefined;
  }

  getKeyHandler() {
    return this.keyHandler;
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

  scrollUp(n = 3) {
    const viewH = Math.max(1, (process.stdout.rows || 24) - 1);
    const max   = Math.max(0, this.totalContentLines - viewH);
    this.scrollOffset = Math.min(this.scrollOffset + n, max);
    this.notify();
  }

  scrollDown(n = 3) {
    this.scrollOffset = Math.max(0, this.scrollOffset - n);
    this.notify();
  }

  scrollToBottom() {
    this.scrollOffset = 0;
    this.notify();
  }

  isAtBottom(): boolean {
    return this.scrollOffset === 0;
  }

  render(
    messages: ChatMessage[],
    currentInput: string,
    telemetry: ChatTelemetry,
    model: string,
    isThinking: boolean = false,
    pendingPlan: boolean = false,
    planMenuIndex: number = 0,
    diffsExpanded: boolean = false,
    delayMessage?: string,
    pendingApproval?: { type: 'command' | 'app', cmd: string, commandStr: string },
    approvalMenuIndex: number = 0
  ) {
    this.currentData = {
      messages,
      currentInput,
      telemetry,
      model,
      isThinking,
      pendingPlan,
      planMenuIndex,
      diffsExpanded,
      delayMessage,
      pendingApproval,
      approvalMenuIndex
    };
    this.notify();
  }

  drawToString(): string {
    if (!this.currentData) return '';
    this.W = process.stdout.columns ? Math.max(Math.min(process.stdout.columns - 4, 120), 60) : 72;
    const {
      messages,
      currentInput,
      telemetry,
      model,
      isThinking,
      pendingPlan,
      planMenuIndex,
      diffsExpanded,
      delayMessage,
      pendingApproval,
      approvalMenuIndex
    } = this.currentData;

    const lines: string[] = [];
    const push = (line: string = '') => {
      lines.push(line);
    };

    push(this.DIM('-'.repeat(this.W)));

    const leftHeader = '  ' + this.BRAND('OTTO') + '  ';
    const ctxPercent = telemetry.ctxMax > 0
      ? Math.round((Math.min(telemetry.ctxUsed / telemetry.ctxMax, 1)) * 100)
      : 0;
    const ctxSummary = telemetry.showContextBar
      ? `ctx: ${telemetry.ctxUsed}/${telemetry.ctxMax} (${ctxPercent}%)`
      : 'ctx: hidden';
    const rightHeader = this.MUTED(`${ctxSummary}  |  ram: ${telemetry.ramMB}mb  |  ${model}`) + '  ';
    const spaces = Math.max(0, this.W - stripAnsi(leftHeader).length - stripAnsi(rightHeader).length);

    push(leftHeader + ' '.repeat(spaces) + rightHeader);
    push(this.DIM('-'.repeat(this.W)));
    if (this.notification) {
      let bg = '#1F2937';
      let fg = '#10B981';
      let icon = '✓';
      if (this.notificationType === 'warning') {
        bg = '#78350F';
        fg = '#FBBF24';
        icon = '⚠';
      } else if (this.notificationType === 'error') {
        bg = '#450A0A';
        fg = '#F87171';
        icon = '✘';
      } else if (this.notificationType === 'info') {
        bg = '#1E3A8A';
        fg = '#60A5FA';
        icon = 'ℹ';
      } else if (this.notificationType === 'alert') {
        bg = '#581C87';
        fg = '#C084FC';
        icon = '🔔';
      }
      push('  ' + chalk.bgHex(bg).hex(fg).bold(`  ${icon} ${this.notification}  `));
      push('');
    } else {
      push('');
    }

    messages.forEach((msg: any) => {
      if (msg.role === 'system') {
        push('  ' + chalk.bgHex('#2a2a2a').hex('#888')(' SYSTEM ') + ' ' + chalk.hex('#555')(msg.content));
        push('');
        return;
      }

      if (msg.role === 'tool') {
        const rendered = renderMarkdownWithOttoStyles(msg.content, this.W, diffsExpanded);
        rendered.trim().split('\n').forEach(line => push(line));
        push('');
        return;
      }

      const header = msg.role === 'user'
        ? '  ' + chalk.bgHex('#2a2a2a').hex('#888')(' YOU ')
        : '  ' + chalk.hex('#f5c542').bold('O.T.T.O');
      push(header);
      push('');

      let rawContent = msg.content;

      const thinkMatch = rawContent.match(/<(?:think|thought)>([\s\S]*?)(?:<\/(?:think|thought)>|$)/);
      if (thinkMatch) {
        rawContent = rawContent.replace(/<(?:think|thought)>[\s\S]*?(?:<\/(?:think|thought)>|$)/, '').trim();
        const thinkLines = thinkMatch[1].trim().split('\n');
        if (!diffsExpanded) {
          push('  ' + chalk.hex('#555555')(`[ Reasoning Process (${thinkLines.length} lines) - Press Ctrl+E to Expand ]`));
        } else {
          thinkLines.forEach((l: string) => push('  ' + chalk.hex('#555555')(l)));
        }
        push('');
      }

      if (msg.content.includes('<think>') && !msg.content.includes('</think>')) {
        push('  ' + chalk.hex('#555555')('Thinking...'));
        push('');
      }

      if (rawContent.trim()) {
        const processedContent = rawContent.replace(/`([^`]+)`/g, (_m: any, p1: string) => chalk.hex('#f5c542')(p1));
        const rendered = renderMarkdownWithOttoStyles(processedContent, this.W, diffsExpanded);
        rendered.trim().split('\n').forEach(line => {
           if (line.includes('\x1B[48;2;13;25;41m') || line.includes('\x1B[48;5;17m')) { 
             push(line);
           } else {
             push('  ' + line);
           }
        });
      }

      push('');
    });

    if (delayMessage) {
      const dots = '.'.repeat((Math.floor(Date.now() / 350) % 3) + 1);
      push('  ' + chalk.hex('#f5c542').bold('O.T.T.O'));
      push('');
      push('  ' + chalk.hex('#555555')(`${delayMessage}${dots}`));
      push('');
    } else if (isThinking) {
      const dots = '.'.repeat((Math.floor(Date.now() / 350) % 3) + 1);
      push('  ' + chalk.hex('#f5c542').bold('O.T.T.O'));
      push('');
      push('  ' + chalk.hex('#555555')(`Thinking${dots}`));
      push('');
    }

    if (pendingApproval) {
      push('  ' + chalk.bgHex('#2a2a2a').hex('#888')(' SYSTEM ') + chalk.hex('#f5c542')(' SECURITY APPROVAL REQUIRED'));
      push('');
      const actionType = pendingApproval.type === 'app' ? 'launch application' : 'execute command';
      push('  ' + chalk.hex('#bbb')(`The agent wants to ${actionType}:`));
      push('  ' + chalk.hex('#f5c542').bold(pendingApproval.commandStr));
      push('');
      const menuItems = [
        { label: 'Approve for now', color: chalk.hex('#4ecc8a') },
        { label: `Approve always (whitelist '${pendingApproval.cmd}')`, color: chalk.hex('#4eccc8') },
        { label: 'Don\'t approve', color: chalk.hex('#ff6b6b') },
      ];
      menuItems.forEach((item, idx) => {
        const isSelected = idx === approvalMenuIndex;
        const prefix = isSelected ? chalk.hex('#f5c542').bold(' > ') : '   ';
        const label = isSelected ? chalk.bgHex('#141414').hex('#f5c542').bold(item.label) : chalk.hex('#aaa')(item.label);
        push('  ' + prefix + label);
      });
      push('');
    }

    if (pendingPlan) {
      push('  ' + chalk.bgHex('#2a2a2a').hex('#888')(' SYSTEM ') + chalk.hex('#f5c542')(' PENDING PLAN'));
      push('');
      const menuItems = [
        { label: 'Approve - execute the plan', color: chalk.hex('#4ecc8a') },
        { label: 'Edit - request changes first', color: chalk.hex('#f5c542') },
        { label: 'Cancel - do not proceed', color: chalk.hex('#ff6b6b') },
      ];
      menuItems.forEach((item, idx) => {
        const isSelected = idx === planMenuIndex;
        const prefix = isSelected ? chalk.hex('#f5c542').bold(' > ') : '   ';
        const label = isSelected ? chalk.bgHex('#141414').hex('#f5c542').bold(item.label) : chalk.hex('#aaa')(item.label);
        push('  ' + prefix + label);
      });
      push('');
    }

    if (this.totalContentLines > 0 && this.scrollOffset > 0) {
      const deltaLines = lines.length - this.totalContentLines;
      this.scrollOffset += deltaLines;
    }
    this.totalContentLines = lines.length;

    const viewH = Math.max(1, (process.stdout.rows || 24) - 2);
    const maxOffset = Math.max(0, lines.length - viewH);
    this.scrollOffset = Math.min(this.scrollOffset, maxOffset);

    const viewStart = maxOffset - this.scrollOffset;
    const visible = lines.slice(viewStart, viewStart + viewH);

    const linesAbove = viewStart;
    const linesBelow = this.scrollOffset;

    if (linesAbove > 0 && visible.length > 0) {
      visible[0] = chalk.hex('#555')(`↑ ${linesAbove} lines above `) + chalk.hex('#666')('(↑/↓ scroll  PgUp/PgDn page  End to snap)');
      visible.splice(1, 0, chalk.hex('#1a1a1a')('─'.repeat(this.W)));
    }
    if (linesBelow > 0 && visible.length > 1) {
      visible[visible.length - 1] = chalk.hex('#444')(`↓ ${linesBelow} lines below`);
    }

    let outStr = '';
    for (const line of visible) {
      outStr += line + '\x1B[K\n';
    }

    const promptPrefix = chalk.bgHex('#0a0a0a').hex('#f5c542').bold(' > ');
    const isEditing = !isThinking && !pendingApproval && !pendingPlan && !delayMessage;
    const cursor = isEditing && (Math.floor(Date.now() / 1000) % 2 === 0) ? chalk.bgHex('#0a0a0a').hex('#f5c542')('█') : chalk.bgHex('#0a0a0a')(' ');
    
    let placeholder = '';
    if (currentInput.length === 0) {
      if (pendingApproval || pendingPlan) {
        placeholder = chalk.bgHex('#0a0a0a').hex('#444')('↑↓ choose  ↵ confirm');
      } else {
        placeholder = chalk.bgHex('#0a0a0a').hex('#444')('Type your message... (esc to menu)');
      }
    }
    
    const scrollHint = linesBelow > 0 ? chalk.bgHex('#0a0a0a').hex('#333')('  [scrolled — End to return]') : '';

    outStr += chalk.bgHex('#0a0a0a')(padVisible(promptPrefix + chalk.white(currentInput) + cursor + placeholder + scrollHint, this.W));
    return outStr;
  }
}

export function translateInkKey(input: string, key: any) {
  let name = '';
  if (key.upArrow) name = 'up';
  else if (key.downArrow) name = 'down';
  else if (key.leftArrow) name = 'left';
  else if (key.rightArrow) name = 'right';
  else if (key.return) name = 'return';
  else if (key.escape) name = 'escape';
  else if (key.backspace || key.delete || input === '\x7f' || input === '\x08') name = 'backspace';
  else if (key.tab) name = 'tab';
  else if (key.pageUp) name = 'pageup';
  else if (key.pageDown) name = 'pagedown';
  else if (input) name = input.toLowerCase();

  return {
    ctrl: !!key.ctrl,
    meta: !!key.meta,
    shift: !!key.shift,
    name
  };
}

function ChatUIInput({ chatUI }: { chatUI: ChatUI }) {
  useInput((input, key) => {
    const handler = chatUI.getKeyHandler();
    if (handler) {
      const translatedKey = translateInkKey(input, key);
      handler(input, translatedKey);
    }
  });
  return null;
}

export function ChatUIApp({ chatUI }: { chatUI: ChatUI }) {
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    return chatUI.subscribe(() => {
      forceUpdate(prev => prev + 1);
    });
  }, [chatUI]);

  useEffect(() => {
    const handleResize = () => {
      chatUI.notify();
    };
    process.stdout.on('resize', handleResize);
    return () => {
      process.stdout.off('resize', handleResize);
    };
  }, [chatUI]);

  const isTTY = !!(process.stdin && process.stdin.isTTY);

  return (
    <Box flexDirection="column">
      <Text>{chatUI.drawToString()}</Text>
      {isTTY && <ChatUIInput chatUI={chatUI} />}
    </Box>
  );
}
