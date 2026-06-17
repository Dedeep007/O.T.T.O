import * as readline from 'readline';
import chalk from 'chalk';

export async function promptWithEscape(message: string, initialValue: string = ''): Promise<string | null> {
  return new Promise((resolve) => {
    readline.emitKeypressEvents(process.stdin);
    const wasRaw = !!process.stdin.isRaw;
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();

    let value = initialValue;

    const render = () => {
      process.stdout.write('\x1B[0;0H\x1B[J');
      process.stdout.write(chalk.yellow(`${message} `) + chalk.white(value));
      process.stdout.write(chalk.dim('\n\nEsc to cancel, Enter to confirm'));
    };

    const cleanup = (result: string | null) => {
      process.stdin.removeListener('keypress', onKeypress);
      if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw);
      process.stdout.write('\x1B[0;0H\x1B[J');
      resolve(result);
    };

    const onKeypress = (str: string, key: any) => {
      if (key.ctrl && key.name === 'c') {
        cleanup(null);
        return;
      }
      if (key.name === 'escape') {
        cleanup(null);
        return;
      }
      if (key.name === 'return') {
        cleanup(value);
        return;
      }
      if (key.name === 'backspace') {
        value = value.slice(0, -1);
        render();
        return;
      }
      if (str && !key.ctrl && !key.meta) {
        value += str;
        render();
      }
    };

    process.stdin.on('keypress', onKeypress);
    render();
  });
}
