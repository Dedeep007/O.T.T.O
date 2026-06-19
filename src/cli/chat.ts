import chalk from 'chalk';
import { marked } from 'marked';
import TerminalRenderer from 'marked-terminal';
import fs from 'fs';

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
  // Explicit overrides for characters commonly mismeasured in CLI terminals
  if (codePoint === 0x25B6) { // ▶ (black right-pointing triangle)
    return 2;
  }
  if (codePoint === 0x270F) { // ✏ (pencil)
    return 1;
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

function ansiRgb(fg: string, bg: string, text: string): string {
  const hexToRgb = (hex: string) => {
    const clean = hex.replace('#', '');
    return [
      parseInt(clean.slice(0, 2), 16),
      parseInt(clean.slice(2, 4), 16),
      parseInt(clean.slice(4, 6), 16)
    ];
  };
  const [fr, fgGreen, fb] = hexToRgb(fg);
  const [br, bgGreen, bb] = hexToRgb(bg);
  return `\x1B[38;2;${fr};${fgGreen};${fb}m\x1B[48;2;${br};${bgGreen};${bb}m${text}\x1B[0m`;
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

  // Pre-extract diff code fences so marked never touches the ANSI-colored rows
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

  // Splice diff renders back in
  return parsed.replace(/\u0000DIFF(\d+)\u0000/g, (_m, idx) => placeholders[Number(idx)]);
}

export class ChatUI {
  private W = 72;
  private lastLineCount = 0;

  // ── Internal scroller state ───────────────────────────────────────────────
  // scrollOffset = 0  → show bottom (most recent) of content
  // scrollOffset = N  → show content N lines above the bottom
  private scrollOffset = 0;
  private totalContentLines = 0;

  private BRAND = chalk.hex('#F5C400');
  private DIM   = chalk.hex('#374151');
  private MUTED = chalk.hex('#6B7280');
  private AI_TAG = this.BRAND.bold;

  /** Scroll up (toward older messages) by n lines */
  scrollUp(n = 3) {
    const viewH = Math.max(1, (process.stdout.rows || 24) - 1);
    const max   = Math.max(0, this.totalContentLines - viewH);
    this.scrollOffset = Math.min(this.scrollOffset + n, max);
  }

  /** Scroll down (toward newer messages) by n lines */
  scrollDown(n = 3) {
    this.scrollOffset = Math.max(0, this.scrollOffset - n);
  }

  /** Snap to the very bottom (newest content) */
  scrollToBottom() {
    this.scrollOffset = 0;
  }

  /** True when the viewport is already pinned to the bottom */
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
    delayMessage?: string
  ) {
    // ── 1. Build the FULL content buffer ─────────────────────────────────────
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
    push('');

    messages.forEach(msg => {
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
          
          thinkLines.forEach(line => {
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
          // ── Detect and render plan block with special styling ──
          const PLAN_RE = /<!--\s*PLAN_START\s*-->([\s\S]*?)<!--\s*PLAN_END\s*-->/;
          const planMatch = rawContent.match(PLAN_RE);

          if (planMatch) {
            // Render everything before the plan normally
            const beforePlan = rawContent.slice(0, rawContent.indexOf('<!-- PLAN_START')).trim();
            if (beforePlan) {
              const rendered = renderMarkdownWithOttoStyles(beforePlan, this.W - 4, diffsExpanded);
              rendered.trim().split('\n').forEach(line => push('  ' + line));
              push('');
            }

            // Render the plan block as a styled box
            const planContent = planMatch[1].trim();
            const planWidth = Math.min(this.W - 6, 86);  // inner content width
            const boxBorder = chalk.hex('#F5C400');
            const stepColor = chalk.hex('#22D3EE');
            const fileColor = chalk.hex('#86EFAC');

            // ANSI-aware box row: pads styled string to planWidth using visible length
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

            planContent.split('\n').forEach(line => {
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

            push('  ' + boxBorder('╠' + '═'.repeat(planWidth) + '╣'));
            const footerText = chalk.hex('#4ADE80').bold(' \u2705 y to approve') +
              chalk.hex('#6B7280')('  |  ') +
              chalk.hex('#F87171').bold('\u274C n to cancel');
            push(boxRow(footerText, '#0c1a0c'));
            push('  ' + boxBorder('╚' + '═'.repeat(planWidth) + '╝'));
            push('');

            // Render everything after the plan normally
            const afterPlan = rawContent.slice(rawContent.indexOf('<!-- PLAN_END -->') + '<!-- PLAN_END -->'.length).trim();
            if (afterPlan) {
              const rendered = renderMarkdownWithOttoStyles(afterPlan, this.W - 4, diffsExpanded);
              rendered.trim().split('\n').forEach(line => push('  ' + line));
            }
          } else {
            // No plan, render entire content
            let processedContent = rawContent;
            processedContent = processedContent.replace(/^[*\s]*\u25cf\s*([A-Za-z_]+)\(([^)]*)\)/gm, (_match, tool, args) => {
              return chalk.dim('/- ') + chalk.white.bold(tool) + chalk.dim('(' + args + ')');
            });
            processedContent = processedContent.replace(/^[*\s]*\u2514\s*(.*)/gm, (_match, details) => {
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

    // ── Plan approval menu (rendered above separator when pending) ──────────
    if (pendingPlan) {
      const menuWidth = Math.min(this.W - 6, 60);
      const border    = chalk.hex('#F5C400');
      const menuItems = [
        { label: '\u2705  Approve \u2014 execute the plan',    color: chalk.hex('#4ADE80') },
        { label: '\u270f\ufe0f   Edit \u2014 request changes first', color: chalk.hex('#FBBF24') },
        { label: '\u274c  Cancel \u2014 do not proceed',       color: chalk.hex('#F87171') },
      ];

      const totalInnerWidth = menuWidth + 2;
      push('  ' + border('\u2500'.repeat(totalInnerWidth + 2)));
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
        push('  ' + border('\u2502') + cursor + label + border('\u2502'));
      });
      push('  ' + border('\u2500'.repeat(totalInnerWidth + 2)));
      push('');
    }

    push(this.DIM('-'.repeat(this.W)));

    // ── 2. Compute viewport slice ─────────────────────────────────────────────
    if (this.totalContentLines > 0 && this.scrollOffset > 0) {
      const deltaLines = lines.length - this.totalContentLines;
      if (deltaLines > 0) {
        this.scrollOffset += deltaLines;
      }
    }
    this.totalContentLines = lines.length;

    const viewH     = Math.max(1, (process.stdout.rows || 24) - 1); // leave 1 row for prompt
    const maxOffset = Math.max(0, lines.length - viewH);
    // clamp scrollOffset so it can't exceed content
    this.scrollOffset = Math.min(this.scrollOffset, maxOffset);

    // viewStart: index into lines[] of the first visible line
    // scrollOffset=0 → viewStart = maxOffset (bottom)
    // scrollOffset=maxOffset → viewStart = 0 (top)
    const viewStart = maxOffset - this.scrollOffset;
    const visible   = lines.slice(viewStart, viewStart + viewH);

    // ── 3. Overlay scroll indicators (replace first/last visible line) ────────
    const linesAbove = viewStart;                    // lines not visible above
    const linesBelow = this.scrollOffset;            // lines not visible below

    if (linesAbove > 0 && visible.length > 0) {
      visible[0] = this.MUTED(
        `  ↑ ${linesAbove} line${linesAbove !== 1 ? 's' : ''} above` +
        chalk.hex('#4B5563')('  (↑/↓ scroll  PgUp/PgDn page  End to snap)')
      );
    }
    if (linesBelow > 0 && visible.length > 1) {
      visible[visible.length - 1] = this.MUTED(`  ↓ ${linesBelow} line${linesBelow !== 1 ? 's' : ''} below`);
    }

    // ── 4. Write viewport to terminal (overwrite in place) ────────────────────
    process.stdout.write('\x1B[H');

    for (const line of visible) {
      process.stdout.write(line + '\x1B[K\n');
    }

    // Erase leftover rows from a previous taller render
    const leftover = this.lastLineCount - visible.length;
    for (let i = 0; i < leftover; i++) {
      process.stdout.write('\x1B[2K\n');
    }
    this.lastLineCount = visible.length;

    // ── 5. Prompt row ─────────────────────────────────────────────────────────
    const promptPrefix = '  ' + this.BRAND('>') + ' ';
    const scrollHint   = linesBelow > 0
      ? this.MUTED('  [scrolled \u2014 End to return]')
      : '';
    let placeholder = '';
    if (currentInput.length === 0) {
      placeholder = pendingPlan
          ? chalk.hex('#F5C400')('\u2191\u2193 choose  \u21b5 confirm')
          : this.MUTED('Type your message... (esc to menu)');
    } else if (currentInput.endsWith('@')) {
      try {
        const entries = fs.readdirSync(process.cwd(), { withFileTypes: true })
          .filter((e: any) => !e.name.startsWith('.') && e.name !== 'node_modules')
          .map((e: any) => e.isDirectory() ? e.name + '/' : e.name);
        if (entries.length > 0) {
          placeholder = this.MUTED('  [Recs: ' + entries.slice(0, 5).join(', ') + (entries.length > 5 ? '...' : '') + ']');
        }
      } catch (e) {}
    }
    process.stdout.write('\x1B[2K\r' + promptPrefix + chalk.white(currentInput) + placeholder + scrollHint);
  }
}
