import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from './ink-compat.js';
import chalk from 'chalk';
import { marked, Marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import fs from 'fs';
import path from 'path';
import { ThemeProvider } from './ui/contexts/ThemeContext.js';
import { SessionProvider } from './ui/contexts/SessionContext.js';
import { DialogProvider, DialogRenderer } from './ui/contexts/DialogContext.js';
import { SessionView } from './ui/routes/SessionView.js';

export interface ChatMessage {
  role: 'user' | 'ai' | 'system' | 'tool';
  content: string;
  toolInfo?: {
    name: string;
    args: any;
    status: 'running' | 'done' | 'error';
    rawOutput?: string;
  };
  toolCalls?: any[];
  state?: string;
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

// Resize-safe width reader. No artificial floor: report the terminal's
// true usable width (clamped only so repeat()/padding never go negative).
// Below COMPACT_BREAKPOINT the renderer switches the header to a stacked
// 1-column layout instead of squeezing into too little horizontal space.
const ABS_MIN_W = 20;
const COMPACT_BREAKPOINT = 70;

function getTermWidth(margin: number, cap: number): { W: number; compact: boolean } {
  const cols = process.stdout.columns || (72 + margin);
  const W = Math.max(ABS_MIN_W, Math.min(cols - margin, cap));
  return { W, compact: W < COMPACT_BREAKPOINT };
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

  const allLines = codeStr.split('\n');
  const total = allLines.length;

  let toRender = allLines;
  if (!isExpanded && total > 15) {
    const top = allLines.slice(0, 7);
    const bottom = allLines.slice(total - 3);
    toRender = [...top, `... (${total - 10} hidden lines) [Press Ctrl+E to Expand] ...`, ...bottom];
  }

  let oldLineNum = 0;
  let newLineNum = 0;
  let inHunk = false;

  for (let i = 0; i < toRender.length; i++) {
    const line = toRender[i];

    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      oldLineNum = parseInt(hunkMatch[1], 10);
      newLineNum = parseInt(hunkMatch[2], 10);
      inHunk = true;
      output += chalk.bgHex('#0a0a0a').hex('#555555')(padVisible(line, diffWidth)) + '\n';
      continue;
    }

    if (line.startsWith('+++') || line.startsWith('---')) {
      output += chalk.bgHex('#0a0a0a').hex('#555555')(padVisible(line, diffWidth)) + '\n';
      continue;
    }

    if (line.startsWith('... (')) {
      output += chalk.bgHex('#1a1a1a').hex('#f5c542')(padVisible(line, diffWidth)) + '\n';
      continue;
    }

    let linePrefix = '';
    let displayLine = line;
    let bgColor = '#0a0a0a'; 
    let fgColor = '#D1D5DB';
    let lineNumColor = '#555555';
    let currentLineNum = 0;
    
    let highlightRanges: {start: number, end: number, bg: string, fg: string}[] = [];

    if (line.startsWith('+')) {
      currentLineNum = newLineNum++;
      bgColor = '#052e16'; 
      fgColor = '#A7F3D0';
      lineNumColor = '#4ADE80';
      displayLine = line.substring(1);
      linePrefix = '+ ';
      
      if (i > 0 && toRender[i-1].startsWith('-')) {
        const prevLine = toRender[i-1].substring(1);
        let start = 0;
        while(start < displayLine.length && start < prevLine.length && displayLine[start] === prevLine[start]) start++;
        let endNew = displayLine.length - 1;
        let endOld = prevLine.length - 1;
        while(endNew >= start && endOld >= start && displayLine[endNew] === prevLine[endOld]) {
          endNew--;
          endOld--;
        }
        if (start <= endNew) {
          highlightRanges.push({ start, end: endNew + 1, bg: '#14532d', fg: '#ffffff' });
        }
      }
    } else if (line.startsWith('-')) {
      currentLineNum = oldLineNum++;
      bgColor = '#3f1111';
      fgColor = '#FECACA';
      lineNumColor = '#ef4444';
      displayLine = line.substring(1);
      linePrefix = '- ';
      
      if (i + 1 < toRender.length && toRender[i+1].startsWith('+')) {
        const nextLine = toRender[i+1].substring(1);
        let start = 0;
        while(start < displayLine.length && start < nextLine.length && displayLine[start] === nextLine[start]) start++;
        let endOld = displayLine.length - 1;
        let endNew = nextLine.length - 1;
        while(endOld >= start && endNew >= start && displayLine[endOld] === nextLine[endNew]) {
          endOld--;
          endNew--;
        }
        if (start <= endOld) {
          highlightRanges.push({ start, end: endOld + 1, bg: '#7f1d1d', fg: '#ffffff' });
        }
      }
    } else {
      if (inHunk) {
        currentLineNum = newLineNum++;
        oldLineNum++; 
      }
      bgColor = '#0a0a0a';
      fgColor = '#D1D5DB';
      lineNumColor = '#555555';
      if (line.startsWith(' ')) {
        displayLine = line.substring(1);
      }
      linePrefix = '  ';
    }

    const numStr = String(currentLineNum).padStart(3, ' ');
    const maxContentLen = diffWidth - 7; // 3 for num, 1 space, 2 for prefix, 1 space pad
    
    const subLines: string[] = [];
    let current = displayLine;
    while (current.length > maxContentLen) {
      subLines.push(current.substring(0, maxContentLen));
      current = current.substring(maxContentLen);
    }
    if (current.length > 0 || subLines.length === 0) {
      subLines.push(current);
    }

    let charOffset = 0;
    subLines.forEach((sl, idx) => {
      const isFirst = idx === 0;
      const numPart = isFirst ? chalk.hex(lineNumColor)(numStr + ' ') : '    ';
      const prefixPart = isFirst ? chalk.hex(lineNumColor)(linePrefix) : '  ';
      
      let styledSl = '';
      if (highlightRanges.length > 0) {
        for (let c = 0; c < sl.length; c++) {
          const globalIdx = charOffset + c;
          const hRange = highlightRanges.find(r => globalIdx >= r.start && globalIdx < r.end);
          if (hRange) {
             styledSl += chalk.bgHex(hRange.bg).hex(hRange.fg)(sl[c]);
          } else {
             styledSl += chalk.hex(fgColor)(sl[c]);
          }
        }
      } else {
        styledSl = chalk.hex(fgColor)(sl);
      }
      charOffset += sl.length;
      
      const visibleLen = 4 + 2 + sl.length; 
      const padLen = Math.max(0, diffWidth - visibleLen);
      
      const styledLine = numPart + prefixPart + styledSl + ' '.repeat(padLen);
      output += chalk.bgHex(bgColor)(styledLine) + '\n';
    });
  }
  return output + '\n';
}

export function renderMarkdownWithOttoStyles(content: string, width: number, diffsExpanded: boolean): string {
  content = content.replace(/\r/g, '');
  // Fix for **bold** text in markdown not rendering properly with marked-terminal
  content = content.replace(/\*\*(.+?)\*\*/g, (_m, p1) => chalk.white.bold(p1));
  
  // Strip markdown heading hashes and format them directly since marked-terminal keeps them
  content = content.replace(/^(#{1,6})\s+(.+)$/gm, (_m, hashes, text) => {
    return chalk.hex('#f5c542').bold(text);
  });

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
          output += chalk.bgHex('#0F172A').hex('#CBD5E1')(padVisible(` ${line}`, diffWidth)) + '\n';
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
    heading: chalk.white.bold
  }) as any);

  const parsed = myMarked.parse(withPlaceholders) as string;
  return parsed.replace(/\u0000DIFF(\d+)\u0000/g, (_m, idx) => placeholders[Number(idx)]);
}

export class ChatUI {
  public W = 72;
  public compact = false;
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
    approvalMenuIndex: number = 0,
    securityMode: string = 'ask',
    autocompleteState: any = null
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
      approvalMenuIndex,
      securityMode,
      autocompleteState
    };
    this.notify();
  }

  drawToString(): string {
    return '';
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

export function ChatUIInput({ chatUI }: { chatUI: ChatUI }) {
  useInput((input, key) => {
    const handler = chatUI.getKeyHandler();
    if (handler) {
      const translatedKey = translateInkKey(input, key);
      handler(input, translatedKey);
    }
  });
  return null;
}


// ── INK COMPONENTS ── //

export function ChatUIApp({ chatUI }: { chatUI: ChatUI }) {
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    return chatUI.subscribe(() => forceUpdate(prev => prev + 1));
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

  if (!chatUI.currentData) return <Box><Text>Loading...</Text></Box>;

  return (
    <ThemeProvider>
      <SessionProvider externalState={chatUI.currentData}>
        <DialogProvider>
          <SessionView chatUI={chatUI} />
          <DialogRenderer />
          {!!(process.stdin && process.stdin.isTTY) && <ChatUIInput chatUI={chatUI} />}
        </DialogProvider>
      </SessionProvider>
    </ThemeProvider>
  );
}