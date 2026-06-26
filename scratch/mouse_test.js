import readline from 'readline';

readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) process.stdin.setRawMode(true);

process.stdout.write('\x1B[?1000h\x1B[?1006h'); // Enable mouse tracking

console.log('Click somewhere! Press q to quit.');

const onData = (data) => {
  const str = data.toString();
  if (str === 'q') {
    process.stdout.write('\x1B[?1000l\x1B[?1006l'); // Disable mouse
    process.exit(0);
  }
  
  const mouseMatch = str.match(/\x1B\[<(\d+);(\d+);(\d+)([mM])/);
  if (mouseMatch) {
    const btn = mouseMatch[1];
    const x = mouseMatch[2];
    const y = mouseMatch[3];
    const state = mouseMatch[4] === 'M' ? 'pressed' : 'released';
    console.log(`Mouse event: btn=${btn} x=${x} y=${y} state=${state}`);
  }
};

process.stdin.on('data', onData);
