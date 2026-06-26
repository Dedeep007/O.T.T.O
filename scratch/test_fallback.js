function parseFallbackToolCalls(content) {
  const trimmed = content.trim();
  if (!trimmed) return null;

  const foundCalls = [];
  const parsedBlockIndexes = new Set();

  const addIfValid = (obj) => {
    if (obj && typeof obj === 'object') {
      if (obj.name && (obj.arguments || obj.args)) {
        foundCalls.push({
          name: obj.name,
          args: obj.arguments || obj.args,
          id: 'fallback_' + Math.random().toString(36).substring(2, 9)
        });
        return true;
      }
    }
    return false;
  };

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      let anyAdded = false;
      parsed.forEach(item => { if (addIfValid(item)) anyAdded = true; });
      if (anyAdded) return foundCalls;
    } else {
      if (addIfValid(parsed)) return foundCalls;
    }
  } catch {}

  const jsonBlockRegex = /```json\s*([\s\S]*?)\s*```/g;
  let match;
  while ((match = jsonBlockRegex.exec(trimmed)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      let matchedTool = false;
      if (Array.isArray(parsed)) {
        parsed.forEach(item => { if (addIfValid(item)) matchedTool = true; });
      } else {
        if (addIfValid(parsed)) matchedTool = true;
      }
      if (matchedTool) {
        parsedBlockIndexes.add(match.index);
      }
    } catch {}
  }

  let inString = false;
  let escapeNext = false;
  let depth = 0;
  let startIdx = -1;

  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (char === '\\') {
      if (inString) escapeNext = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (char === '{') {
        if (depth === 0) startIdx = i;
        depth++;
      } else if (char === '}') {
        depth--;
        if (depth === 0 && startIdx !== -1) {
          const potentialJson = trimmed.substring(startIdx, i + 1);
          try {
            const parsed = JSON.parse(potentialJson);
            addIfValid(parsed);
          } catch {}
        }
      }
    }
  }

  const blockRegex = /```(bash|sh|shell|powershell|cmd|ps1|javascript|typescript|js|ts|json|html|css)?\s*([\s\S]*?)\s*```/g;
  let blockMatch;
  let lastIdx = 0;

  while ((blockMatch = blockRegex.exec(trimmed)) !== null) {
    if (parsedBlockIndexes.has(blockMatch.index)) {
      lastIdx = blockRegex.lastIndex;
      continue;
    }

    const lang = (blockMatch[1] || '').toLowerCase();
    const code = blockMatch[2].trim();
    const preText = trimmed.substring(lastIdx, blockMatch.index).trim();
    lastIdx = blockRegex.lastIndex;

    console.log(`\n--- BLOCK MATCH ---`);
    console.log(`Lang: "${lang}"`);
    console.log(`Code length: ${code.length}`);
    console.log(`PreText:\n${preText}`);

    if (!code) continue;

    const isCmdLang = ['bash', 'sh', 'shell', 'powershell', 'cmd', 'ps1'].includes(lang);
    const firstLine = code.split('\n')[0]?.trim() ?? '';
    const isCmdPattern = /^(npm|git|node|tsc|npx|pip|python|docker|cargo|yarn|pnpm|deno|ollama)\b/i.test(firstLine);

    if (isCmdLang || (isCmdPattern && !code.includes('\n'))) {
      foundCalls.push({
        name: 'execute_terminal_command',
        args: { command: code },
        id: 'fallback_text_cmd_' + Math.random().toString(36).substring(2, 9)
      });
      continue;
    }

    let fileMatch = code.split('\n')[0]?.trim().match(/^(?:#|\/\/|\/\*+)\s*(?:file:)?\s*`?([a-zA-Z0-9_\-\.\/\\:]+\.[a-zA-Z0-9_]+)`?/i);
    if (!fileMatch) {
      fileMatch = preText.match(/(?:file|to|named|in|create|write|for|of|as|called)\s+`?([a-zA-Z0-9_\-\.\/\\:]+\.[a-zA-Z0-9_]+)`?/i);
      if (fileMatch) console.log(`Matched trigger before: ${fileMatch[1]}`);
    }
    if (!fileMatch) {
      const afterMatch = preText.match(/`?([a-zA-Z0-9_\-\.\/\\:]+\.[a-zA-Z0-9_]+)`?\s+(?:file|content|data|code|structure|script|program|module|template|text)/i);
      if (afterMatch) {
        fileMatch = afterMatch;
        console.log(`Matched trigger after: ${fileMatch[1]}`);
      }
    }
    if (!fileMatch) {
      fileMatch = preText.match(/\b([a-zA-Z0-9_\-\.\/\\:]+\.(?:py|js|ts|json|html|css|sh|ps1|bat|cmd|cpp|c|h|md|csv|yaml|yml|toml|txt))\b/i);
      if (fileMatch) console.log(`Matched extension: ${fileMatch[1]}`);
    }

    if (fileMatch) {
      foundCalls.push({
        name: 'write_file',
        args: { filePath: fileMatch[1], content: code },
        id: 'fallback_text_file_' + Math.random().toString(36).substring(2, 9)
      });
    } else {
      console.log(`No match for block!`);
    }
  }

  return foundCalls.length > 0 ? foundCalls : null;
}

const response = `It seems there might be an issue with the \`analyze.py\` script itself. Let's ensure that the script is correctly written and accessible in your workspace.

Here's a simple version of \`analyze.py\` that calculates the average, maximum, and minimum scores from the \`scores.csv\` file:

\`\`\`python
import csv

def calculate_stats(file_path):
    with open(file_path, mode='r') as file:
        reader = csv.DictReader(file)
        scores = [int(row['test_score']) for row in reader]

    if not scores:
        print("No data found.")
        return

    average = sum(scores) / len(scores)
    max_score = max(scores)
    min_score = min(scores)

    print(f"Average Score: {average}")
    print(f"Maximum Score: {max_score}")
    print(f"Minimum Score: {min_score}")

if __name__ == "__main__":
    calculate_stats('scores.csv')
\`\`\`

Make sure the script is saved as \`analyze.py\` in your workspace. Then, try running it again using the \`execute_terminal_command\` tool:

\`\`\`json
{"name": "execute_terminal_command", "arguments": {"command":"python analyze.py"}}
\`\`\``;

console.log("\nParsed:", JSON.stringify(parseFallbackToolCalls(response), null, 2));
