import chalk from 'chalk';
import { marked } from 'marked';
import TerminalRenderer from 'marked-terminal';

// Configure marked to use the terminal renderer
marked.setOptions({
  renderer: new TerminalRenderer({
    // Customize styles if needed, but defaults are usually fine
    // We want yellow accent color
    firstHeading: chalk.yellow.bold,
    heading: chalk.yellow.bold,
    strong: chalk.bold,
    em: chalk.italic,
    codespan: chalk.yellow,
    del: chalk.dim.strikethrough,
    link: chalk.blue,
    href: chalk.blue.underline,
  }) as any,
});

export const ui = {
  accent: chalk.yellow,
  tuiActive: false,
  onTuiMessage: null as ((type: 'success' | 'info' | 'error' | 'warning' | 'alert', text: string, timeoutMs?: number) => void) | null,
  
  clearScreen: () => {
    // Soft clear (move to 0,0 and clear down) to prevent glitch scrolling during live streams
    process.stdout.write('\x1B[0;0H\x1B[J');
  },

  osHeader: (provider: string, threadId: string, securityMode: string) => {
    const width = Math.max(40, Math.min(process.stdout.columns || 60, 60));
    const GOLD = chalk.hex('#F5C400');
    const bgTitle = chalk.bgHex('#F5C400').black.bold;
    
    const top = GOLD('╭' + '─'.repeat(width - 2) + '╮');
    const bottom = GOLD('╰' + '─'.repeat(width - 2) + '╯');

    const row = (label: string, value: string, colorFn: (s: string) => string) => {
      const plain = ` ${label}${value}`;
      const pad = Math.max(0, width - 2 - plain.length);
      return GOLD('│') + ` ${chalk.hex('#94A3B8')(label)}${colorFn(value)}` + ' '.repeat(pad) + GOLD('│');
    };

    const title = ' O.T.T.O MASTER CONTROL TERMINAL ';
    const titlePad = Math.max(0, width - 2 - title.length);

    console.log(top);
    console.log(GOLD('│') + bgTitle(title) + ' '.repeat(titlePad) + GOLD('│'));
    console.log(row('Provider: ', provider, chalk.hex('#22D3EE').bold));
    console.log(row('Thread:   ', threadId, chalk.hex('#A78BFA').bold));
    console.log(row('Security: ', securityMode, chalk.hex('#F43F5E').bold));
    console.log(bottom);
    console.log();
  },

  renderContextBar: (stats: { max: number; filled: number; compressed: number }) => {
    const width = 40;
    const filledRatio = Math.min(stats.filled / stats.max, 1);
    const filledCols = Math.floor(filledRatio * width);
    const emptyCols = width - filledCols;
    
    let barColor = chalk.hex('#34D399');
    if (filledRatio > 0.6) barColor = chalk.hex('#FBBF24');
    if (filledRatio > 0.85) barColor = chalk.hex('#F87171');

    const bar = barColor('▰'.repeat(filledCols)) + chalk.hex('#334155')('▱'.repeat(emptyCols));
    const percent = Math.round(filledRatio * 100);
    
    const compressedInfo = stats.compressed > 0 
      ? ` | ${chalk.hex('#C084FC')('▼ Compressed:')} ${chalk.white.bold(stats.compressed)} tokens` 
      : '';

    console.log(` ${chalk.hex('#F5C400').bold('Memory Budget:')} [${bar}] ${chalk.white(percent + '%')} ${chalk.hex('#94A3B8')('(' + stats.filled + '/' + stats.max + ')')}${compressedInfo}\n`);
  },

  header: (text: string) => {
    const maxW = Math.max(30, (process.stdout.columns || 80) - 2);
    const width = Math.min(Math.max(text.length + 4, 30), maxW);
    const truncated = text.length > width - 4 ? text.slice(0, Math.max(0, width - 7)) + '...' : text;
    const GOLD = chalk.hex('#F5C400');
    console.log(GOLD.bold('╭' + '─'.repeat(width - 2) + '╮'));
    console.log(GOLD.bold('│ ') + chalk.whiteBright.bold(truncated.padEnd(width - 4)) + GOLD.bold(' │'));
    console.log(GOLD.bold('╰' + '─'.repeat(width - 2) + '╯'));
  },

  alert: (text: string) => {
    if (ui.tuiActive) {
      if (ui.onTuiMessage) ui.onTuiMessage('alert', text);
    } else {
      console.log(chalk.bgHex('#581C87').hex('#E9D5FF').bold(` 🔔 ${text} `));
    }
  },

  warning: (text: string, timeoutMs?: number) => {
    if (ui.tuiActive) {
      if (ui.onTuiMessage) ui.onTuiMessage('warning', text, timeoutMs);
    } else {
      console.log(chalk.bgHex('#78350F').hex('#FDE68A').bold(` ⚠ ${text} `));
    }
  },

  info: (text: string) => {
    if (ui.tuiActive) {
      if (ui.onTuiMessage) ui.onTuiMessage('info', text);
    } else {
      console.log(chalk.bgHex('#1E3A8A').hex('#BFDBFE').bold(` ℹ ${text} `));
    }
  },

  success: (text: string) => {
    if (ui.tuiActive) {
      if (ui.onTuiMessage) ui.onTuiMessage('success', text);
    } else {
      console.log(chalk.bgHex('#064E3B').hex('#A7F3D0').bold(` ✓ ${text} `));
    }
  },

  error: (text: string) => {
    if (ui.tuiActive) {
      if (ui.onTuiMessage) ui.onTuiMessage('error', text);
    } else {
      console.log(chalk.bgHex('#7F1D1D').hex('#FECACA').bold(` ✘ ERROR `) + chalk.hex('#FCA5A5')(` ${text}`));
    }
  },

  renderMarkdown: (markdownString: string) => {
    const rendered = marked.parse(markdownString) as string;
    console.log(rendered);
  },

  printPrompt: (machineInfo: string) => {
    process.stdout.write(chalk.hex('#F5C400').bold(`OTTO://${machineInfo}`) + chalk.hex('#94A3B8')('$ '));
  }
};