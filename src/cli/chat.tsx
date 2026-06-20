import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import chalk from 'chalk';
import { marked } from 'marked';
import TerminalRenderer from 'marked-terminal';
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
  const words = text.split(' ');
  const lines: string[] = [];
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
  return lines;
}

function renderDiffBlock(codeStr: string, diffWidth: number, isExpanded: boolean): string {
  let output = '\n';

  const bar = (bg: string) => chalk.bgHex(bg)('  ');
  const row = (bg: string, fg: string, text: string) =>
    chalk.bgHex(bg).hex(fg)(padVisible(` ${text}`, diffWidth - 2));

  const allLines = codeStr.split('\n');
  const total = allLines.length;

  let toRender = allLines;
  if (!isExpanded && total > 15) {
    const top = allLines.slice(0, 7);
    const bottom = allLines.slice(total - 3);
    toRender = [...top, `... (${total - 10} hidden lines) [Press Ctrl+E to Expand] ...`, ...bottom];
  }

  toRender.forEach(line => {
    if (line.startsWith('+++') || line.startsWith('---')) {
      output += chalk.bgHex('#1E293B').hex('#CBD5E1')(padVisible(` ${line}`, diffWidth)) + '\n';
    } else if (line.startsWith('@@')) {
      output += chalk.bgHex('#0C4A6E').hex('#67E8F9')(padVisible(` ${line}`, diffWidth)) + '\n';
    } else if (line.startsWith('+')) {
      output += bar('#22C55E') + row('#14532D', '#BBF7D0', line) + '\n';
    } else if (line.startsWith('-')) {
      output += bar('#EF4444') + row('#7F1D1D', '#FECACA', line) + '\n';
    } else if (line.startsWith('... (')) {
      output += chalk.bgHex('#374151').hex('#FBBF24')(padVisible(` ${line}`, diffWidth)) + '\n';
    } else {
      output += chalk.bgHex('#0F172A').hex('#94A3B8')(padVisible(` ${line}`, diffWidth)) + '\n';
    }
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
          output += chalk.bgHex('#0F172A').hex('#CBD5E1')(padVisible(` ${line}`, diffWidth)) + '\n';
        });

        const key = `\u0000DIFF${placeholders.length}\u0000`;
        placeholders.push(output + '\n');
        return key;
      }
    }
  );

  class CustomRenderer extends TerminalRenderer {}

  marked.setOptions({
    renderer: new CustomRenderer({
      width,
      reflowText: true,
      codespan: chalk.hex('#F5C400'),
      strong: chalk.white.bold,
      em: chalk.italic,
    }) as any
  });

  const parsed = marked.parse(withPlaceholders) as string;
  return parsed.replace(/\u0000DIFF(\d+)\u0000/g, (_m, idx) => placeholders[Number(idx)]);
}

export class ChatUI {
  public W = 72;
  public lastLineCount = 0;
  public scrollOffset = 0;
  public totalContentLines = 0;
  public notification: string = '';
  private notificationTimeout?: NodeJS.Timeout;

  private BRAND = chalk.hex('#F5C400');
  private DIM   = chalk.hex('#374151');
  private MUTED = chalk.hex('#6B7280');
  private AI_TAG = this.BRAND.bold;

  private listeners: (() => void)[] = [];
  public currentData: any = null;
  private keyHandler?: (str: string, key: any) => void;

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
    const push = (line: string = '') => lines.push(line);

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
      push('  ' + chalk.bgHex('#1F2937').hex('#10B981').bold(`  ✓ ${this.notification}  `));
      push('');
    } else {
      push('');
    }

    messages.forEach((msg: any) => {
      if (msg.role === 'system') {
        push('  ' + chalk.bgHex('#374151').white(' SYSTEM ') + ' ' + this.MUTED(msg.content));
        push('');
        return;
      }

      if (msg.role === 'tool') {
        push('  ' + chalk.bgHex('#1F2937').white.bold(' TOOL '));
        const rendered = renderMarkdownWithOttoStyles(msg.content, this.W - 4, diffsExpanded);
        rendered.trim().split('\n').forEach(line => push('  ' + line));
        push('');
        return;
      }

      const header = msg.role === 'user'
        ? '  ' + chalk.bgHex('#374151').white.bold(' YOU ')
        : this.AI_TAG('  O.T.T.O');
      push(header);

      let rawContent = msg.content;

      const thinkMatch = rawContent.match(/<think>([\s\S]*?)(?:<\/think>|$)/);
      if (thinkMatch) {
        const thinkStr = thinkMatch[1].trim();
        rawContent = rawContent.replace(/<think>[\s\S]*?(?:<\/think>|$)/, '').trim();

        const thinkLines = thinkStr.split('\n');
        const total = thinkLines.length;

        if (!diffsExpanded) {
          push('  ' + chalk.hex('#A78BFA')(`🧠  Reasoning Process (${total} lines) [Press Ctrl+E to Expand]`));
          push('');
        } else {
          push('  ' + this.MUTED('|-- ') + chalk.hex('#A78BFA')('Reasoning Process'));
          
          thinkLines.forEach((line: string) => {
            const formattedLine = line.trim()
              .replace(/^(#{1,6})\s+(.*)$/g, (_m, _p1, p2) => chalk.white.bold(p2))
              .replace(/^(\d+\.)\s+(.*)$/g, (_m, p1, p2) => chalk.white.bold(p1) + ' ' + p2)
              .replace(/^([*-])\s+(.*)$/g, (_m, p1, p2) => chalk.white.bold(p1) + ' ' + p2)
              .replace(/\*\*(.*?)\*\*/g, (_m, p1) => chalk.white.bold(p1))
              .replace(/\*(.*?)\*/g, (_m, p1) => chalk.white.italic(p1))
              .replace(/`(.*?)`/g, (_m, p1) => chalk.hex('#F5C400')(p1));

            const wrapped = wrapText(formattedLine, this.W - 5, 0);
            wrapped.forEach(wl => push('  ' + this.MUTED('| ') + this.MUTED(wl)));
          });

          push('  ' + this.MUTED('`--'));
          push('');
        }

        if (msg.content.includes('<think>') && !msg.content.includes('</think>')) {
          push('  ' + chalk.hex('#A78BFA')('  🧠  Thinking...'));
          push('');
        }
      }

      if (rawContent.trim()) {
        if (msg.role === 'user') {
          const wrappedLines = wrapText(rawContent, this.W, 2);
          wrappedLines.forEach(line => push(chalk.white(line)));
        } else {
          const PLAN_RE = /<!--\s*PLAN_START\s*-->([\s\S]*?)<!--\s*PLAN_END\s*-->/;
          const planMatch = rawContent.match(PLAN_RE);

          if (planMatch) {
            const beforePlan = rawContent.slice(0, rawContent.indexOf('<!-- PLAN_START')).trim();
            if (beforePlan) {
              const rendered = renderMarkdownWithOttoStyles(beforePlan, this.W - 4, diffsExpanded);
              rendered.trim().split('\n').forEach(line => push('  ' + line));
              push('');
            }

            const planContent = planMatch[1].trim();
            const planWidth = Math.min(this.W - 6, 86);
            const boxBorder = chalk.hex('#F5C400');
            const stepColor = chalk.hex('#22D3EE');
            const fileColor = chalk.hex('#86EFAC');

            const boxRow = (styledContent: string, bgHex?: string) => {
              const visLen = getStringWidth(styledContent);
              const pad = ' '.repeat(Math.max(0, planWidth - visLen));
              const inner = bgHex
                ? chalk.bgHex(bgHex)(styledContent + pad)
                : styledContent + pad;
              return '  ' + boxBorder('║') + inner + boxBorder('║');
            };

            push('  ' + boxBorder('╔' + '═'.repeat(planWidth) + '╗'));
            push(boxRow(chalk.hex('#F5C400').bold(' 📋 IMPLEMENTATION PLAN '), '#1a1200'));
            push('  ' + boxBorder('╠' + '═'.repeat(planWidth) + '╣'));

            planContent.split('\n').forEach((line: string) => {
              const stripped = line.trim();
              if (!stripped || stripped.startsWith('##')) return;

              let styledText: string;
              if (/^\d+\./.test(stripped)) {
                styledText = stepColor(' ' + stripped);
              } else if (stripped.startsWith('- `') || stripped.startsWith('- \\`')) {
                styledText = ' ' + fileColor(stripped);
              } else if (/^\*\*/.test(stripped)) {
                styledText = ' ' + chalk.white.bold(stripped.replace(/\*\*/g, ''));
              } else {
                styledText = ' ' + chalk.hex('#D1D5DB')(stripped);
              }

              const visibleText = stripAnsi(styledText);
              if (visibleText.length <= planWidth) {
                push(boxRow(styledText));
              } else {
                wrapText(visibleText.trim(), planWidth - 2, 0).forEach(wl => {
                  push(boxRow(' ' + chalk.hex('#D1D5DB')(wl.trim())));
                });
              }
            });


            push('  ' + boxBorder('╚' + '═'.repeat(planWidth) + '╝'));
            push('');

            const afterPlan = rawContent.slice(rawContent.indexOf('<!-- PLAN_END -->') + '<!-- PLAN_END -->'.length).trim();
            if (afterPlan) {
              const rendered = renderMarkdownWithOttoStyles(afterPlan, this.W - 4, diffsExpanded);
              rendered.trim().split('\n').forEach(line => push('  ' + line));
            }
          } else {
            let processedContent = rawContent;
            processedContent = processedContent.replace(/^[*\s]*\u25cf\s*([A-Za-z_]+)\(([^)]*)\)/gm, (_match: any, tool: any, args: any) => {
              return chalk.dim('/- ') + chalk.white.bold(tool) + chalk.dim('(' + args + ')');
            });
            processedContent = processedContent.replace(/^[*\s]*\u2514\s*(.*)/gm, (_match: any, details: any) => {
              return chalk.dim('\\- ' + details);
            });

            const rendered = renderMarkdownWithOttoStyles(processedContent, this.W - 4, diffsExpanded);
            rendered.trim().split('\n').forEach(line => push('  ' + line));
          }
        }
      }

      push('');
    });

    if (delayMessage) {
      const dots = '.'.repeat((Math.floor(Date.now() / 350) % 3) + 1);
      push(this.AI_TAG('  O.T.T.O'));
      push('  ' + chalk.hex('#FBBF24')(`${delayMessage}${dots}`));
      push('');
    } else if (isThinking) {
      const dots = '.'.repeat((Math.floor(Date.now() / 350) % 3) + 1);
      push(this.AI_TAG('  O.T.T.O'));
      push('  ' + chalk.hex('#A78BFA')(`thinking${dots}`));
      push('');
    }

    if (pendingApproval) {
      const menuWidth = Math.min(this.W - 6, 70);
      const border = chalk.hex('#FB7185');
      const titleColor = chalk.bgHex('#4C0519').hex('#FDA4AF');
      const totalInnerWidth = menuWidth + 2;
      
      const boxRow = (styledContent: string, bgHex?: string) => {
        const visLen = getStringWidth(styledContent);
        const pad = ' '.repeat(Math.max(0, totalInnerWidth - visLen));
        const inner = bgHex
          ? chalk.bgHex(bgHex)(styledContent + pad)
          : styledContent + pad;
        return '  ' + border('│') + inner + border('│');
      };

      push('  ' + border('┌' + '─'.repeat(totalInnerWidth) + '┐'));
      push(boxRow(titleColor.bold(' 🛡️  SECURITY APPROVAL REQUIRED '), '#4C0519'));
      push('  ' + border('├' + '─'.repeat(totalInnerWidth) + '┤'));
      
      const actionType = pendingApproval.type === 'app' ? 'launch application' : 'execute command';
      const promptText = `The agent wants to ${actionType}:`;
      push(boxRow(' ' + chalk.white(promptText)));
      
      const cmdStrWrapped = wrapText(pendingApproval.commandStr, totalInnerWidth - 4, 0);
      cmdStrWrapped.forEach(line => {
        push(boxRow('   ' + chalk.hex('#FDA4AF').bold(line.trim())));
      });
      
      push('  ' + border('├' + '─'.repeat(totalInnerWidth) + '┤'));

      const menuItems = [
        { label: 'Approve for now', color: chalk.hex('#4ADE80') },
        { label: `Approve always (whitelist '${pendingApproval.cmd}')`, color: chalk.hex('#38BDF8') },
        { label: 'Don\'t approve', color: chalk.hex('#F87171') },
      ];

      menuItems.forEach((item, idx) => {
        const isSelected = idx === approvalMenuIndex;
        const cursor = isSelected
          ? border.bold(' > ')
          : ' '.repeat(getStringWidth(' > '));
        const cursorWidth = getStringWidth(cursor);
        const paddedLabel = ansiPadEnd(item.label, totalInnerWidth - cursorWidth);
        const label = isSelected
          ? chalk.bgHex('#2E050E')(item.color.bold(paddedLabel))
          : chalk.hex('#9CA3AF')(paddedLabel);
        push('  ' + border('│') + cursor + label + border('│'));
      });
      
      push('  ' + border('└' + '─'.repeat(totalInnerWidth) + '┘'));
      push('');
    }

    if (pendingPlan) {
      const menuWidth = Math.min(this.W - 6, 60);
      const border    = chalk.hex('#F5C400');
      const menuItems = [
        { label: '\u2705  Approve - execute the plan',    color: chalk.hex('#4ADE80') },
        { label: '\u270f\ufe0f  Edit - request changes first', color: chalk.hex('#FBBF24') },
        { label: '\u274c  Cancel - do not proceed',       color: chalk.hex('#F87171') },
      ];

      const totalInnerWidth = menuWidth + 2;
      push('  ' + border('┌' + '─'.repeat(totalInnerWidth) + '┐'));
      menuItems.forEach((item, idx) => {
        const isSelected = idx === planMenuIndex;
        const cursor  = isSelected
          ? chalk.hex('#F5C400').bold(' \u25b6 ')
          : ' '.repeat(getStringWidth(' \u25b6 '));
        const cursorWidth = getStringWidth(cursor);
        const paddedLabel = ansiPadEnd(item.label, totalInnerWidth - cursorWidth);
        const label   = isSelected
          ? chalk.bgHex('#1a1200')(item.color.bold(paddedLabel))
          : chalk.hex('#6B7280')(paddedLabel);
        push('  ' + border('│') + cursor + label + border('│'));
      });
      push('  ' + border('└' + '─'.repeat(totalInnerWidth) + '┘'));
      push('');
    }

    push(this.DIM('-'.repeat(this.W)));

    // Viewport slicing
    if (this.totalContentLines > 0 && this.scrollOffset > 0) {
      const deltaLines = lines.length - this.totalContentLines;
      if (deltaLines > 0) {
        this.scrollOffset += deltaLines;
      }
    }
    this.totalContentLines = lines.length;

    const viewH     = Math.max(1, (process.stdout.rows || 24) - 1);
    const maxOffset = Math.max(0, lines.length - viewH);
    this.scrollOffset = Math.min(this.scrollOffset, maxOffset);

    const viewStart = maxOffset - this.scrollOffset;
    const visible   = lines.slice(viewStart, viewStart + viewH);

    const linesAbove = viewStart;
    const linesBelow = this.scrollOffset;

    if (linesAbove > 0 && visible.length > 0) {
      visible[0] = this.MUTED(
        `  ↑ ${linesAbove} line${linesAbove !== 1 ? 's' : ''} above` +
        chalk.hex('#4B5563')('  (↑/↓ scroll  PgUp/PgDn page  End to snap)')
      );
    }
    if (linesBelow > 0 && visible.length > 1) {
      visible[visible.length - 1] = this.MUTED(`  ↓ ${linesBelow} line${linesBelow !== 1 ? 's' : ''} below`);
    }

    let outStr = '';
    for (const line of visible) {
      outStr += line + '\x1B[K\n';
    }

    // Prompt line assembly
    const promptPrefix = '  ' + this.BRAND('>') + ' ';
    const scrollHint   = linesBelow > 0
      ? this.MUTED('  [scrolled \u2014 End to return]')
      : '';
    let placeholder = '';
    if (currentInput.length === 0) {
      if (pendingApproval) {
        placeholder = chalk.hex('#FB7185')('\u2191\u2193 choose  \u21b5 confirm');
      } else if (pendingPlan) {
        placeholder = chalk.hex('#F5C400')('\u2191\u2193 choose  \u21b5 confirm');
      } else {
        placeholder = this.MUTED('Type your message... (esc to menu)');
      }
    } else if (/[@][^\s]*$/.test(currentInput)) {
      try {
        const match = currentInput.match(/@([^\s]*)$/);
        const prefix = match ? match[1] : '';
        
        let dir = '.';
        let filePrefix = prefix;
        if (prefix.includes('/') || prefix.includes('\\')) {
          const normalized = prefix.replace(/\\/g, '/');
          const lastSlash = normalized.lastIndexOf('/');
          dir = prefix.slice(0, lastSlash);
          filePrefix = prefix.slice(lastSlash + 1);
        }
        
        const fullDir = path.resolve(process.cwd(), dir);
        if (fs.existsSync(fullDir) && fs.statSync(fullDir).isDirectory()) {
          const entries = fs.readdirSync(fullDir, { withFileTypes: true })
            .filter((e: any) => {
              if (e.name.startsWith('.') && !filePrefix.startsWith('.')) return false;
              if (e.name === 'node_modules') return false;
              return e.name.toLowerCase().startsWith(filePrefix.toLowerCase());
            })
            .map((e: any) => e.isDirectory() ? e.name + '/' : e.name);
            
          if (entries.length > 0) {
            placeholder = this.MUTED('  [Press Tab to cycle: ' + entries.slice(0, 5).join(', ') + (entries.length > 5 ? '...' : '') + ']');
          }
        }
      } catch (e) {}
    }

    let cursor = '';
    const isEditing = !isThinking && !pendingApproval && !pendingPlan && !delayMessage;
    if (isEditing) {
      cursor = chalk.hex('#F5C400')('█');
    }

    outStr += promptPrefix + chalk.white(currentInput) + cursor + placeholder + scrollHint;
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
