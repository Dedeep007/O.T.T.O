import chalk from 'chalk';
import { marked } from 'marked';
import TerminalRenderer from 'marked-terminal';

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

function padVisible(str: string, width: number): string {
  return str + ' '.repeat(Math.max(0, width - stripAnsi(str).length));
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

function renderDiffBlock(codeStr: string, diffWidth: number): string {
  let output = '\n';

  const bar = (bg: string, fg: string) => chalk.bgHex(bg).hex(fg)('  ');
  const row = (bg: string, fg: string, text: string) =>
    chalk.bgHex(bg).hex(fg)(padVisible(` ${text}`, diffWidth - 2));

  codeStr.split('\n').forEach(line => {
    if (line.startsWith('+++') || line.startsWith('---')) {
      output += chalk.bgHex('#1E293B').hex('#CBD5E1')(padVisible(` ${line}`, diffWidth)) + '\n';
    } else if (line.startsWith('@@')) {
      output += chalk.bgHex('#0C4A6E').hex('#67E8F9')(padVisible(` ${line}`, diffWidth)) + '\n';
    } else if (line.startsWith('+')) {
      output += bar('#16A34A', '#052e16') + row('#15803D', '#F0FDF4', line) + '\n';
    } else if (line.startsWith('-')) {
      output += bar('#DC2626', '#450a0a') + row('#B91C1C', '#FFF1F2', line) + '\n';
    } else {
      output += chalk.bgHex('#0F172A').hex('#94A3B8')(padVisible(` ${line}`, diffWidth)) + '\n';
    }
  });
  return output + '\n';
}

function renderMarkdownWithOttoStyles(content: string, width: number): string {
  const diffWidth = Math.max(48, Math.min(width, 96));

  // Pre-extract diff code fences so marked never touches the ANSI-colored rows
  const placeholders: string[] = [];
  const withPlaceholders = content.replace(
    /```diff\n([\s\S]*?)```/g,
    (_match, codeStr: string) => {
      const rendered = renderDiffBlock(codeStr, diffWidth);
      const key = `\u0000DIFF${placeholders.length}\u0000`;
      placeholders.push(rendered);
      return key;
    }
  );

  class CustomRenderer extends TerminalRenderer {}

  marked.setOptions({
    renderer: new CustomRenderer({
      width,
      reflowText: true,
      codespan: chalk.hex('#F5C400'),
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
    pendingPlan: boolean = false
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
        const rendered = renderMarkdownWithOttoStyles(msg.content, this.W - 4);
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

        push('  ' + this.MUTED('|-- ') + chalk.hex('#A78BFA')('Reasoning Process'));
        thinkStr.split('\n').forEach(line => {
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

        if (msg.content.includes('<think>') && !msg.content.includes('</think>')) {
          push('  ' + this.MUTED('| ') + chalk.hex('#A78BFA')('...'));
        }

        push('  ' + this.MUTED('`--'));
        push('');
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
              const rendered = renderMarkdownWithOttoStyles(beforePlan, this.W - 4);
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
              const visLen = stripAnsi(styledContent).length;
              const pad = ' '.repeat(Math.max(0, planWidth - visLen));
              const inner = bgHex
                ? chalk.bgHex(bgHex)(styledContent + pad)
                : styledContent + pad;
              return '  ' + boxBorder('║') + inner + boxBorder('║');
            };

            push('  ' + boxBorder('╔' + '═'.repeat(planWidth) + '╗'));
            push(boxRow(chalk.hex('#F5C400').bold(' \uD83D\uDCCB IMPLEMENTATION PLAN '), '#1a1200'));
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
              const rendered = renderMarkdownWithOttoStyles(afterPlan, this.W - 4);
              rendered.trim().split('\n').forEach(line => push('  ' + line));
            }
          } else {
            // No plan block — normal rendering
            let processedContent = rawContent;
            processedContent = processedContent.replace(/^[*\s]*\u25cf\s*([A-Za-z_]+)\(([^)]*)\)/gm, (_match, tool, args) => {
              return chalk.dim('/- ') + chalk.white.bold(tool) + chalk.dim('(' + args + ')');
            });
            processedContent = processedContent.replace(/^[*\s]*\u2514\s*(.*)/gm, (_match, details) => {
              return chalk.dim('\\- ' + details);
            });

            const rendered = renderMarkdownWithOttoStyles(processedContent, this.W - 4);
            rendered.trim().split('\n').forEach(line => push('  ' + line));
          }
        }
      }

      push('');
    });

    if (isThinking) {
      const dots = '.'.repeat((Math.floor(Date.now() / 350) % 3) + 1);
      push(this.AI_TAG('  O.T.T.O'));
      push('  ' + chalk.hex('#A78BFA')(`thinking${dots}`));
      push('');
    }

    push(this.DIM('-'.repeat(this.W)));

    // ── 2. Compute viewport slice ─────────────────────────────────────────────
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
      ? this.MUTED('  [scrolled — End to return]')
      : '';
    const placeholder  = currentInput.length === 0
      ? (pendingPlan
          ? chalk.hex('#4ADE80').bold('⏳ Awaiting approval — type y to proceed or n to cancel')
          : this.MUTED('Type your message... (esc to menu)'))
      : '';
    process.stdout.write('\x1B[2K\r' + promptPrefix + chalk.white(currentInput) + placeholder + scrollHint);
  }
}
