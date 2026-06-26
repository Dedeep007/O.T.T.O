import chalk from 'chalk';

function stripAnsi(str: string): string {
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}

function getCharWidth(char: string): number {
  const codePoint = char.codePointAt(0);
  if (!codePoint) return 0;
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

const menuItems = [
  { label: '\u2705  Approve \u2014 execute the plan' },
  { label: '\u270f\ufe0f   Edit \u2014 request changes first' },
  { label: '\u274c  Cancel \u2014 do not proceed' },
];

console.log("Widths of menu items:");
menuItems.forEach(item => {
  console.log(`${JSON.stringify(item.label)} -> width: ${getStringWidth(item.label)}`);
});

console.log("Width of cursor selected (\\u25b6):", getStringWidth(' \u25b6 '));
console.log("Width of cursor unselected:", getStringWidth('   '));

const footerText = ' \u2705 y to approve  |  \u274c n to cancel';
console.log("Footer text:", JSON.stringify(footerText), "-> width:", getStringWidth(footerText));
