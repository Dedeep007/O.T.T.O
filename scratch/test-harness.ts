import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { ChatOllama } from "@langchain/ollama";
import { tools } from "../src/llm/tools.js";
import { executor } from "../src/security/executor.js";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import path from "path";
import fs from "fs";

// 1. Target the sample folder as the workspace cwd
const targetDir = 'C:\\Users\\dedeep vasireddy\\sample';
if (!fs.existsSync(targetDir)) {
  fs.mkdirSync(targetDir, { recursive: true });
}
process.chdir(targetDir);

// Auto-approve commands for headless test harness
(executor as any).promptAction = async (cmd: string, fullCommand: string) => {
  console.log(`  [TEST HARNESS AUTO-APPROVED] ${fullCommand}`);
  return 'now';
};

function parseFallbackToolCalls(content: string): any[] | null {
  const trimmed = content.trim();
  if (!trimmed) return null;

  const foundCalls: any[] = [];

  const addIfValid = (obj: any) => {
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
      parsed.forEach(addIfValid);
    } else {
      addIfValid(parsed);
    }
  } catch {}

  if (foundCalls.length > 0) return foundCalls;

  const jsonBlockRegex = /```json\s*([\s\S]*?)\s*```/g;
  let match;
  while ((match = jsonBlockRegex.exec(trimmed)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (Array.isArray(parsed)) {
        parsed.forEach(addIfValid);
      } else {
        addIfValid(parsed);
      }
    } catch {}
  }

  if (foundCalls.length > 0) return foundCalls;

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

  if (foundCalls.length > 0) return foundCalls;

  const blockRegex = /```(bash|sh|shell|powershell|cmd|ps1|javascript|typescript|js|ts|json|html|css)?\s*([\s\S]*?)\s*```/g;
  let blockMatch;
  let lastIdx = 0;

  while ((blockMatch = blockRegex.exec(trimmed)) !== null) {
    const lang = (blockMatch[1] || '').toLowerCase();
    const code = blockMatch[2].trim();
    const preText = trimmed.substring(lastIdx, blockMatch.index).trim();
    lastIdx = blockRegex.lastIndex;

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

    const fileMatch = preText.match(/(?:file|to|named|in|create|write)\s+`?([a-zA-Z0-9_\-\.\/\\:]+\.[a-zA-Z0-9_]+)`?/i);
    if (fileMatch) {
      foundCalls.push({
        name: 'write_file',
        args: { filePath: fileMatch[1], content: code },
        id: 'fallback_text_file_' + Math.random().toString(36).substring(2, 9)
      });
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

  return foundCalls.length > 0 ? foundCalls : null;
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
    const response = await originalInvoke(inputMessages, options);
    if (response && response.content && (!response.tool_calls || response.tool_calls.length === 0)) {
      const fallbackCalls = parseFallbackToolCalls(response.content.toString());
      if (fallbackCalls && fallbackCalls.length > 0) {
        response.tool_calls = fallbackCalls;
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
        "You are O.T.T.O, a helpful assistant with access to local tools. " +
        "You must execute the requested changes in the workspace using tools. " +
        "Do not explain that you cannot run commands; you have the execute_terminal_command tool."
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
  });

  console.log("\n--- Final Agent Execution Results ---");
  for (const msg of response.messages) {
    console.log(`[${msg._getType()}] ${msg.name || ''}: ${msg.content || ''}`);
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      console.log(`  Tool Calls: ${JSON.stringify(msg.tool_calls)}`);
    }
  }
}

test().catch(console.error);
