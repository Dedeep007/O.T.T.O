function parseInvalidWriteFileJson(jsonStr) {
  if (!jsonStr.includes('write_file')) return null;

  const filePathMatch = jsonStr.match(/"filePath"\s*:\s*"([^"]+)"/);
  if (!filePathMatch) return null;
  const filePath = filePathMatch[1];

  const contentIdx = jsonStr.indexOf('"content"');
  if (contentIdx === -1) return null;

  const colonIdx = jsonStr.indexOf(':', contentIdx);
  if (colonIdx === -1) return null;
  
  const startQuoteIdx = jsonStr.indexOf('"', colonIdx);
  if (startQuoteIdx === -1) return null;

  let endQuoteIdx = -1;
  for (let i = jsonStr.length - 1; i > startQuoteIdx; i--) {
    if (jsonStr[i] === '"') {
      const tail = jsonStr.substring(i + 1).trim();
      if (/^[\s,}]*$/.test(tail)) {
        if (tail.includes('}')) {
          endQuoteIdx = i;
          break;
        }
      }
    }
  }

  if (endQuoteIdx === -1) return null;

  let content = jsonStr.substring(startQuoteIdx + 1, endQuoteIdx);

  let unescaped = '';
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\\') {
      const next = content[i + 1];
      if (next === 'n') { unescaped += '\n'; i++; }
      else if (next === 'r') { unescaped += '\r'; i++; }
      else if (next === 't') { unescaped += '\t'; i++; }
      else if (next === '"') { unescaped += '"'; i++; }
      else if (next === '\\') { unescaped += '\\'; i++; }
      else { unescaped += '\\'; }
    } else {
      unescaped += content[i];
    }
  }

  return {
    name: 'write_file',
    arguments: {
      filePath,
      content: unescaped
    }
  };
}

const text = `{"name": "write_file", "arguments": {"filePath": "tsconfig.json", "content": "{\\n  \\"compilerOptions\\": {\\n    \\"target\\": \\"es6\\",\\n    \\"module\\": \\"commonjs\\",\\n    \\"outDir\\": \\"dist\\",\\n    \\"strict\\": true,\\n    \\"esModuleInterop\\": true\\n  },\\n  \\"include\\": [\\n    "src/**/*"\\n  ],\\n  \\"exclude\\": [\\n    \\"node_modules\\"\\n  ]\\n}\\n\\n\\"rootDir\\": \\"./\\"\\n"}}`;

const result = parseInvalidWriteFileJson(text);
console.log("RESULT:", result);
