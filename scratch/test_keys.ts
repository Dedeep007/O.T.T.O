import readline from 'readline';

console.log("Press keys to see their representation. Press Ctrl+C to exit.");
readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}
process.stdin.resume();

process.stdin.on('keypress', (str, key) => {
  console.log(`str: ${JSON.stringify(str)}, key: ${JSON.stringify(key)}`);
  if (key.ctrl && key.name === 'c') {
    process.exit(0);
  }
});
