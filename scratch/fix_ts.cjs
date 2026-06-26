const fs = require('fs');
let file = 'src/cli/chat.tsx';
let code = fs.readFileSync(file, 'utf8');

// Fix Box with backgroundColor
code = code.replace(/<Box([^>]*) backgroundColor="([^"]+)"([^>]*)>/g, '<Box$1$3>');
code = code.replace(/<Box([^>]*) backgroundColor=\{([^}]+)\}([^>]*)>/g, '<Box$1$3>');
// Fix Text with marginBottom
code = code.replace(/<Text([^>]*) marginBottom=\{([0-9]+)\}([^>]*)>(.*?)<\/Text>/gs, '<Box marginBottom={$2}><Text$1$3>$4</Text></Box>');
// Fix Text with marginY
code = code.replace(/<Text([^>]*) marginY=\{([0-9]+)\}([^>]*)>(.*?)<\/Text>/gs, '<Box marginY={$2}><Text$1$3>$4</Text></Box>');

fs.writeFileSync(file, code);
console.log('Fixed TS issues');
