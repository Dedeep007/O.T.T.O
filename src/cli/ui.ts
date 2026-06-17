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
  
  clearScreen: () => {
    // Soft clear (move to 0,0 and clear down) to prevent glitch scrolling during live streams
    process.stdout.write('\x1B[0;0H\x1B[J');
  },

  osHeader: (provider: string, threadId: string, securityMode: string) => {
    const width = 60;
    const line = chalk.yellow('+' + '-'.repeat(width - 2) + '+');
    
    console.log(line);
    console.log(chalk.yellow('|') + chalk.bold.cyan(' O.T.T.O MASTER CONTROL TERMINAL '.padEnd(width - 2)) + chalk.yellow('|'));
    console.log(line);
    console.log(chalk.yellow('|') + ` Provider: ${chalk.green(provider)}`.padEnd(width + 7) /* +7 for chalk ansi chars */ + chalk.yellow('|'));
    console.log(chalk.yellow('|') + ` Thread:   ${chalk.blue(threadId)}`.padEnd(width + 7) + chalk.yellow('|'));
    console.log(chalk.yellow('|') + ` Security: ${chalk.magenta(securityMode)}`.padEnd(width + 7) + chalk.yellow('|'));
    console.log(line);
    console.log();
  },

  renderContextBar: (stats: { max: number; filled: number; compressed: number }) => {
    const width = 40;
    const filledRatio = Math.min(stats.filled / stats.max, 1);
    const filledCols = Math.floor(filledRatio * width);
    const emptyCols = width - filledCols;
    
    // Colorful gradient for the bar based on how full it is
    let barColor = chalk.green;
    if (filledRatio > 0.6) barColor = chalk.yellow;
    if (filledRatio > 0.85) barColor = chalk.red;

    const bar = barColor('█'.repeat(filledCols)) + chalk.dim('░'.repeat(emptyCols));
    const percent = Math.round(filledRatio * 100);
    
    const compressedInfo = stats.compressed > 0 
      ? ` | ${chalk.magenta('▼ Compressed:')} ${chalk.bold(stats.compressed)} tokens` 
      : '';

    console.log(` ${chalk.bold('Memory Budget:')} [${bar}] ${percent}% (${stats.filled}/${stats.max})${compressedInfo}\n`);
  },

  header: (text: string) => {
    const width = Math.max(text.length + 4, 30);
    console.log(chalk.yellow.bold('┌' + '─'.repeat(width - 2) + '┐'));
    console.log(chalk.yellow.bold('│ ') + chalk.whiteBright.bold(text.padEnd(width - 4)) + chalk.yellow.bold(' │'));
    console.log(chalk.yellow.bold('└' + '─'.repeat(width - 2) + '┘'));
  },

  alert: (text: string) => {
    console.log(chalk.yellow(`[!] ${text}`));
  },

  warning: (text: string) => {
    console.log(chalk.yellow.inverse(` WARNING `) + chalk.yellow(` ${text}`));
  },

  info: (text: string) => {
    console.log(chalk.blue(`[i] ${text}`));
  },

  success: (text: string) => {
    console.log(chalk.green(`[✓] ${text}`));
  },

  error: (text: string) => {
    console.log(chalk.red.bold(`[X] ERROR: `) + chalk.red(text));
  },

  renderMarkdown: (markdownString: string) => {
    // marked.parse returns a string, we print it directly.
    const rendered = marked.parse(markdownString) as string;
    console.log(rendered);
  },

  printPrompt: (machineInfo: string) => {
    // e.g. OTTO://[session-07]👤 user@host:~/workspace$
    process.stdout.write(chalk.yellow(`OTTO://${machineInfo}$ `));
  }
};
