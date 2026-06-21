import chalk from 'chalk';

const stepColor = chalk.hex('#22D3EE');
const stripped = '1. **Restart the Server**: then do **this**.';

const formattedLine = stripped.replace(/\*\*(.*?)\*\*/g, (_m, p1) => chalk.white.bold(p1));
const styledText = stepColor(formattedLine);

console.log(styledText);
