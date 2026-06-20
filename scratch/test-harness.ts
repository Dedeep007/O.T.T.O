import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { ChatOllama } from "@langchain/ollama";
import { tools } from "../src/llm/tools.js";
import { executor } from "../src/security/executor.js";
import { ruleGuardrail } from "../src/security/rules.js";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import path from "path";
import fs from "fs";

// 1. Target the sample folder as the workspace cwd
const targetDir = 'C:\\Users\\dedeep vasireddy\\sample';
if (!fs.existsSync(targetDir)) {
  fs.mkdirSync(targetDir, { recursive: true });
}
process.chdir(targetDir);

// Clean workspace target directory before test execution
const files = fs.readdirSync(targetDir);
for (const file of files) {
  if (file === 'node_modules') continue;
  const fullPath = path.join(targetDir, file);
  try {
    if (fs.statSync(fullPath).isDirectory()) {
      fs.rmSync(fullPath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(fullPath);
    }
  } catch {}
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

async function test() {
  console.log(`Cwd set to: ${process.cwd()}`);
  
  // 2. Initialize the model and wrap it
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

  // 3. Create the ReAct agent using LangGraph's prebuilt React agent
  const app = createReactAgent({
    llm: rawModel,
    tools: tools,
  });

  console.log("Sending task to ReAct agent...");
  
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
        "Before finishing, double check that ALL files requested in the instruction have been successfully created and that the compilation/run verification step succeeded."
      ),
      new HumanMessage(
        "Create a complete web application with a frontend and backend inside the workspace. " +
        "1. Initialize a Node.js project. " +
        "2. Create a backend server (server.js) using native Node.js http/fs modules (or Express if installed, but native http is safer without dependencies first) " +
        "that serves static files from a public directory and exposes a POST /api/login endpoint checking for credentials admin/admin. " +
        "3. Create a frontend public/index.html containing a clean login form and a script that calls the login API and alerts the result. " +
        "4. Start the backend server on port 3001 in the background, and verify that it started successfully."
      )
    ]
  }, { recursionLimit: 45 });

  console.log("\n--- Final Agent Execution Results ---");
  for (const msg of response.messages) {
    console.log(`[${msg._getType()}] ${msg.name || ''}: ${msg.content || ''}`);
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      console.log(`  Tool Calls: ${JSON.stringify(msg.tool_calls)}`);
    }
  }
}

test().catch(console.error);
