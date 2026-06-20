const preText = `It seems there might be an issue with the \`analyze.py\` script itself. Let's ensure that the script is correctly written and accessible in your workspace.

Here's a simple version of \`analyze.py\` that calculates the average, maximum, and minimum scores from the \`scores.csv\` file:`;

console.log("Regex 1 (trigger before):", preText.match(/(?:file|to|named|in|create|write|for|of|as|called)\s+`?([a-zA-Z0-9_\-\.\/\\:]+\.[a-zA-Z0-9_]+)`?/i));

const afterRegex = /`?([a-zA-Z0-9_\-\.\/\\:]+\.[a-zA-Z0-9_]+)`?\s+(?:file|content|data|code|structure|script|program|module|template|text)/i;
console.log("Regex 2 (trigger after):", preText.match(afterRegex));

const extRegex = /\b([a-zA-Z0-9_\-\.\/\\:]+\.(?:py|js|ts|json|html|css|sh|ps1|bat|cmd|cpp|c|h|md|csv|yaml|yml|toml|txt))\b/i;
console.log("Regex 3 (ext check):", preText.match(extRegex));
