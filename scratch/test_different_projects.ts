import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { ChatOllama } from "@langchain/ollama";
import { tools } from "../src/llm/tools.js";
import { executor } from "../src/security/executor.js";
import { ruleGuardrail } from "../src/security/rules.js";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import path from "path";
import fs from "fs";

const targetDir = 'C:\\Users\\dedeep vasireddy\\sample';
if (!fs.existsSync(targetDir)) {
  fs.mkdirSync(targetDir, { recursive: true });
}

// Kill processes on ports 3001 and 3002 to avoid EADDRINUSE
import { execSync } from 'child_process';
try {
  console.log("Cleaning up ports 3001 and 3002...");
  execSync("npx kill-port 3001 3002", { stdio: 'ignore' });
} catch (e) {}

// Auto-approve commands for headless test harness
(executor as any).promptAction = async (cmd: string, fullCommand: string) => {
  console.log(`  [TEST HARNESS AUTO-APPROVED] ${fullCommand}`);
  return 'now';
};

function sanitizeJsonString(jsonStr: string): string {
  let result = '';
  let inString = false;
  for (let i = 0; i < jsonStr.length; i++) {
    const char = jsonStr[i];
    if (char === '"') {
      inString = !inString;
      result += char;
      continue;
    }
    if (inString && char === '\\') {
      const nextChar = jsonStr[i + 1];
      if (nextChar === "'" || nextChar === undefined) {
        continue;
      }
      result += '\\' + nextChar;
      i++;
      continue;
    }
    if (inString && (char === '\n' || char === '\r')) {
      if (char === '\n') result += '\\n';
      continue;
    }
    result += char;
  }
  return result;
}

function isToolCallFormat(obj: any): boolean {
  if (Array.isArray(obj)) {
    return obj.length === 0 || (obj[0] && typeof obj[0] === 'object' && 'name' in obj[0]);
  }
  return obj && typeof obj === 'object' && 'name' in obj && ('args' in obj || 'arguments' in obj);
}

function parseFallbackToolCalls(content: string, messages?: any[]): any[] | null {
  const trimmed = content.trim();
  if (!trimmed) return null;

  const foundCalls: any[] = [];
  const parsedBlockIndexes = new Set<number>();

  const addIfValid = (obj: any) => {
    if (obj && typeof obj === 'object') {
      if (obj.name && (obj.arguments || obj.args)) {
        foundCalls.push({
          name: obj.name,
          args: obj.arguments || obj.args,
          id: 'fallback_' + Math.random().toString(36).substring(2, 9)
        });
        if (obj.name === 'write_file' || obj.name === 'replace_file_lines') {
          executor.clearAttempts();
        }
        return true;
      }
    }
    return false;
  };

  // 1. Try parsing whole response as JSON
  try {
    const sanitized = sanitizeJsonString(trimmed);
    const parsed = JSON.parse(sanitized);
    if (isToolCallFormat(parsed)) {
      if (Array.isArray(parsed)) {
        parsed.forEach(addIfValid);
      } else {
        addIfValid(parsed);
      }
    }
  } catch {}

  // 2. Parse JSON code blocks
  const jsonBlockRegex = /```json\s*([\s\S]*?)\s*```/g;
  let match;
  while ((match = jsonBlockRegex.exec(trimmed)) !== null) {
    try {
      const sanitized = sanitizeJsonString(match[1].trim());
      const parsed = JSON.parse(sanitized);
      if (isToolCallFormat(parsed)) {
        let matched = false;
        if (Array.isArray(parsed)) {
          parsed.forEach(item => { if (addIfValid(item)) matched = true; });
        } else {
          if (addIfValid(parsed)) matched = true;
        }
        if (matched) {
          parsedBlockIndexes.add(match.index);
        }
      }
    } catch {}
  }

  // 3. Parse inline JSON objects
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
            const sanitized = sanitizeJsonString(potentialJson);
            const parsed = JSON.parse(sanitized);
            addIfValid(parsed);
          } catch {}
        }
      }
    }
  }

  // 4. Parse markdown code blocks
  const blockRegex = /```([a-zA-Z0-9_-]*)\s*([\s\S]*?)\s*```/g;
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

    if (!code) continue;
    if (lang === 'diff' || lang === 'patch') continue;

    if (messages && messages.length > 0) {
      const lastMsg = messages[messages.length - 1];
      const isToolMessage = lastMsg && (
        lastMsg._getType?.() === 'tool' || 
        lastMsg.role === 'tool' ||
        (lastMsg.content && lastMsg.content.toString().includes('Background process started')) ||
        (lastMsg.content && lastMsg.content.toString().includes('Initial Output Logs'))
      );
      if (isToolMessage) {
        const lastMsgContent = (lastMsg.content || '').toString();
        if (lastMsgContent.includes(code)) {
          continue;
        }
      }
    }

    const isWin = process.platform === 'win32';
    const osFilterMatch = preText.match(/(?:for|on|mac|linux|windows|win)\s*(mac(?:os)?|osx|linux|ubuntu|debian|windows|win32)/i);
    if (osFilterMatch) {
      const targetOS = osFilterMatch[1].toLowerCase();
      if ((targetOS.includes('mac') || targetOS.includes('osx')) && isWin) {
        continue;
      }
      if (targetOS.includes('linux') && isWin) {
        continue;
      }
      if (targetOS.includes('windows') && !isWin) {
        continue;
      }
    }

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
    }
    if (!fileMatch) {
      const afterMatch = preText.match(/`?([a-zA-Z0-9_\-\.\/\\:]+\.[a-zA-Z0-9_]+)`?\s+(?:file|content|data|code|structure|script|program|module|template|text)/i);
      if (afterMatch) {
        fileMatch = afterMatch;
      }
    }
    if (!fileMatch) {
      fileMatch = preText.match(/\b([a-zA-Z0-9_\-\.\/\\:]+\.(?:py|js|ts|json|html|css|sh|ps1|bat|cmd|cpp|c|h|md|csv|yaml|yml|toml|txt))\b/i);
    }

    if (!fileMatch) {
      // Content-based heuristics for common files
      if (lang === 'json' || code.startsWith('{')) {
        if (code.includes('"name"') && code.includes('"version"') && (code.includes('"dependencies"') || code.includes('"devDependencies"') || code.includes('"scripts"'))) {
          fileMatch = ['package.json', 'package.json'];
        } else if (code.includes('"compilerOptions"')) {
          fileMatch = ['tsconfig.json', 'tsconfig.json'];
        }
      } else if (lang === 'html' || code.includes('<!DOCTYPE') || code.includes('<html')) {
        fileMatch = ['index.html', 'index.html'];
      }
    }

    const extMap: Record<string, string> = {
      typescript: 'ts', ts: 'ts', tsx: 'tsx',
      javascript: 'js', js: 'js', jsx: 'jsx',
      python: 'py', py: 'py',
      json: 'json',
      html: 'html',
      css: 'css',
      rust: 'rs', rs: 'rs',
      toml: 'toml',
      yaml: 'yaml', yml: 'yml',
      csv: 'csv',
      markdown: 'md', md: 'md'
    };
    const extension = extMap[lang];

    if (!fileMatch && extension) {
      // Search in entire response content (trimmed) for a unique filename with this extension
      const escExt = extension.replace(/\./g, '\\.');
      const allMatches = trimmed.match(new RegExp(`\\b([a-zA-Z0-9_\\-\\.\\/\\\\:]+\\.${escExt})\\b`, 'gi'));
      if (allMatches && allMatches.length > 0) {
        const unique = Array.from(new Set(allMatches.map(f => f.toLowerCase())));
        if (unique.length === 1) {
          const matchIdx = allMatches.map(f => f.toLowerCase()).indexOf(unique[0]);
          fileMatch = [allMatches[matchIdx], allMatches[matchIdx]];
        }
      }
    }

    if (!fileMatch && extension && messages && Array.isArray(messages)) {
      // Search in the messages (specifically the user prompts/last messages) for a unique filename with this extension
      let userText = '';
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg && (msg._getType?.() === 'human' || msg.role === 'user' || msg.role === 'human')) {
          userText = (msg.content || '').toString();
          break;
        }
      }
      if (userText) {
        const escExt = extension.replace(/\./g, '\\.');
        const allMatches = userText.match(new RegExp(`\\b([a-zA-Z0-9_\\-\\.\\/\\\\:]+\\.${escExt})\\b`, 'gi'));
        if (allMatches && allMatches.length > 0) {
          const unique = Array.from(new Set(allMatches.map(f => f.toLowerCase())));
          if (unique.length === 1) {
            const matchIdx = allMatches.map(f => f.toLowerCase()).indexOf(unique[0]);
            fileMatch = [allMatches[matchIdx], allMatches[matchIdx]];
          }
        }
      }
    }

    if (fileMatch) {
      foundCalls.push({
        name: 'write_file',
        args: { filePath: fileMatch[1], content: code },
        id: 'fallback_text_file_' + Math.random().toString(36).substring(2, 9)
      });
      executor.clearAttempts();
    }
  }

  if (foundCalls.length === 0) {
    const lines = trimmed.split('\n');
    for (const line of lines) {
      const cleanLine = line.trim();
      if (/^(npm|git|node|tsc|npx)\s+[a-zA-Z0-9_\-\.\/\\\s"'\(\)]+$/i.test(cleanLine) && cleanLine.length < 100) {
        foundCalls.push({
          name: 'execute_terminal_command',
          args: { command: cleanLine },
          id: 'fallback_text_line_' + Math.random().toString(36).substring(2, 9)
        });
      }
    }
  }

  // 6. Deduplicate the collected calls
  if (foundCalls.length > 0) {
    const seen = new Set<string>();
    const deduplicated: any[] = [];
    for (const call of foundCalls) {
      let key = '';
      if (call.name === 'write_file') {
        const filePath = (call.args?.filePath || '').replace(/\\/g, '/').toLowerCase();
        const content = (call.args?.content || '').trim();
        key = `write_file:${filePath}:${content}`;
      } else if (call.name === 'execute_terminal_command') {
        const command = (call.args?.command || '').trim();
        key = `execute_terminal_command:${command}`;
      } else {
        key = `${call.name}:${JSON.stringify(call.args)}`;
      }
      if (!seen.has(key)) {
        seen.add(key);
        deduplicated.push(call);
      }
    }
    return deduplicated.length > 0 ? deduplicated : null;
  }

  return null;
}

async function runScenario(name: string, instruction: string) {
  console.log(`\n======================================================`);
  console.log(`STARTING SCENARIO: ${name}`);
  console.log(`======================================================`);
  
  // Clean workspace target directory before each test scenario
  const files = fs.readdirSync(targetDir);
  for (const file of files) {
    if (file === 'node_modules') continue;
    const fullPath = path.join(targetDir, file);
    if (fs.statSync(fullPath).isDirectory()) {
      fs.rmSync(fullPath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(fullPath);
    }
  }
  
  process.chdir(targetDir);
  
  const rawModel = new ChatOllama({
    baseUrl: "http://localhost:11434",
    model: "qwen2.5-coder:3b",
    temperature: 0,
  }).bindTools(tools) as any;

  const originalInvoke = rawModel.invoke.bind(rawModel);
  rawModel.invoke = async (inputMessages: any, options: any) => {
    console.log(`\n--- [Step] LLM Prompt (Last msg) ---`);
    const lastMsg = inputMessages[inputMessages.length - 1];
    console.log(lastMsg.content);

    const response = await originalInvoke(inputMessages, options);

    console.log(`\n--- [Step] LLM Output ---`);
    console.log(response.content);
    if (response.tool_calls && response.tool_calls.length > 0) {
      console.log(`Native Tool Calls: ${JSON.stringify(response.tool_calls)}`);
    }

    if (response && response.content && (!response.tool_calls || response.tool_calls.length === 0)) {
      const fallbackCalls = parseFallbackToolCalls(response.content.toString(), inputMessages);
      if (fallbackCalls && fallbackCalls.length > 0) {
        response.tool_calls = fallbackCalls;
        console.log(`Fallback Tool Calls parsed: ${JSON.stringify(fallbackCalls)}`);
        const rawTrimmed = response.content.toString().trim();
        try {
          JSON.parse(rawTrimmed);
          response.content = '';
        } catch {
          const blockRegex = /^```json\s*([\s\S]*?)\s*```$/i;
          const match = rawTrimmed.match(blockRegex);
          if (match) {
            try {
              JSON.parse(match[1].trim());
              response.content = '';
            } catch {}
          }
        }
      }
    }
    return response;
  };

  const app = createReactAgent({
    llm: rawModel,
    tools: tools,
  });

  const response = await app.invoke({
    messages: [
      new SystemMessage(
        ruleGuardrail.getRules() +
        "\n\n=========================================\n" +
        "You are O.T.T.O, a helpful assistant with access to local tools. " +
        "You must execute the requested changes in the workspace using tools. " +
        "Do not explain that you cannot run commands; you have the execute_terminal_command tool.\n" +
        "CRITICAL FOR THIS HEADLESS RUN: You are in EXECUTION MODE. The user has already approved all plans. " +
        "Do NOT output or request plans (do not output PLAN_START/PLAN_END). " +
        "Proceed directly with editing, writing files, and running commands using tools.\n" +
        "If a script execution fails with a runtime error (e.g. ZeroDivisionError, KeyError, or ReferenceError), you MUST edit the script file itself to fix the logical error. Do NOT just re-run the script or re-write unchanged data files.\n" +
        "When writing data files (like CSVs), ensure you structure them consistently with how they are read by your scripts (e.g. including matching headers if reading with header keys like DictReader, or omitting headers and parsing columns by index if reading headerless).\n" +
        "For TypeScript compilation: if compiling with tsc, remember to either initialize a config file using `npx tsc --init` first, or specify the input files explicitly (e.g. `npx tsc index.ts mathUtils.ts`).\n" +
        "Before finishing, double check that ALL files requested in the instruction have been successfully created and that the compilation/run verification step succeeded."
      ),
      new HumanMessage(instruction)
    ]
  }, { recursionLimit: 45 });

  console.log(`\n--- Scenario Results ---`);
  for (const msg of response.messages) {
    console.log(`[${msg._getType()}] ${msg.name || ''}: ${msg.content || ''}`);
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      console.log(`  Tool Calls: ${JSON.stringify(msg.tool_calls)}`);
    }
  }
}

async function testAll() {
  // Scenario 1: Node.js static server
  await runScenario(
    "Scenario 1: Node.js Web Server",
    "Create a web server in the workspace. " +
    "1. Write a server.js that runs on port 3002, serves static files from a public directory, and handles GET /health by returning 'OK'. " +
    "2. Create a public/index.html with an h1 saying 'Hello from OTTO'. " +
    "3. Run the server in the background and verify that it started successfully."
  );

  // Scenario 2: Python Data Aggregation
  await runScenario(
    "Scenario 2: Python Score Analyzer",
    "Create a Python statistics tool in the workspace. " +
    "1. Write a scores.csv containing 5 names and test scores (e.g. Alice,85; Bob,92; Charlie,78; David,95; Emma,88). " +
    "2. Write a Python script analyze.py that reads scores.csv and calculates the average score, maximum score, and minimum score, then prints them. " +
    "3. Run the Python script using execute_terminal_command and capture the output to verify it calculates stats correctly."
  );

  // Scenario 3: TypeScript module and compilation
  await runScenario(
    "Scenario 3: TypeScript Library",
    "Create a TypeScript utility module. " +
    "1. Initialize package.json. " +
    "2. Run npm install typescript --save-dev to install TypeScript. " +
    "3. Write a mathUtils.ts exporting add(a, b) and fibonacci(n). " +
    "4. Write an index.ts that calls mathUtils functions and prints results. " +
    "5. Run npx tsc --init to initialize tsconfig.json. " +
    "6. Compile the project using npx tsc and verify that the build completes successfully without errors."
  );
}

testAll().catch(console.error);
