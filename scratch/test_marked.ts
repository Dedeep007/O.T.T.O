import { Marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import chalk from 'chalk';

const myMarked = new Marked();
myMarked.use(markedTerminal({
  strong: chalk.white.bold,
  em: chalk.italic
}));

console.log(myMarked.parse('Here is some **bold** text.'));
