import chalk from 'chalk';

function stripAnsi(str: string): string {
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}

function getCharWidth(char: string): number {
  const codePoint = char.codePointAt(0);
  if (!codePoint) return 0;
  if (codePoint === 0x25B6) { // ▶
    return 2;
  }
  if (codePoint === 0x270F) { // ✏
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

const menuWidth = 60;
const border = (s: string) => s;
const menuItems = [
  { label: '\u2705  Approve \u2014 execute the plan' },
  { label: '\u270f\ufe0f   Edit \u2014 request changes first' },
  { label: '\u274c  Cancel \u2014 do not proceed' },
];

const totalInnerWidth = menuWidth + 2;
console.log("Top/bottom border width:", getStringWidth('  ' + border('\u2500'.repeat(totalInnerWidth + 2))));

menuItems.forEach((item, idx) => {
  const isSelected = idx === 0;
  const cursor  = isSelected ? ' \u25b6 ' : ' '.repeat(getStringWidth(' \u25b6 '));
  const cursorWidth = getStringWidth(cursor);
  const paddedLabel = ansiPadEnd(item.label, totalInnerWidth - cursorWidth);
  const label   = paddedLabel;
  const line = '  ' + border('\u2502') + cursor + label + border('\u2502');
  console.log(`Item ${idx} line width: ${getStringWidth(line)}`);
});
