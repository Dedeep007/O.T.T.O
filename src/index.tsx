import { Configurator } from './cli/configurator.js';
import { ui } from './cli/ui.js';
import { AgentWorkflow } from './agent/workflow.js';
import { chatSession, sessionEvents } from './cli/session.js';
import { ProviderRegistry } from './providers/registry.js';
import { executor } from './security/executor.js';
import { memoryManager } from './memory/budget.js';
import { vectorMemory } from './memory/vector.js';
import { ruleGuardrail } from './security/rules.js';
import { backgroundManager } from './security/background.js';
import { osController } from './hardware/os.js';
import { browserAutomation } from './hardware/browser.js';
import { serialBridge } from './hardware/serial.js';
import { dbManager } from './db/checkpoint.js';
import { threadLocalStorage } from './cli/threadContext.js';
import { PhoneOS, PhoneView, PhoneOSApp } from './cli/nav.js';
import { ChatUI, ChatUIApp } from './cli/chat.js';
import { createTaskBoardView } from './cli/views/taskBoard.js';
import { createFileTreeView } from './cli/views/fileTree.js';
import { createGitPanelView } from './cli/views/gitPanel.js';
import { createCommandPaletteView } from './cli/views/commandPalette.js';
import { promptWithEscape } from './cli/prompt.js';
import { captureWorkspaceSnapshot, formatWorkspaceChanges } from './cli/workspaceDiff.js';
import { snapshotManager } from './cli/snapshots.js';
import { parseAndExecuteCLI } from './cli/parser.js';
import * as readline from 'readline';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import React, { useState, useEffect } from 'react';
import { render } from 'ink';
let CLI_VERSION = '1.0.0';
try {
  let dir = process.cwd();
  try {
    // @ts-ignore
    dir = typeof __dirname !== 'undefined' ? __dirname : path.dirname(new URL(import.meta.url).pathname);
    // On Windows, new URL().pathname adds a leading slash (e.g. /C:/...)
    if (process.platform === 'win32' && dir.startsWith('/')) {
      dir = dir.slice(1);
    }
  } catch (e) {}
  
  let pkgPath = path.join(dir, '..', 'package.json');
  if (!fs.existsSync(pkgPath)) {
    pkgPath = path.join(dir, '..', '..', 'package.json');
  }
  if (!fs.existsSync(pkgPath)) {
    pkgPath = path.join(process.cwd(), 'package.json');
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  CLI_VERSION = pkg.version;
} catch (e) {
  // ignore
}

import { SystemMessage, HumanMessage, AIMessage, ToolMessage } from '@langchain/core/messages';
import { concat } from '@langchain/core/utils/stream';
import { tools } from './tools/registry.js';
import { confirm, select } from '@inquirer/prompts';
import chalk from 'chalk';
import os from 'os';

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

type ProviderName = 'groq' | 'openai' | 'anthropic' | 'ollama' | 'gemini' | 'mistral' | 'bedrock' | 'nvidia';
function stripToolBleed(text: string): string {
  if (!text) return text;
  let cleaned = text;

  // 1. Remove <tool>, <tool_call>, or <tool_response> tags and their content
  cleaned = cleaned.replace(/<(?:tool|tool_call|tool_response)>[\s\S]*?(?:<\/(?:tool|tool_call|tool_response)>|$)/gi, '');

  // 2. Remove markdown JSON blocks if they look like a tool call
  const blockRegex = /```json\s*([\s\S]*?)(?:```|$)/gi;
  cleaned = cleaned.replace(blockRegex, (match, inner) => {
    if (inner.includes('"name"') || inner.includes('write_file') || inner.includes('execute_terminal_command')) {
      return '';
    }
    return match;
  });

  // 3. Remove raw JSON objects that look like tool calls
  const rawJsonRegex = /(?:^|\n)\s*\{[\s\S]*?"name"[\s\S]*?\}(?=\s*$|\n\s*(?:\{|<)|$)/g;
  cleaned = cleaned.replace(rawJsonRegex, '');

  return cleaned.trim();
}

function parseInvalidWriteFileJson(jsonStr: string): any | null {
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
  for (let i = startQuoteIdx + 1; i < jsonStr.length; i++) {
    if (jsonStr[i] === '\\') {
      i++; // skip escaped character
      continue;
    }
    if (jsonStr[i] === '"') {
      endQuoteIdx = i;
      break;
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
  } catch {
    const customParsed = parseInvalidWriteFileJson(trimmed);
    if (customParsed) {
      addIfValid(customParsed);
    }
  }

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
    } catch {
      const customParsed = parseInvalidWriteFileJson(match[1].trim());
      if (customParsed) {
        if (addIfValid(customParsed)) {
          parsedBlockIndexes.add(match.index);
        }
      }
    }
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
          } catch {
            const customParsed = parseInvalidWriteFileJson(potentialJson);
            if (customParsed) {
              addIfValid(customParsed);
            }
          }
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

    const looksLikeToolCall = (code.includes('"name"') || code.includes("'name'")) && (code.includes('"arguments"') || code.includes("'arguments'") || code.includes('"args"') || code.includes("'args'"));
    if (looksLikeToolCall) continue;

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

export class RootController {
  private mode: 'menu' | 'chat' = 'menu';
  private listeners: (() => void)[] = [];

  getMode() { return this.mode; }
  
  setMode(m: 'menu' | 'chat') {
    this.mode = m;
    this.listeners.forEach(l => l());
  }

  subscribe(listener: () => void) {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }
}
export const rootController = new RootController();

function AppShell({ phone, chatUI }: { phone: PhoneOS; chatUI: ChatUI }) {
  const [mode, setMode] = useState<'menu' | 'chat'>(rootController.getMode());

  useEffect(() => {
    ui.onTuiMessage = (type, text, timeoutMs) => {
      let cleanText = text.replace(/^\[[i✓!X]\]\s*/, '').replace(/^ERROR:\s*/, '');
      if (rootController.getMode() === 'chat') {
        chatUI.showNotification(cleanText, type, timeoutMs);
      } else {
        phone.showNotification(cleanText, type, timeoutMs);
      }
    };
    return () => {
      ui.onTuiMessage = null;
    };
  }, [phone, chatUI]);

  useEffect(() => {
    return rootController.subscribe(() => {
      ui.clearScreen();
      setMode(rootController.getMode());
    });
  }, []);

  if (mode === 'chat') {
    return <ChatUIApp chatUI={chatUI} />;
  }
  return <PhoneOSApp phone={phone} />;
}

async function main() {
  const args = process.argv.slice(2);
  const cliHandled = await parseAndExecuteCLI(args);
  if (cliHandled) {
    process.exit(0);
  }

  // Enter alternate screen buffer
  process.stdout.write('\x1B[?1049h');
  ui.tuiActive = true;

  ui.clearScreen();
  let config = await Configurator.init();
  memoryManager.setConfig(config);
  const provider = new ProviderRegistry(config);
  const rules = ruleGuardrail.getRules('build');

  const phone = new PhoneOS(config);
  const chatUI = new ChatUI();

  const startChat = async () => {
    const messages = chatSession.getMessages();
    let currentInput = '';
    let autoRetryCount = 0;
    const getIsStreaming = () => chatSession.activeStreams.has(chatSession.threadId);
    let isPrompting = false;
    let lastStreamContentLength = 0;
    let autocompleteState: {
      originalInput: string;
      lastAtIdx?: number;
      matches: string[];
      matchIdx: number;
      isCommand?: boolean;
    } | null = null;
    
    const getPendingPlan = () => chatSession.pendingPlans.has(chatSession.threadId);
    const setPendingPlan = (val: boolean) => {
      if (val) chatSession.pendingPlans.add(chatSession.threadId);
      else chatSession.pendingPlans.delete(chatSession.threadId);
    };
    const getPlanMenuIndex = () => chatSession.planMenuIndices.get(chatSession.threadId) ?? 0;
    const setPlanMenuIndex = (val: number) => {
      chatSession.planMenuIndices.set(chatSession.threadId, val);
    };
    const getPendingApproval = () => {
      return chatSession.pendingApprovals.find(p => p.threadId === chatSession.threadId);
    };
    const getApprovalMenuIndex = () => chatSession.approvalMenuIndices.get(chatSession.threadId) ?? 0;
    const setApprovalMenuIndex = (val: number) => {
      chatSession.approvalMenuIndices.set(chatSession.threadId, val);
    };

    const PLAN_MENU_OPTIONS = [
      { label: '✅  Approve - execute the plan', inject: 'PLAN APPROVED. Do NOT output the plan again. Proceed immediately to execute the first step using tool calls.' },
      { label: '✏️  Edit - request changes first', inject: null },
      { label: '❌  Cancel - do not proceed', inject: 'cancel - do not proceed with this plan.' },
    ];

    const PLAN_BLOCK_RE = /<!--\s*PLAN_START\s*-->[\s\S]*?<!--\s*PLAN_END\s*-->/;
    // Convert history for rendering
    const getRenderMessages = () => {
      const renderMsgs: any[] = [];
      const state = chatSession.agentStates.get(chatSession.threadId);
      messages.forEach((m, i) => {
        const messageType = m._getType();
        let content = m.content.toString();
        
        let toolInfo: any;
        let toolCalls = (m as any).tool_calls;

        if (messageType === 'tool') {
          let args = {};
          const toolName = (m as any).name || 'tool';
          const toolCallId = (m as any).tool_call_id;
          if (toolCallId) {
            for (let j = messages.indexOf(m) - 1; j >= 0; j--) {
              if (messages[j]._getType() === 'ai' && (messages[j] as any).tool_calls) {
                const tc = (messages[j] as any).tool_calls.find((c: any) => c.id === toolCallId);
                if (tc) {
                  args = tc.args;
                  break;
                }
              }
            }
          }
          const isError = content.includes('ENOENT') || content.startsWith('Error:');
          toolInfo = {
             name: toolName,
             args,
             status: isError ? 'error' : 'done',
             rawOutput: content
          };
          content = formatToolResult(toolName, content, '', args);
        }
        
        if (content.trim() || toolCalls?.length > 0) {
          renderMsgs.push({
            role: messageType === 'human' ? 'user' : messageType === 'tool' ? 'tool' : messageType === 'system' ? 'system' : 'ai',
            content,
            toolInfo,
            toolCalls,
            state: (i === messages.length - 1) ? state : undefined
          });
        }
      });
      return renderMsgs;
    };

    const syncMessages = () => {
      chatSession.setMessages(messages);
    };

    let animationTimer: NodeJS.Timeout | null = null;
    const updateAnimationTimer = () => {
      const state = chatSession.agentStates.get(chatSession.threadId) || 'idle';
      if (state !== 'idle' && !isPrompting) {
        if (!animationTimer) {
          animationTimer = setInterval(() => {
            if (chatSession.isChatActive && !isPrompting) {
              render(true);
            }
          }, 350);
        }
      } else {
        if (animationTimer) {
          clearInterval(animationTimer);
          animationTimer = null;
        }
      }
    };

    let lastRenderTime = 0;
    function throttleRender(force = false) {
      if (isPrompting) return;
      const now = Date.now();
      if (force || now - lastRenderTime >= 100) {
        lastRenderTime = now;
        render(force);
      }
    }

    let diffsExpanded = false;

    function render(force = false) {
      if (isPrompting) return;
      if (!chatSession.isChatActive) return;

      updateAnimationTimer();

      const state = chatSession.agentStates.get(chatSession.threadId);
      const isThinking = state === 'thinking';
      const delayMessage = chatSession.delayMessages.get(chatSession.threadId);
      const stats = memoryManager.getBudgetStatsForMessages(messages, ruleGuardrail.getRules('build', memoryManager.C_max));
      const prov = config.defaults.primaryProvider;
      const model = Configurator.getActiveModel(config, prov as any) ?? 'default';
      const ramMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
      chatUI.render(getRenderMessages(), currentInput, {
        ctxMax: stats.max,
        ctxUsed: stats.filled,
        ramMB,
        showContextBar: config.defaults.showContextBar !== false,
        isStreaming: getIsStreaming()
      }, model, isThinking, getPendingPlan(), getPlanMenuIndex(), diffsExpanded, delayMessage, getPendingApproval(), getApprovalMenuIndex(), config.security.mode, autocompleteState);
    }


    const formatToolResult = (toolName: string, result: string, diffSummary: string, args: any) => {
      const sections: string[] = [];
      const trimmedResult = result.trim();

      if (toolName === 'execute_terminal_command') {
        sections.push(`> \`${args.command}\``);
        if (trimmedResult) {
          sections.push(trimmedResult);
        }
      } else if (toolName === 'write_file') {
        sections.push(`✓ Wrote file \`${args.filePath}\``);
        if (trimmedResult && !trimmedResult.includes('Created file') && !trimmedResult.includes('Updated file')) {
          sections.push(trimmedResult);
        }
      } else if (toolName === 'replace_file_lines') {
        sections.push(`✓ Edited file \`${args.filePath}\``);
        if (trimmedResult && !trimmedResult.includes('Edited file')) {
          sections.push(trimmedResult);
        }
      } else {
        sections.push(`**Tool call: ${toolName}**`);
        if (args && Object.keys(args).length > 0) {
          const sanitizedArgs = { ...args };
          for (const key of Object.keys(sanitizedArgs)) {
            if (typeof sanitizedArgs[key] === 'string' && sanitizedArgs[key].length > 100) {
              sanitizedArgs[key] = sanitizedArgs[key].slice(0, 100) + '...';
            }
          }
          sections.push(`Arguments: \`${JSON.stringify(sanitizedArgs)}\``);
        }
        if (trimmedResult) {
          sections.push(trimmedResult);
        }
      }

      if (diffSummary) {
        sections.push(diffSummary);
      }

      return sections.join('\n\n');
    };

    const formatChatError = (error: any) => {
      const message = error?.message ?? String(error);
      if (
        error?.status === 429 ||
        error?.response?.status === 429 ||
        error?.code === 'rate_limit_exceeded' ||
        message.toLowerCase().includes('rate limit')
      ) {
        return 'Rate limit reached after trying available API keys/model variants. Add another key in Settings > API Settings, add another model variant, or wait a moment and retry.';
      }
      return `Error: ${message}`;
    };

    return new Promise<void>((resolve) => {
      chatSession.isChatActive = true;
      chatUI.scrollOffset = 0;
      chatUI.totalContentLines = 0;
      chatUI.registerKeyHandler(onKeypress);

      const onPendingApproval = () => {
        if (chatSession.isChatActive) {
          chatUI.scrollToBottom();
          render(true);
        }
      };
      sessionEvents.on('pending_approval', onPendingApproval);

      const onStreamUpdate = (id: string) => {
        if (id === chatSession.threadId && chatSession.isChatActive) {
          render(true);
        }
      };

      function onPromptStart() {
        isPrompting = true;
        chatUI.removeKeyHandler();
        if (animationTimer) {
          clearInterval(animationTimer);
          animationTimer = null;
        }
      }

      function onPromptEnd() {
        isPrompting = false;
        chatUI.registerKeyHandler(onKeypress);
        updateAnimationTimer();
        render(true);
      }

      sessionEvents.on('stream_update', onStreamUpdate);
      sessionEvents.on('prompt_start', onPromptStart);
      sessionEvents.on('prompt_end', onPromptEnd);

      const cleanup = () => {
        chatSession.isChatActive = false;
        if (animationTimer) {
          clearInterval(animationTimer);
          animationTimer = null;
        }
        sessionEvents.removeListener('stream_update', onStreamUpdate);
        sessionEvents.removeListener('pending_approval', onPendingApproval);
        sessionEvents.removeListener('prompt_start', onPromptStart);
        sessionEvents.removeListener('prompt_end', onPromptEnd);
        chatUI.removeKeyHandler();
      };

      const workflow = new AgentWorkflow();
      const runAgentLoop = async (inputText: string) => {
        try {
          const currentThreadId = chatSession.threadId;
          await threadLocalStorage.run(currentThreadId, async () => {
            chatSession.cancelledThreads.delete(currentThreadId);
            chatSession.activeStreams.add(currentThreadId);
            chatSession.ensureNamedFromPrompt(inputText);
            snapshotManager.saveCheckpoint(currentThreadId, messages.length);
            
            await workflow.runAgentLoop({
              chatSession,
              messages,
              config,
              provider,
              phone,
              ui,
              dbManager,
              stripToolBleed,
              parseFallbackToolCalls,
              setPendingPlan,
              setPlanMenuIndex,
              render,
              syncMessages
            }, inputText);
          });
        } catch (error: any) {
          chatSession.activeStreams.delete(chatSession.threadId);
          chatSession.agentStates.set(chatSession.threadId, 'idle');
          messages.push(new AIMessage(formatChatError(error)));
          syncMessages();
          render(true);
        } finally {
          chatSession.activeStreams.delete(chatSession.threadId);
          render(true);
        }
      };

      async function onKeypress(str: string, key: any) {
        if (key.ctrl && key.name === 'c') {
          // Exit alternate screen before hard-quitting so the terminal is clean
          process.stdout.write('\x1B[?1049l');
          ui.tuiActive = false;
          process.exit(0);
        } else if (key.ctrl && key.name === 'e') {
          diffsExpanded = !diffsExpanded;
          render(true);
          return;
        } else if (key.ctrl && key.name === 'k') {
          cleanup();
          phone.startListening();
          phone.pushView(createCommandPaletteView(phone, actions));
          return;
        } else if (key.ctrl && key.name === 'x') {
          const currentThreadId = chatSession.threadId;
          let actionTaken = false;

          if (getPendingApproval()) {
            const pendingApp = getPendingApproval()!;
            const idx = chatSession.pendingApprovals.indexOf(pendingApp);
            if (idx !== -1) chatSession.pendingApprovals.splice(idx, 1);
            setApprovalMenuIndex(0);
            pendingApp.resolve('deny');
            ui.warning("Command execution cancelled by user.");
            actionTaken = true;
          }

          if (getPendingPlan()) {
            setPendingPlan(false);
            setPlanMenuIndex(0);
            ui.warning("Plan execution cancelled by user.");
            runAgentLoop('cancel - do not proceed with this plan.');
            actionTaken = true;
          }

          if (chatSession.activeStreams.has(currentThreadId) || chatSession.agentStates.get(currentThreadId) === 'tools') {
            chatSession.cancelledThreads.add(currentThreadId);
            ui.warning("Execution terminated by user.");
            actionTaken = true;
          }

          if (actionTaken) {
            render(true);
          }
          return;
        } else if (key.name === 'escape') {
          cleanup();
          resolve();
        } else if (key.name === 'tab') {
          if (getIsStreaming() || getPendingPlan()) return;
          
          if (autocompleteState) {
            const state = autocompleteState;
            const completed = state.matches[state.matchIdx];
            const before = state.isCommand ? '' : state.originalInput.slice(0, state.lastAtIdx !== undefined ? state.lastAtIdx + 1 : 0);
            currentInput = before + completed;
            
            // Advance cycle for next tab press
            state.matchIdx = (state.matchIdx + 1) % state.matches.length;
            render();
            return;
          }
          return;
        } else if (key.name === 'return' || key.name === 'enter') {
          autocompleteState = null;
          // ── SECURITY MENU SELECTION ───────────────────────────────────────
          const pendingApp = getPendingApproval();
          if (pendingApp) {
            const choices = ['now', 'always', 'deny'] as const;
            const choice = choices[getApprovalMenuIndex()];
            
            // Remove from queue
            const idx = chatSession.pendingApprovals.indexOf(pendingApp);
            if (idx !== -1) {
              chatSession.pendingApprovals.splice(idx, 1);
            }
            setApprovalMenuIndex(0);

            // Handle always whitelist
            if (choice === 'always') {
              try {
                const currentConfig = await Configurator.init();
                if (pendingApp.type === 'command') {
                  if (!currentConfig.security.allowedCommands.includes(pendingApp.cmd)) {
                    currentConfig.security.allowedCommands.push(pendingApp.cmd);
                  }
                } else {
                  if (!currentConfig.security.allowedApps.includes(pendingApp.cmd)) {
                    currentConfig.security.allowedApps.push(pendingApp.cmd);
                  }
                }
                if (currentConfig.security.mode === 'ask') {
                  currentConfig.security.mode = 'approve';
                }
                Configurator.saveConfig(currentConfig);
                config = currentConfig;
                provider.setConfig(config);
                phone.updateConfig(config);
              } catch (e) {}
            }

            pendingApp.resolve(choice);
            render(true);
            return;
          }

          // ── PLAN MENU SELECTION ───────────────────────────────────────────
          if (getPendingPlan()) {
            const chosen = PLAN_MENU_OPTIONS[getPlanMenuIndex()];
            if (chosen.inject !== null) {
              setPendingPlan(false);
              setPlanMenuIndex(0);
              runAgentLoop(chosen.inject);
            } else {
              // Edit mode: drop into normal input so user can type modifications
              setPendingPlan(false);
              setPlanMenuIndex(0);
              render(true);
            }
            return;
          }
          // ── NORMAL MESSAGE SEND ─────────────────────────────────────────────
          if (!currentInput.trim()) return;
          const inputStr = currentInput.trim();
          currentInput = '';
          
          if (inputStr === '/rewind') {
            let lastHumanIdx = -1;
            for (let i = messages.length - 1; i >= 0; i--) {
              if (messages[i]._getType() === 'human') {
                lastHumanIdx = i;
                break;
              }
            }
            if (lastHumanIdx >= 0) {
              // Revert files to pre-message checkpoint
              snapshotManager.restoreCheckpoint(chatSession.threadId, lastHumanIdx);
              
              // Clean up checkpoints for the removed turns
              for (let idx = lastHumanIdx; idx < messages.length; idx++) {
                snapshotManager.deleteCheckpoint(chatSession.threadId, idx);
              }

              messages.splice(lastHumanIdx);
              syncMessages();
            }
            render(true);
            return;
          }
          if (chatSession.activeStreams.has(chatSession.threadId)) {
             // Block multiple streams
             return;
          }

          let finalInputStr = inputStr;
          if (inputStr.trim() === '/plan') {
             finalInputStr = 'Please create an implementation_plan.md artifact in the .otto/brain/ directory using your write_file tool. After writing it, output the <!-- PLAN_START --> and <!-- PLAN_END --> tags with a brief summary of the plan so I can review and approve it. Do not execute any further actions until I approve.';
          } else if (inputStr.startsWith('/plan ')) {
             finalInputStr = `Please create an implementation_plan.md artifact in the .otto/brain/ directory using your write_file tool for the following: ${inputStr.slice(6)}\nAfter writing it, output the <!-- PLAN_START --> and <!-- PLAN_END --> tags with a brief summary of the plan so I can review and approve it. Do not execute any further actions until I approve.`;
          } else if (inputStr.startsWith('/goal')) {
             const goalArgs = inputStr.startsWith('/goal ') ? inputStr.slice(6) : 'this task';
             finalInputStr = `You have been given a goal: ${goalArgs}. Work autonomously to achieve it. Use write_file to create an implementation plan in .otto/brain/plan.md and use .otto/brain/task.md to track your progress with [x] checkboxes. Do not stop until the goal is fully complete.`;
          }

          runAgentLoop(finalInputStr);
        } else if (key.name === 'up') {
          if (autocompleteState && autocompleteState.lastAtIdx !== undefined) {
            autocompleteState.matchIdx = (autocompleteState.matchIdx - 1 + autocompleteState.matches.length) % autocompleteState.matches.length;
            const completed = autocompleteState.matches[autocompleteState.matchIdx];
            const before = autocompleteState.originalInput.slice(0, autocompleteState.lastAtIdx + 1);
            currentInput = before + completed;
            render();
            return;
          }
          if (getPendingApproval()) {
            setApprovalMenuIndex((getApprovalMenuIndex() - 1 + 3) % 3);
          } else if (getPendingPlan()) {
            setPlanMenuIndex((getPlanMenuIndex() - 1 + PLAN_MENU_OPTIONS.length) % PLAN_MENU_OPTIONS.length);
          } else {
            chatUI.scrollUp(3);
          }
          render(getIsStreaming());
        } else if (key.name === 'down') {
          if (autocompleteState && autocompleteState.lastAtIdx !== undefined) {
            autocompleteState.matchIdx = (autocompleteState.matchIdx + 1) % autocompleteState.matches.length;
            const completed = autocompleteState.matches[autocompleteState.matchIdx];
            const before = autocompleteState.originalInput.slice(0, autocompleteState.lastAtIdx + 1);
            currentInput = before + completed;
            render();
            return;
          }
          if (getPendingApproval()) {
            setApprovalMenuIndex((getApprovalMenuIndex() + 1) % 3);
          } else if (getPendingPlan()) {
            setPlanMenuIndex((getPlanMenuIndex() + 1) % PLAN_MENU_OPTIONS.length);
          } else {
            chatUI.scrollDown(3);
          }
          render(getIsStreaming());
        } else if (key.name === 'pageup') {
          autocompleteState = null;
          chatUI.scrollUp(Math.max(1, Math.floor(((process.stdout.rows || 24) - 1) / 2)));
          render(getIsStreaming());
        } else if (key.name === 'pagedown') {
          autocompleteState = null;
          chatUI.scrollDown(Math.max(1, Math.floor(((process.stdout.rows || 24) - 1) / 2)));
          render(getIsStreaming());
        } else if (key.name === 'end') {
          autocompleteState = null;
          chatUI.scrollToBottom();
          render(getIsStreaming());
        } else if (key.name === 'backspace' || str === '\x7f' || str === '\x08') {
          autocompleteState = null;
          if (getIsStreaming() || getPendingApproval() || getPendingPlan()) return;
          currentInput = currentInput.slice(0, -1);
          updateAutocompleteState();
          render();
        } else if (str && !key.ctrl && !key.meta) {
          if (key.name === 'tab') return;
          
          if (getPendingApproval()) {
            const char = str.toLowerCase();
            if (char === 'y') {
              const pendingApp = getPendingApproval()!;
              const idx = chatSession.pendingApprovals.indexOf(pendingApp);
              if (idx !== -1) {
                chatSession.pendingApprovals.splice(idx, 1);
              }
              setApprovalMenuIndex(0);
              pendingApp.resolve('now');
              render(true);
              return;
            } else if (char === 'n') {
              const pendingApp = getPendingApproval()!;
              const idx = chatSession.pendingApprovals.indexOf(pendingApp);
              if (idx !== -1) {
                chatSession.pendingApprovals.splice(idx, 1);
              }
              setApprovalMenuIndex(0);
              pendingApp.resolve('deny');
              render(true);
              return;
            } else if (char === 'a') {
              const pendingApp = getPendingApproval()!;
              const idx = chatSession.pendingApprovals.indexOf(pendingApp);
              if (idx !== -1) {
                chatSession.pendingApprovals.splice(idx, 1);
              }
              setApprovalMenuIndex(0);
              
              if (pendingApp.type === 'command') {
                if (!config.security.allowedCommands.includes(pendingApp.cmd)) {
                  config.security.allowedCommands.push(pendingApp.cmd);
                }
              } else {
                if (!config.security.allowedApps.includes(pendingApp.cmd)) {
                  config.security.allowedApps.push(pendingApp.cmd);
                }
              }
              if (config.security.mode === 'ask') {
                config.security.mode = 'approve';
              }
              Configurator.saveConfig(config);
              
              pendingApp.resolve('always');
              render(true);
              return;
            }
            return;
          }

          if (getPendingPlan()) {
            const char = str.toLowerCase();
            if (char === 'y') {
              setPendingPlan(false);
              setPlanMenuIndex(0);
              runAgentLoop('PLAN APPROVED. Do NOT output the plan tags again under any circumstances. Proceed immediately to execute ALL steps continuously.');
              return;
            } else if (char === 'n') {
              setPendingPlan(false);
              setPlanMenuIndex(0);
              runAgentLoop('cancel - do not proceed with this plan.');
              return;
            } else if (char === 'e') {
              setPendingPlan(false);
              setPlanMenuIndex(0);
              render(true);
              return;
            }
            return;
          }

          const code = str.charCodeAt(0);
          if (str.length === 1 && (code < 32 || code === 127) && str !== '\t') return;
          autocompleteState = null;
          if (getIsStreaming()) return;
          currentInput += str;
          updateAutocompleteState();
          render();
        }
      };

      const updateAutocompleteState = () => {
        autocompleteState = null;
        if (currentInput.startsWith('/')) {
          const builtinCmds = ['/plan', '/rewind', '/goal', '/grill-me', '/learn', '/schedule'];
          // Dynamically discover registered skills
          let skillCmds: string[] = [];
          try {
            const { SkillExecutor } = require('./skills/executor.js');
            const names = SkillExecutor.getSkillNames();
            skillCmds = names.map((n: string) => `/${n}`);
          } catch { /* skill system not available */ }
          const allCmds = [...builtinCmds, ...skillCmds.filter(c => !builtinCmds.includes(c))];
          const matches = allCmds.filter(c => c.startsWith(currentInput.toLowerCase()));
          if (matches.length > 0) {
            autocompleteState = {
              originalInput: currentInput,
              matches,
              matchIdx: 0,
              isCommand: true
            };
            return;
          }
        }
        
        const lastAtIdx = currentInput.lastIndexOf('@');
        if (lastAtIdx !== -1 && (!/\s/.test(currentInput.charAt(lastAtIdx + 1)) || currentInput.charAt(lastAtIdx + 1) === '')) {
          const prefix = currentInput.slice(lastAtIdx + 1);
          let dir = '.';
          let filePrefix = prefix;
          if (prefix.includes('/') || prefix.includes('\\')) {
            const normalized = prefix.replace(/\\/g, '/');
            const lastSlash = normalized.lastIndexOf('/');
            dir = prefix.slice(0, lastSlash);
            filePrefix = prefix.slice(lastSlash + 1);
          }
          try {
            const fullDir = path.resolve(process.cwd(), dir);
            if (fs.existsSync(fullDir) && fs.statSync(fullDir).isDirectory()) {
              const entries = fs.readdirSync(fullDir, { withFileTypes: true });
              const matches = entries
                .filter(e => {
                  const name = e.name;
                  if (name.startsWith('.') && !filePrefix.startsWith('.')) return false;
                  if (name === 'node_modules') return false;
                  return name.toLowerCase().startsWith(filePrefix.toLowerCase());
                })
                .map(e => {
                  const relPath = dir === '.' ? e.name : `${dir}/${e.name}`;
                  return e.isDirectory() ? relPath + '/' : relPath;
                });

              if (matches.length > 0) {
                matches.sort((a, b) => {
                  const aIsDir = a.endsWith('/');
                  const bIsDir = b.endsWith('/');
                  if (aIsDir && !bIsDir) return -1;
                  if (!aIsDir && bIsDir) return 1;
                  return a.localeCompare(b);
                });
                autocompleteState = {
                  originalInput: currentInput,
                  lastAtIdx,
                  matches,
                  matchIdx: 0
                };
              }
            }
          } catch (e) {}
        }
      };

      render(getIsStreaming());
      render(getIsStreaming());
    });
  };

  const createProfileView = (): PhoneView => {
    const currentName = Configurator.getUsername(config) || 'user';
    return {
      id: 'profile',
      title: 'Profile',
      subtitle: 'Personalise how O.T.T.O addresses you',
      renderBody: () => {
        const name = Configurator.getUsername(config) || 'user';
        const isDefault = !config.profile?.username;
        console.log(chalk.white.bold('  Current Username'));
        console.log('  ' + chalk.hex('#56CFE1')(name) + (isDefault ? '  ' + chalk.hex('#6B7280')('(default — not set yet)') : ''));
        console.log('');
        console.log(chalk.hex('#6B7280')('  The agent will address you by this name in every conversation.'));
        console.log('');
      },
      options: [
        {
          label: currentName === 'user' || !config.profile?.username
            ? 'Set Username'
            : `Edit Username  (current: ${currentName})`,
          description: 'Enter the name you want the agent to call you',
          action: async () => {
            phone.active = false;
            ui.clearScreen();
            const entered = await promptWithEscape(
              'Enter your preferred username:',
              Configurator.getUsername(config) || ''
            );
            if (entered !== null && entered.trim()) {
              config = Configurator.updateUsername(entered.trim()) || config;
              phone.updateConfig(config);
              ui.success(`Username set to "${entered.trim()}". O.T.T.O will now call you that!`);
              await new Promise(r => setTimeout(r, 1200));
            }
            phone.active = true;
            phone.goBack();
            phone.pushView(createProfileView());
          }
        },
        {
          label: 'Reset to Default  (user)',
          description: 'Clear the custom username',
          action: async () => {
            config = Configurator.updateUsername('') || config;
            // clear it properly
            if (config.profile) config.profile.username = undefined;
            const raw = Configurator.loadConfig();
            if (raw?.profile) { raw.profile.username = undefined; Configurator.saveConfig(raw); config = raw; }
            phone.updateConfig(config);
            ui.success('Username reset to default.');
            await new Promise(r => setTimeout(r, 900));
            phone.goBack();
            phone.pushView(createProfileView());
          }
        },
        { label: 'Go Back', action: () => phone.goBack() }
      ]
    };
  };

  const createModelVariantLimitsView = (
    providerName: ProviderName,
    model: string,
    providerLabel: string,
    defaultModel: string,
    examples: string
  ): PhoneView => {
    const limits = config.modelLimits?.[model] || {};
    return {
      id: `model_limit_settings_${model}`,
      title: `${model} Settings`,
      subtitle: `Configure limits for ${model}`,
      renderBody: () => {
        console.log(chalk.white.bold('  Current Limits (empty means unlimited)'));
        console.log(`    RPM (Requests / min):  \x1b[36m${limits.rpm ?? 'unlimited'}\x1b[0m`);
        console.log(`    RPD (Requests / day):  \x1b[36m${limits.rpd ?? 'unlimited'}\x1b[0m`);
        console.log(`    TPM (Tokens / min):    \x1b[36m${limits.tpm ?? 'unlimited'}\x1b[0m`);
        console.log(`    TPD (Tokens / day):    \x1b[36m${limits.tpd ?? 'unlimited'}\x1b[0m`);
        console.log(`    ITPM (Input tk / min): \x1b[36m${limits.itpm ?? 'unlimited'}\x1b[0m`);
        console.log(`    OTPM (Output tk / min):\x1b[36m${limits.otpm ?? 'unlimited'}\x1b[0m`);
        console.log('');
      },
      options: [
        {
          label: 'Rename Model Variant',
          description: 'Rename this model name',
          action: async () => {
            phone.active = false;
            ui.clearScreen();
            const nextName = await promptWithEscape(`Rename ${model} to:`, model);
            if (nextName && nextName.trim() && nextName.trim() !== model) {
              config = Configurator.renameModelVariant(providerName, model, nextName.trim()) || config;
              provider.setConfig(config);
              phone.updateConfig(config);
              ui.success(`Renamed ${model} to ${nextName.trim()}`);
              await new Promise(r => setTimeout(r, 800));
            }
            phone.active = true;
            phone.goBack();
            phone.goBack();
            phone.pushView(createModelVariantLimitsView(providerName, nextName && nextName.trim() ? nextName.trim() : model, providerLabel, defaultModel, examples));
          }
        },
        ...([
          { name: 'rpm', label: 'RPM (Requests per minute)' },
          { name: 'rpd', label: 'RPD (Requests per day)' },
          { name: 'tpm', label: 'TPM (Tokens per minute)' },
          { name: 'tpd', label: 'TPD (Tokens per day)' },
          { name: 'itpm', label: 'ITPM (Input tokens per minute)' },
          { name: 'otpm', label: 'OTPM (Output tokens per minute)' }
        ] as const).map(limitOpt => ({
          label: `Edit ${limitOpt.label}  [${limits[limitOpt.name] ?? 'none'}]`,
          action: async () => {
            phone.active = false;
            ui.clearScreen();
            const entered = await promptWithEscape(
              `Enter ${limitOpt.label} for ${model} (leave empty to disable):`,
              limits[limitOpt.name] !== undefined ? String(limits[limitOpt.name]) : ''
            );
            if (entered !== null) {
              const val = entered.trim() ? parseInt(entered.trim(), 10) : undefined;
              config = Configurator.updateModelLimit(model, limitOpt.name, val) || config;
              provider.setConfig(config);
              phone.updateConfig(config);
              ui.success(`Updated ${limitOpt.name} limit.`);
              await new Promise(r => setTimeout(r, 800));
            }
            phone.active = true;
            phone.goBack();
            phone.pushView(createModelVariantLimitsView(providerName, model, providerLabel, defaultModel, examples));
          }
        })),
        {
          label: 'Go Back',
          action: () => {
            phone.goBack();
            phone.goBack();
            phone.pushView(createProviderModelView(providerName, providerLabel, defaultModel, examples));
          }
        }
      ]
    };
  };

  const createMaxThreadsView = (): PhoneView => {
    const maxT  = Configurator.getMaxThreads(config);
    const cores = require('os').cpus().length;
    const cpuDefault = Math.min(20, Math.max(5, cores * 2));
    return {
      id: 'max_threads',
      title: 'Max Threads',
      subtitle: 'Limit the number of saved sessions',
      renderBody: () => {
        const cur = Configurator.getMaxThreads(config);
        const cnt = dbManager.listThreads().length;
        console.log(chalk.white.bold('  Current Limit'));
        console.log('  ' + chalk.hex('#56CFE1')(String(cur)) + chalk.hex('#6B7280')(`  (${cnt} sessions stored)`));
        console.log('');
        console.log(chalk.hex('#6B7280')(`  CPU-healthy default for this machine: ${cpuDefault}  (${cores} cores × 2, capped at 20)`));
        console.log(chalk.hex('#6B7280')('  Older threads are kept but new ones cannot be created when at the limit.'));
        console.log('');
      },
      options: [
        {
          label: `Increase limit  (currently ${maxT})`,
          description: 'Allow more saved sessions',
          action: async () => {
            phone.active = false;
            ui.clearScreen();
            const entered = await promptWithEscape(`New max threads (current: ${maxT}):`);
            const n = parseInt(entered ?? '', 10);
            if (!isNaN(n) && n > 0) {
              config = Configurator.updateMaxThreads(n) || config;
              phone.updateConfig(config);
              ui.success(`Max threads set to ${n}.`);
              await new Promise(r => setTimeout(r, 900));
            }
            phone.active = true;
            phone.goBack();
            phone.pushView(createMaxThreadsView());
          }
        },
        {
          label: `Decrease limit  (currently ${maxT})`,
          description: 'Keep fewer sessions around',
          action: async () => {
            phone.active = false;
            ui.clearScreen();
            const entered = await promptWithEscape(`New max threads (current: ${maxT}):`);
            const n = parseInt(entered ?? '', 10);
            if (!isNaN(n) && n > 0) {
              config = Configurator.updateMaxThreads(n) || config;
              phone.updateConfig(config);
              ui.success(`Max threads set to ${n}.`);
              await new Promise(r => setTimeout(r, 900));
            }
            phone.active = true;
            phone.goBack();
            phone.pushView(createMaxThreadsView());
          }
        },
        {
          label: `Reset to CPU default  (${cpuDefault})`,
          description: 'Restore the automatically calculated healthy limit',
          action: async () => {
            config = Configurator.updateMaxThreads(cpuDefault) || config;
            phone.updateConfig(config);
            ui.success(`Max threads reset to ${cpuDefault}.`);
            await new Promise(r => setTimeout(r, 900));
            phone.goBack();
            phone.pushView(createMaxThreadsView());
          }
        },
        { label: 'Go Back', action: () => phone.goBack() }
      ]
    };
  };

  const createMaxCtxView = (): PhoneView => {
    const cur = config.defaults.maxCtx ?? 64000;
    return {
      id: 'max_ctx',
      title: 'Max Context Size',
      subtitle: 'Configure maximum memory tokens',
      renderBody: () => {
        const currentCap = config.defaults.maxCtx ?? 64000;
        console.log(chalk.white.bold('  Current Context Limit'));
        console.log('  ' + chalk.hex('#56CFE1')(String(currentCap)) + ' tokens');
        console.log('');
        console.log(chalk.hex('#6B7280')('  Default: 64,000 tokens.'));
        console.log(chalk.hex('#6B7280')('  This controls the threshold where context pruning occurs.'));
        console.log('');
      },
      options: [
        {
          label: `Change limit  (currently ${cur})`,
          action: async () => {
            phone.active = false;
            ui.clearScreen();
            const entered = await promptWithEscape(`New context token cap (current: ${cur}):`);
            const n = parseInt(entered ?? '', 10);
            if (!isNaN(n) && n >= 1000) {
              config = Configurator.updateMaxCtx(n) || config;
              phone.updateConfig(config);
              ui.success(`Max context size set to ${n} tokens.`);
              await new Promise(r => setTimeout(r, 900));
            }
            phone.active = true;
            phone.goBack();
            phone.pushView(createMaxCtxView());
          }
        },
        {
          label: 'Reset to Default  (64,000)',
          action: async () => {
            config = Configurator.updateMaxCtx(64000) || config;
            phone.updateConfig(config);
            ui.success('Max context size reset to 64,000 tokens.');
            await new Promise(r => setTimeout(r, 900));
            phone.goBack();
            phone.pushView(createMaxCtxView());
          }
        },
        { label: 'Go Back', action: () => phone.goBack() }
      ]
    };
  };

  const createSettingsView = (): PhoneView => ({
    id: 'settings',
    title: 'Settings & Security',
    subtitle: 'Manage keys, models, security mode, and display',
    options: [
      {
        label: 'Profile',
        description: 'Set the username O.T.T.O uses to address you',
        action: async () => { phone.pushView(createProfileView()); }
      },
      {
        label: `Max Threads  [${Configurator.getMaxThreads(config)}]`,
        description: 'Limit stored sessions to reduce memory pressure',
        action: async () => { phone.pushView(createMaxThreadsView()); }
      },
      {
        label: `Max Context Size  [${config.defaults.maxCtx ?? 64000}]`,
        description: 'Set maximum token limit for context window',
        action: async () => { phone.pushView(createMaxCtxView()); }
      },
      {
        label: 'API Settings',
        description: 'Add, select, and rotate provider API keys',
        action: async () => { phone.pushView(createApiEditView()); }
      },
      {
        label: 'Edit Models',
        description: 'Set the model name used for each provider',
        action: async () => { phone.pushView(createModelEditView()); }
      },
      {
        label: 'Edit Ollama Base URL',
        description: 'Set localhost or remote URL for Ollama',
        action: async () => {
          phone.active = false;
          ui.clearScreen();
          const currentUrl = config.providers.ollama?.baseUrl || 'http://localhost:11434';
          const entered = await promptWithEscape(`Enter new Ollama Base URL (current: ${currentUrl}):`);
          if (entered !== null && entered.trim()) {
            config = Configurator.updateOllamaUrl(entered.trim()) || config;
            phone.updateConfig(config);
            ui.success(`Ollama URL updated to ${entered.trim()}`);
            await new Promise(r => setTimeout(r, 900));
          }
          phone.active = true;
          phone.goBack();
          phone.pushView(createSettingsView());
        }
      },
      {
        label: 'Allowed Tools & Commands',
        description: 'Set the execution guardrail policy',
        action: async () => { phone.pushView(createSecurityEditView()); }
      },
      {
        label: `Toggle Context Bar  [${config.defaults.showContextBar !== false ? 'ON' : 'OFF'}]`,
        description: 'Show or hide the context budget indicator',
        action: async () => {
          const current = config.defaults.showContextBar !== false;
          config = Configurator.updateContextBar(!current) || config;
          phone.updateConfig(config);
          phone.render();
        }
      },
      { label: 'Go Back', action: () => phone.goBack() }
    ]
  });


  const createProviderModelView = (
    providerName: 'groq' | 'openai' | 'anthropic' | 'ollama' | 'gemini' | 'mistral' | 'bedrock' | 'nvidia',
    providerLabel: string,
    defaultModel: string,
    examples: string
  ): PhoneView => {
    const currentModels = Configurator.getModelVariants(config, providerName);
    const activeModel = Configurator.getActiveModel(config, providerName) ?? defaultModel;

    return {
      id: `${providerName}_models`,
      title: `${providerLabel} Models`,
      subtitle: 'Add, select, or remove model variants',
      renderBody: () => {
        console.log(chalk.white.bold('  Active Model'));
        console.log('  ' + chalk.hex('#56CFE1')(activeModel));
        console.log('');
        console.log(chalk.white.bold('  Saved Variants'));
        if (currentModels.length === 0) {
          console.log('  ' + chalk.dim('No saved variants yet.'));
        } else {
          currentModels.forEach(model => {
            const mark = model === activeModel ? chalk.hex('#f5c542')('*') : chalk.dim('-');
            console.log(`  ${mark} ${chalk.white(model)}`);
          });
        }
        console.log('');
      },
      options: [
        {
          label: 'Add Model Variant',
          description: examples,
          action: async () => {
            phone.active = false;
            ui.clearScreen();
            const m = await promptWithEscape(`${providerLabel} model name:`);
            if (m && m.trim()) {
              config = Configurator.addModelVariant(providerName, m.trim()) || config;
              provider.setConfig(config);
              phone.updateConfig(config);
              ui.success(`Added ${m.trim()}.`);
              await new Promise(r => setTimeout(r, 1000));
            }
            phone.active = true;
            phone.goBack();
            phone.pushView(createProviderModelView(providerName, providerLabel, defaultModel, examples));
          }
        },
        {
          label: 'Select Active Model',
          description: 'Choose which saved model to use',
          action: () => phone.pushView({
            id: `${providerName}_model_select`,
            title: `Select ${providerLabel} Model`,
            options: [
              ...currentModels.map(model => ({
                label: model,
                action: async () => {
                  config = Configurator.setActiveModel(providerName, model) || config;
                  provider.setConfig(config);
                  phone.updateConfig(config);
                  ui.success(`Active ${providerLabel} model set to ${model}`);
                  await new Promise(r => setTimeout(r, 800));
                  phone.goBack();
                  phone.goBack();
                  phone.pushView(createProviderModelView(providerName, providerLabel, defaultModel, examples));
                }
              })),
              { label: 'Go Back', action: () => phone.goBack() }
            ]
          })
        },
        {
          label: 'Remove Model Variant',
          description: 'Delete a saved model from this provider',
          action: () => phone.pushView({
            id: `${providerName}_model_remove`,
            title: `Remove ${providerLabel} Model`,
            options: [
              ...currentModels.map(model => ({
                label: model,
                action: async () => {
                  config = Configurator.removeModelVariant(providerName, model) || config;
                  provider.setConfig(config);
                  phone.updateConfig(config);
                  ui.success(`Removed ${model}`);
                  await new Promise(r => setTimeout(r, 800));
                  phone.goBack();
                  phone.goBack();
                  phone.pushView(createProviderModelView(providerName, providerLabel, defaultModel, examples));
                }
              })),
              { label: 'Go Back', action: () => phone.goBack() }
            ]
          })
        },
        {
          label: 'Edit Model Variant Settings',
          description: 'Configure name and rate limits (RPM, RPD, TPM, TPD, etc.)',
          action: () => phone.pushView({
            id: `${providerName}_model_edit_variants_list`,
            title: `Edit ${providerLabel} Settings`,
            options: [
              ...currentModels.map(model => ({
                label: model,
                action: () => phone.pushView(createModelVariantLimitsView(providerName, model, providerLabel, defaultModel, examples))
              })),
              { label: 'Go Back', action: () => phone.goBack() }
            ]
          })
        },
        { label: 'Go Back', action: () => phone.goBack() }
      ]
    };
  };

  const createModelEditView = (): PhoneView => ({
    id: 'model_edit',
    title: 'Edit Models',
    subtitle: 'Manage multiple model variants per provider',
    options: [
      {
        label: `Groq  ${Configurator.getActiveModel(config, 'groq') ? '-> ' + Configurator.getActiveModel(config, 'groq') : '(default: qwen-qwq-32b)'}`,
        description: 'e.g. qwen-qwq-32b, llama-3.3-70b-versatile, mixtral-8x7b-32768',
        action: async () => phone.pushView(createProviderModelView('groq', 'Groq', 'qwen-qwq-32b', 'e.g. qwen-qwq-32b, llama-3.3-70b-versatile, mixtral-8x7b-32768'))
      },
      {
        label: `OpenAI  ${Configurator.getActiveModel(config, 'openai') ? '-> ' + Configurator.getActiveModel(config, 'openai') : '(default: gpt-4o)'}`,
        description: 'e.g. gpt-4o, gpt-4o-mini, gpt-4-turbo, o1-preview',
        action: async () => phone.pushView(createProviderModelView('openai', 'OpenAI', 'gpt-4o', 'e.g. gpt-4o, gpt-4o-mini, gpt-4-turbo, o1-preview'))
      },
      {
        label: `Anthropic  ${Configurator.getActiveModel(config, 'anthropic') ? '-> ' + Configurator.getActiveModel(config, 'anthropic') : '(default: claude-3-5-sonnet-20241022)'}`,
        description: 'e.g. claude-3-5-sonnet-20241022, claude-3-haiku-20240307',
        action: async () => phone.pushView(createProviderModelView('anthropic', 'Anthropic', 'claude-3-5-sonnet-20241022', 'e.g. claude-3-5-sonnet-20241022, claude-3-haiku-20240307'))
      },
      {
        label: `Gemini  ${Configurator.getActiveModel(config, 'gemini') ? '-> ' + Configurator.getActiveModel(config, 'gemini') : '(default: gemini-1.5-pro)'}`,
        description: 'e.g. gemini-1.5-pro, gemini-1.5-flash',
        action: async () => phone.pushView(createProviderModelView('gemini', 'Gemini', 'gemini-1.5-pro', 'e.g. gemini-1.5-pro, gemini-1.5-flash'))
      },
      {
        label: `Ollama  ${Configurator.getActiveModel(config, 'ollama') ? '-> ' + Configurator.getActiveModel(config, 'ollama') : '(default: llama3)'}`,
        description: 'e.g. llama3, mistral, phi3',
        action: async () => phone.pushView(createProviderModelView('ollama', 'Ollama', 'llama3', 'e.g. llama3, mistral, phi3'))
      },
      {
        label: `Mistral  ${Configurator.getActiveModel(config, 'mistral') ? '-> ' + Configurator.getActiveModel(config, 'mistral') : '(default: mistral-large-latest)'}`,
        description: 'e.g. mistral-large-latest, open-mixtral-8x22b, codestral-latest',
        action: async () => phone.pushView(createProviderModelView('mistral', 'Mistral', 'mistral-large-latest', 'e.g. mistral-large-latest, open-mixtral-8x22b, codestral-latest'))
      },
      {
        label: `AWS Bedrock  ${Configurator.getActiveModel(config, 'bedrock') ? '-> ' + Configurator.getActiveModel(config, 'bedrock') : '(default: us.amazon.nova-pro-v1:0)'}`,
        description: 'e.g. us.amazon.nova-pro-v1:0, us.anthropic.claude-3-5-sonnet-20241022-v2:0',
        action: async () => phone.pushView(createProviderModelView('bedrock', 'AWS Bedrock', 'us.amazon.nova-pro-v1:0', 'e.g. us.amazon.nova-pro-v1:0, us.anthropic.claude-3-5-sonnet-20241022-v2:0'))
      },
      {
        label: `NVIDIA  ${Configurator.getActiveModel(config, 'nvidia') ? '-> ' + Configurator.getActiveModel(config, 'nvidia') : '(default: meta/llama-3.3-70b-instruct)'}`,
        description: 'e.g. meta/llama-3.3-70b-instruct, meta/llama-3.1-405b-instruct',
        action: async () => phone.pushView(createProviderModelView('nvidia', 'NVIDIA', 'meta/llama-3.3-70b-instruct', 'e.g. meta/llama-3.3-70b-instruct, meta/llama-3.1-405b-instruct'))
      },
    ]
  });

  const maskApiKey = (key: string) => {
    if (!key) return '(empty)';
    if (key.length <= 10) return key.slice(0, 2) + '...' + key.slice(-2);
    return key.slice(0, 6) + '...' + key.slice(-4);
  };

  const createProviderApiKeyView = (
    providerName: 'groq' | 'openai' | 'anthropic' | 'gemini' | 'mistral' | 'nvidia',
    providerLabel: string
  ): PhoneView => {
    const apiKeys = Configurator.getApiKeys(config, providerName);
    const activeKey = Configurator.getActiveApiKey(config, providerName);

    return {
      id: `${providerName}_api_keys`,
      title: `${providerLabel} API Keys`,
      subtitle: 'Add, select, or remove keys used for automatic rotation',
      renderBody: () => {
        console.log(chalk.white.bold('  Active Key'));
        console.log('  ' + chalk.hex('#56CFE1')(activeKey ? maskApiKey(activeKey) : '(none)'));
        console.log('');
        console.log(chalk.white.bold('  Saved Keys'));
        if (apiKeys.length === 0) {
          console.log('  ' + chalk.dim('No saved keys yet.'));
        } else {
          apiKeys.forEach(key => {
            const mark = key === activeKey ? chalk.hex('#f5c542')('*') : chalk.dim('-');
            console.log(`  ${mark} ${chalk.white(maskApiKey(key))}`);
          });
        }
        console.log('');
      },
      options: [
        {
          label: 'Add API Key',
          description: 'Save another key for this provider',
          action: async () => {
            phone.active = false;
            ui.clearScreen();
            const newKey = await promptWithEscape(`Enter API Key for ${providerLabel}:`);
            if (newKey && newKey.trim()) {
              config = Configurator.addApiKey(providerName, newKey.trim()) || config;
              provider.setConfig(config);
              phone.updateConfig(config);
              ui.success('Saved API key.');
              await new Promise(r => setTimeout(r, 800));
            }
            phone.active = true;
            phone.goBack();
            phone.pushView(createProviderApiKeyView(providerName, providerLabel));
          }
        },
        {
          label: 'Select Active Key',
          description: 'Choose which key is used first',
          action: () => phone.pushView({
            id: `${providerName}_api_key_select`,
            title: `Select ${providerLabel} Key`,
            options: [
              ...apiKeys.map(key => ({
                label: `${key === activeKey ? '* ' : ''}${maskApiKey(key)}`,
                action: async () => {
                  config = Configurator.setActiveApiKey(providerName, key) || config;
                  provider.setConfig(config);
                  phone.updateConfig(config);
                  ui.success(`Active ${providerLabel} key updated.`);
                  await new Promise(r => setTimeout(r, 800));
                  phone.goBack();
                  phone.goBack();
                  phone.pushView(createProviderApiKeyView(providerName, providerLabel));
                }
              })),
              { label: 'Go Back', action: () => phone.goBack() }
            ]
          })
        },
        {
          label: 'Remove API Key',
          description: 'Delete a saved key from rotation',
          action: () => phone.pushView({
            id: `${providerName}_api_key_remove`,
            title: `Remove ${providerLabel} Key`,
            options: [
              ...apiKeys.map(key => ({
                label: `${key === activeKey ? '* ' : ''}${maskApiKey(key)}`,
                action: async () => {
                  config = Configurator.removeApiKey(providerName, key) || config;
                  provider.setConfig(config);
                  phone.updateConfig(config);
                  ui.success(`Removed ${providerLabel} key.`);
                  await new Promise(r => setTimeout(r, 800));
                  phone.goBack();
                  phone.goBack();
                  phone.pushView(createProviderApiKeyView(providerName, providerLabel));
                }
              })),
              { label: 'Go Back', action: () => phone.goBack() }
            ]
          })
        },
        { label: 'Go Back', action: () => phone.goBack() }
      ]
    };
  };

  const createBedrockSettingsView = (): PhoneView => {
    const entry = config.providers.bedrock || {};
    return {
      id: 'bedrock_settings',
      title: 'AWS Bedrock Config',
      subtitle: 'Manage AWS region and credential settings',
      renderBody: () => {
        console.log(chalk.white.bold('  Current Configuration'));
        console.log(`  Region:           ${chalk.hex('#56CFE1')(entry.region || 'us-east-1')}`);
        console.log(`  Access Key ID:    ${chalk.hex('#56CFE1')(entry.accessKeyId ? maskApiKey(entry.accessKeyId) : '(using AWS env/IAM)')}`);
        console.log(`  Secret Key:       ${chalk.hex('#56CFE1')(entry.secretAccessKey ? '********' : '(using AWS env/IAM)')}`);
        console.log(`  Session Token:    ${chalk.hex('#56CFE1')(entry.sessionToken ? '********' : '(none)')}`);
        console.log('');
      },
      options: [
        {
          label: 'Set AWS Region',
          action: async () => {
            phone.active = false;
            ui.clearScreen();
            const val = await promptWithEscape(`Enter AWS Region:`, entry.region || 'us-east-1');
            if (val !== null && val.trim()) {
              if (!config.providers.bedrock) config.providers.bedrock = {};
              config.providers.bedrock.region = val.trim();
              Configurator.saveConfig(config);
              phone.updateConfig(config);
              ui.success(`Region updated to ${val.trim()}`);
              await new Promise(r => setTimeout(r, 900));
            }
            phone.active = true;
            phone.goBack();
            phone.pushView(createBedrockSettingsView());
          }
        },
        {
          label: 'Set AWS Access Key ID',
          action: async () => {
            phone.active = false;
            ui.clearScreen();
            const val = await promptWithEscape(`Enter Access Key ID:`, entry.accessKeyId || '');
            if (val !== null) {
              if (!config.providers.bedrock) config.providers.bedrock = {};
              config.providers.bedrock.accessKeyId = val.trim() || undefined;
              Configurator.saveConfig(config);
              phone.updateConfig(config);
              ui.success('Access Key ID updated.');
              await new Promise(r => setTimeout(r, 900));
            }
            phone.active = true;
            phone.goBack();
            phone.pushView(createBedrockSettingsView());
          }
        },
        {
          label: 'Set AWS Secret Access Key',
          action: async () => {
            phone.active = false;
            ui.clearScreen();
            const val = await promptWithEscape(`Enter Secret Access Key:`, entry.secretAccessKey || '');
            if (val !== null) {
              if (!config.providers.bedrock) config.providers.bedrock = {};
              config.providers.bedrock.secretAccessKey = val.trim() || undefined;
              Configurator.saveConfig(config);
              phone.updateConfig(config);
              ui.success('Secret Access Key updated.');
              await new Promise(r => setTimeout(r, 900));
            }
            phone.active = true;
            phone.goBack();
            phone.pushView(createBedrockSettingsView());
          }
        },
        {
          label: 'Set AWS Session Token',
          action: async () => {
            phone.active = false;
            ui.clearScreen();
            const val = await promptWithEscape(`Enter Session Token:`, entry.sessionToken || '');
            if (val !== null) {
              if (!config.providers.bedrock) config.providers.bedrock = {};
              config.providers.bedrock.sessionToken = val.trim() || undefined;
              Configurator.saveConfig(config);
              phone.updateConfig(config);
              ui.success('Session Token updated.');
              await new Promise(r => setTimeout(r, 900));
            }
            phone.active = true;
            phone.goBack();
            phone.pushView(createBedrockSettingsView());
          }
        },
        {
          label: `Toggle API Client: ${entry.useChatBedrock ? 'Legacy BedrockChat' : 'Converse API'}`,
          description: 'Switch between ChatBedrockConverse and legacy BedrockChat clients',
          action: async () => {
            if (!config.providers.bedrock) config.providers.bedrock = {};
            config.providers.bedrock.useChatBedrock = !config.providers.bedrock.useChatBedrock;
            Configurator.saveConfig(config);
            phone.updateConfig(config);
            ui.success(`Bedrock API Client set to ${config.providers.bedrock.useChatBedrock ? 'BedrockChat' : 'ChatBedrockConverse'}`);
            await new Promise(r => setTimeout(r, 900));
            phone.goBack();
            phone.pushView(createBedrockSettingsView());
          }
        },
        { label: 'Go Back', action: () => phone.goBack() }
      ]
    };
  };

  const createApiEditView = (): PhoneView => ({
    id: 'api_keys',
    title: 'API Settings',
    subtitle: 'Manage multiple API keys per provider',
    options: [
      {
        label: `Groq  ${Configurator.getApiKeys(config, 'groq').length} key(s)`,
        description: Configurator.getActiveApiKey(config, 'groq') ? `active: ${maskApiKey(Configurator.getActiveApiKey(config, 'groq')!)}` : 'no key',
        action: async () => phone.pushView(createProviderApiKeyView('groq', 'Groq'))
      },
      {
        label: `OpenAI  ${Configurator.getApiKeys(config, 'openai').length} key(s)`,
        description: Configurator.getActiveApiKey(config, 'openai') ? `active: ${maskApiKey(Configurator.getActiveApiKey(config, 'openai')!)}` : 'no key',
        action: async () => phone.pushView(createProviderApiKeyView('openai', 'OpenAI'))
      },
      {
        label: `Anthropic  ${Configurator.getApiKeys(config, 'anthropic').length} key(s)`,
        description: Configurator.getActiveApiKey(config, 'anthropic') ? `active: ${maskApiKey(Configurator.getActiveApiKey(config, 'anthropic')!)}` : 'no key',
        action: async () => phone.pushView(createProviderApiKeyView('anthropic', 'Anthropic'))
      },
      {
        label: `Gemini  ${Configurator.getApiKeys(config, 'gemini').length} key(s)`,
        description: Configurator.getActiveApiKey(config, 'gemini') ? `active: ${maskApiKey(Configurator.getActiveApiKey(config, 'gemini')!)}` : 'no key',
        action: async () => phone.pushView(createProviderApiKeyView('gemini', 'Gemini'))
      },
      {
        label: `Mistral  ${Configurator.getApiKeys(config, 'mistral').length} key(s)`,
        description: Configurator.getActiveApiKey(config, 'mistral') ? `active: ${maskApiKey(Configurator.getActiveApiKey(config, 'mistral')!)}` : 'no key',
        action: async () => phone.pushView(createProviderApiKeyView('mistral', 'Mistral'))
      },
      {
        label: 'AWS Bedrock Credentials',
        description: config.providers.bedrock?.region ? `region: ${config.providers.bedrock.region}` : 'Not configured (uses env/IAM by default)',
        action: async () => phone.pushView(createBedrockSettingsView())
      },
      {
        label: `NVIDIA  ${Configurator.getApiKeys(config, 'nvidia').length} key(s)`,
        description: Configurator.getActiveApiKey(config, 'nvidia') ? `active: ${maskApiKey(Configurator.getActiveApiKey(config, 'nvidia')!)}` : 'no key',
        action: async () => phone.pushView(createProviderApiKeyView('nvidia', 'NVIDIA'))
      },
      { label: 'Go Back', action: () => phone.goBack() }
    ]
  });

  const createWhitelistRemoveView = (): PhoneView => ({
    id: 'security_whitelist_remove',
    title: 'Remove Whitelisted Command',
    subtitle: 'Select a command to remove from the whitelist',
    options: [
      ...config.security.allowedCommands.map(cmd => ({
        label: cmd,
        action: async () => {
          config = Configurator.updateAllowedCommands(
            config.security.allowedCommands.filter(current => current !== cmd)
          ) || config;
          phone.updateConfig(config);
          ui.success(`Removed ${cmd} from whitelist.`);
          await new Promise(r => setTimeout(r, 800));
          phone.goBack();
          phone.goBack();
          phone.pushView(createSecurityEditView());
        }
      })),
      { label: 'Go Back', action: () => phone.goBack() }
    ]
  });

  const createSecurityEditView = (): PhoneView => ({
    id: 'security_mode',
    title: 'Security Mode',
    subtitle: 'Set the execution guardrail policy',
    renderBody: () => {
      console.log(chalk.white.bold('  Whitelisted Commands'));
      if (config.security.allowedCommands.length === 0) {
        console.log('  ' + chalk.dim('No commands whitelisted.'));
      } else {
        config.security.allowedCommands.forEach(cmd => {
          console.log('  ' + chalk.hex('#56CFE1')('•') + ' ' + chalk.white(cmd));
        });
      }
      console.log('');
    },
    options: [
      {
        label: `Ask for approval  ${config.security.mode === 'ask' ? '✓ (active)' : ''}`,
        description: 'Prompt before every action — safest',
        action: async () => {
          config = Configurator.updateSecurityMode('ask') || config;
          phone.updateConfig(config);
          ui.success('Set to Ask.'); await new Promise(r => setTimeout(r, 1000));
          phone.goBack(); phone.pushView(createSecurityEditView());
        }
      },
      {
        label: `Approve for me  ${config.security.mode === 'approve' ? '✓ (active)' : ''}`,
        description: 'Auto-approve whitelisted commands silently',
        action: async () => {
          config = Configurator.updateSecurityMode('approve') || config;
          phone.updateConfig(config);
          ui.success('Set to Approve.'); await new Promise(r => setTimeout(r, 1000));
          phone.goBack(); phone.pushView(createSecurityEditView());
        }
      },
      {
        label: `Full access  ${config.security.mode === 'full' ? '✓ (active)' : ''}`,
        description: 'No guardrails — dangerous',
        action: async () => {
          config = Configurator.updateSecurityMode('full') || config;
          phone.updateConfig(config);
          ui.success('Set to Full.'); await new Promise(r => setTimeout(r, 1000));
          phone.goBack(); phone.pushView(createSecurityEditView());
        }
      },
      {
        label: 'Add Whitelisted Command',
        description: 'Allow a command for approve mode',
        action: async () => {
          phone.active = false;
          ui.clearScreen();
          const cmd = await promptWithEscape('Add command to whitelist:');
          if (cmd && cmd.trim()) {
            const nextCommands = Array.from(new Set([...config.security.allowedCommands, cmd.trim()]));
            config = Configurator.updateAllowedCommands(nextCommands) || config;
            phone.updateConfig(config);
            ui.success(`Added ${cmd.trim()} to whitelist.`);
            await new Promise(r => setTimeout(r, 800));
          }
          phone.active = true;
          phone.goBack();
          phone.pushView(createSecurityEditView());
        }
      },
      {
        label: 'Remove Whitelisted Command',
        description: 'Delete a command from the whitelist',
        action: () => phone.pushView(createWhitelistRemoveView())
      },
      { label: 'Go Back', action: () => phone.goBack() }
    ]
  });

  const createProviderView = (): PhoneView => ({
    id: 'provider',
    title: 'Switch Provider',
    subtitle: 'Change the active LLM inference engine',
    options: [
      {
        label: `Groq  ${config.defaults.primaryProvider === 'groq' ? '[active]' : ''}  ${Configurator.getActiveApiKey(config, 'groq') ? '' : '-- no key'}`,
        description: Configurator.getActiveModel(config, 'groq') ? `model: ${Configurator.getActiveModel(config, 'groq')}` : 'model: qwen-qwq-32b (default)',
        action: async () => {
          if (!Configurator.getActiveApiKey(config, 'groq')) {
            phone.active = false;
            ui.clearScreen();
            const key = await promptWithEscape('Enter API Key for Groq:');
            if (key === null) {
              phone.active = true;
              phone.goBack();
              phone.pushView(createProviderView());
              return;
            }
            config = Configurator.updateApiKey('groq', key) || config;
            phone.active = true;
          }
          config = Configurator.updatePrimaryProvider('groq') || config;
          provider.setConfig(config);
          phone.updateConfig(config);
          ui.success('Switched to Groq.');
          await new Promise(r => setTimeout(r, 1000));
          phone.goBack(); phone.pushView(createProviderView());
        }
      },
      {
        label: `OpenAI  ${config.defaults.primaryProvider === 'openai' ? '[active]' : ''}  ${Configurator.getActiveApiKey(config, 'openai') ? '' : '-- no key'}`,
        description: Configurator.getActiveModel(config, 'openai') ? `model: ${Configurator.getActiveModel(config, 'openai')}` : 'model: gpt-4o (default)',
        action: async () => {
          if (!Configurator.getActiveApiKey(config, 'openai')) {
            phone.active = false;
            ui.clearScreen();
            const key = await promptWithEscape('Enter API Key for OpenAI:');
            if (key === null) {
              phone.active = true;
              phone.goBack();
              phone.pushView(createProviderView());
              return;
            }
            config = Configurator.updateApiKey('openai', key) || config;
            phone.active = true;
          }
          config = Configurator.updatePrimaryProvider('openai') || config;
          provider.setConfig(config);
          phone.updateConfig(config);
          ui.success('Switched to OpenAI.');
          await new Promise(r => setTimeout(r, 1000));
          phone.goBack(); phone.pushView(createProviderView());
        }
      },
      {
        label: `Anthropic  ${config.defaults.primaryProvider === 'anthropic' ? '[active]' : ''}  ${Configurator.getActiveApiKey(config, 'anthropic') ? '' : '-- no key'}`,
        description: Configurator.getActiveModel(config, 'anthropic') ? `model: ${Configurator.getActiveModel(config, 'anthropic')}` : 'model: claude-3-5-sonnet-20241022 (default)',
        action: async () => {
          if (!Configurator.getActiveApiKey(config, 'anthropic')) {
            phone.active = false;
            ui.clearScreen();
            const key = await promptWithEscape('Enter API Key for Anthropic:');
            if (key === null) {
              phone.active = true;
              phone.goBack();
              phone.pushView(createProviderView());
              return;
            }
            config = Configurator.updateApiKey('anthropic', key) || config;
            phone.active = true;
          }
          config = Configurator.updatePrimaryProvider('anthropic') || config;
          provider.setConfig(config);
          phone.updateConfig(config);
          ui.success('Switched to Anthropic.');
          await new Promise(r => setTimeout(r, 1000));
          phone.goBack(); phone.pushView(createProviderView());
        }
      },
      {
        label: `Gemini  ${config.defaults.primaryProvider === 'gemini' ? '[active]' : ''}  ${Configurator.getActiveApiKey(config, 'gemini') ? '' : '-- no key'}`,
        description: Configurator.getActiveModel(config, 'gemini') ? `model: ${Configurator.getActiveModel(config, 'gemini')}` : 'model: gemini-1.5-pro (default)',
        action: async () => {
          if (!Configurator.getActiveApiKey(config, 'gemini')) {
            phone.active = false;
            ui.clearScreen();
            const key = await promptWithEscape('Enter API Key for Gemini:');
            if (key === null) {
              phone.active = true;
              phone.goBack();
              phone.pushView(createProviderView());
              return;
            }
            config = Configurator.updateApiKey('gemini', key) || config;
            phone.active = true;
          }
          config = Configurator.updatePrimaryProvider('gemini') || config;
          provider.setConfig(config);
          phone.updateConfig(config);
          ui.success('Switched to Gemini.');
          await new Promise(r => setTimeout(r, 1000));
          phone.goBack(); phone.pushView(createProviderView());
        }
      },
      {
        label: `Ollama (Local)  ${config.defaults.primaryProvider === 'ollama' ? '[active]' : ''}`,
        description: Configurator.getActiveModel(config, 'ollama') ? `model: ${Configurator.getActiveModel(config, 'ollama')}` : 'model: llama3 (default)',
        action: async () => {
          config = Configurator.updatePrimaryProvider('ollama') || config;
          provider.setConfig(config);
          phone.updateConfig(config);
          ui.success('Switched to Ollama.');
          await new Promise(r => setTimeout(r, 1000));
          phone.goBack(); phone.pushView(createProviderView());
        }
      },
      {
        label: `Mistral AI  ${config.defaults.primaryProvider === 'mistral' ? '[active]' : ''}  ${Configurator.getActiveApiKey(config, 'mistral') ? '' : '-- no key'}`,
        description: Configurator.getActiveModel(config, 'mistral') ? `model: ${Configurator.getActiveModel(config, 'mistral')}` : 'model: mistral-large-latest (default)',
        action: async () => {
          if (!Configurator.getActiveApiKey(config, 'mistral')) {
            phone.active = false;
            ui.clearScreen();
            const key = await promptWithEscape('Enter API Key for Mistral:');
            if (key === null) {
              phone.active = true;
              phone.goBack();
              phone.pushView(createProviderView());
              return;
            }
            config = Configurator.updateApiKey('mistral', key) || config;
            phone.active = true;
          }
          config = Configurator.updatePrimaryProvider('mistral') || config;
          provider.setConfig(config);
          phone.updateConfig(config);
          ui.success('Switched to Mistral.');
          await new Promise(r => setTimeout(r, 1000));
          phone.goBack(); phone.pushView(createProviderView());
        }
      },
      {
        label: `AWS Bedrock  ${config.defaults.primaryProvider === 'bedrock' ? '[active]' : ''}`,
        description: Configurator.getActiveModel(config, 'bedrock') ? `model: ${Configurator.getActiveModel(config, 'bedrock')}` : 'model: us.amazon.nova-pro-v1:0 (default)',
        action: async () => {
          config = Configurator.updatePrimaryProvider('bedrock') || config;
          provider.setConfig(config);
          phone.updateConfig(config);
          ui.success('Switched to AWS Bedrock.');
          await new Promise(r => setTimeout(r, 1000));
          phone.goBack(); phone.pushView(createProviderView());
        }
      },
      {
        label: `NVIDIA  ${config.defaults.primaryProvider === 'nvidia' ? '[active]' : ''}  ${Configurator.getActiveApiKey(config, 'nvidia') ? '' : '-- no key'}`,
        description: Configurator.getActiveModel(config, 'nvidia') ? `model: ${Configurator.getActiveModel(config, 'nvidia')}` : 'model: meta/llama-3.3-70b-instruct (default)',
        action: async () => {
          if (!Configurator.getActiveApiKey(config, 'nvidia')) {
            phone.active = false;
            ui.clearScreen();
            const key = await promptWithEscape('Enter API Key for NVIDIA:');
            if (key === null) {
              phone.active = true;
              phone.goBack();
              phone.pushView(createProviderView());
              return;
            }
            config = Configurator.updateApiKey('nvidia', key) || config;
            phone.active = true;
          }
          config = Configurator.updatePrimaryProvider('nvidia') || config;
          provider.setConfig(config);
          phone.updateConfig(config);
          ui.success('Switched to NVIDIA.');
          await new Promise(r => setTimeout(r, 1000));
          phone.goBack(); phone.pushView(createProviderView());
        }
      },
      { label: 'Go Back', action: () => phone.goBack() }
    ]
  });

  const createThreadsView = (): PhoneView => {
    const threads  = dbManager.listThreads();
    const maxT     = Configurator.getMaxThreads(config);
    const atLimit  = threads.length >= maxT;

    // Helper: prompt user to resolve the limit before creating a new thread
    const tryCreateThread = () => {
      if (atLimit) {
        phone.pushView({
          id: 'thread_limit',
          title: 'Thread Limit Reached',
          subtitle: `You have ${threads.length}/${maxT} sessions stored`,
          renderBody: () => {
            console.log(chalk.hex('#F59E0B').bold('  ⚠  Max thread limit reached'));
            console.log('');
            console.log(chalk.hex('#6B7280')(`  You have ${threads.length} saved sessions and the limit is ${maxT}.`));
            console.log(chalk.hex('#6B7280')('  Delete a session to make room, or raise the limit in Settings.'));
            console.log('');
          },
          options: [
            {
              label: 'Delete a Thread to Make Room',
              description: 'Remove an old session then create a new one',
              action: () => phone.pushView(createThreadsView())
            },
            {
              label: 'Raise the Thread Limit',
              description: 'Go to Settings › Max Threads',
              action: () => phone.pushView(createMaxThreadsView())
            },
            { label: 'Cancel', action: () => phone.goBack() }
          ]
        });
        return;
      }
      chatSession.createFreshThread();
      ui.success('Created a new thread.');
      phone.goBack();
      phone.pushView(createThreadsView());
    };

    if (threads.length === 0) {
      return {
        id: 'threads',
        title: 'Manage Threads',
        options: [
          {
            label: 'Create New Thread',
            description: 'Start a new empty thread',
            action: tryCreateThread
          },
          { label: 'No threads available. (Go Back)', action: () => phone.goBack() }
        ]
      };
    }
    
    return {
      id: 'threads',
      title: 'Manage Threads',
      subtitle: `${threads.length}/${maxT} sessions${atLimit ? '  ⚠ limit reached' : ''}`,
      options: [
        {
          label: atLimit
            ? chalk.hex('#F59E0B')('Create New Thread  [limit reached]')
            : 'Create New Thread',
          description: atLimit
            ? `At the ${maxT}-thread limit — delete one first or raise the limit`
            : 'Start a fresh session and make it active',
          action: tryCreateThread
        },
        {
          label: chalk.red('Delete All Threads'),
          description: 'Remove every saved thread and start fresh',
          action: () => {
            phone.pushView({
              id: 'confirm_delete_all_threads',
              title: 'Confirm Delete All',
              subtitle: 'Are you sure you want to delete all saved threads?',
              options: [
                {
                  label: 'No, Cancel',
                  action: () => phone.goBack()
                },
                {
                  label: chalk.red('Yes, Delete All Threads'),
                  action: async () => {
                    dbManager.deleteAllThreads();
                    snapshotManager.clearAllSnapshots();
                    chatSession.clearAllThreadMessages();
                    chatSession.createFreshThread();
                    ui.success('Deleted all threads. Started a fresh chat.');
                    await new Promise(r => setTimeout(r, 800));
                    phone.goBack(); // pop confirmation
                    phone.goBack(); // pop Manage Threads view
                    phone.pushView(createThreadsView());
                  }
                }
              ]
            });
          }
        },
        ...threads.map(t => {
          const isRunning = chatSession.activeStreams.has(t.id);
          const runningTag = isRunning ? chalk.hex('#f5c542')(' 🟡 [running]') : '';
          const activeTag = t.id === chatSession.threadId ? chalk.hex('#6B7280')(' (active)') : '';
          return {
            label: t.displayName + activeTag + runningTag,
            description: t.id,
          action: () => {
             phone.pushView({
               id: 'thread_actions',
               title: 'Thread Actions',
               subtitle: `${t.displayName}  [${t.id}]`,
               options: [
                 {
                   label: 'Switch to Thread',
                   action: async () => {
                     phone.active = false;
                     ui.clearScreen();
                     chatSession.switchThread(t.id);
                     ui.success(`Switched to ${t.displayName}`);
                     await new Promise(r => setTimeout(r, 600));
                     phone.active = true;
                     phone.goBack();
                     phone.goBack();
                     phone.pushView(createThreadsView());
                   }
                 },
                 {
                   label: chalk.red('Delete Thread'),
                   action: async () => {
                     phone.active = false;
                     ui.clearScreen();
                     dbManager.deleteThread(t.id);
                     snapshotManager.deleteThreadSnapshots(t.id);
                     chatSession.clearThreadMessages(t.id);
                     if (chatSession.threadId === t.id) {
                       chatSession.createFreshThread();
                       ui.success(`Deleted ${t.displayName}. Started a fresh chat.`);
                     } else {
                       ui.success(`Deleted ${t.displayName}`);
                     }
                     await new Promise(r => setTimeout(r, 600));
                     phone.active = true;
                     phone.goBack();
                     phone.goBack();
                     phone.pushView(createThreadsView());
                   }
                 },
                 { label: 'Go Back', action: () => phone.goBack() }
               ]
             });
          }
        };
        }),
        { label: 'Go Back', action: () => phone.goBack() }
      ]
    };
  };

  const createTerminalSessionsView = (): PhoneView => {
    const procs = backgroundManager.getProcesses();
    return {
      id: 'terminal_sessions',
      title: 'Manage Terminal Sessions',
      options: procs.length === 0 ? [
        { label: 'No background processes running. (Go Back)', action: () => phone.goBack() }
      ] : [
        ...procs.map(p => ({
          label: `[PID ${p.pid}] ${p.command}`,
          description: `Running for ${Math.round((Date.now() - p.startTime) / 1000)}s`,
          action: () => {
            phone.pushView({
              id: 'confirm_kill_process',
              title: 'Confirm Kill',
              subtitle: `Kill process ${p.pid} (${p.command})?`,
              options: [
                {
                  label: 'No, Cancel',
                  action: () => phone.goBack()
                },
                {
                  label: chalk.red('Yes, Kill Process'),
                  action: async () => {
                    try {
                      await backgroundManager.killProcess(p.pid);
                      ui.success(`Killed process ${p.pid}`);
                    } catch (e: any) {
                      ui.error(`Failed to kill: ${e.message}`);
                    }
                    await new Promise(r => setTimeout(r, 1000));
                    phone.goBack(); // pop confirmation
                    phone.goBack(); // pop sessions view
                    phone.pushView(createTerminalSessionsView());
                  }
                }
              ]
            });
          }
        })),
        { label: 'Go Back', action: () => phone.goBack() }
      ]
    };
  };

  const createAnalyticsView = (): PhoneView => ({
    id: 'analytics',
    title: 'Analytics Dashboard',
    subtitle: 'Real-time performance metrics and usage insights',
    renderBody: () => {
      const stats = memoryManager.getBudgetStatsForMessages(chatSession.getMessages(), rules);
      const threads = dbManager.listThreads().length;
      console.log('  \x1b[36mTokens Filled:\x1b[0m   ' + stats.filled + ' tk');
      console.log('  \x1b[36mContext Limit:\x1b[0m  ' + stats.max + ' tk');
      console.log('  \x1b[36mTotal Sessions:\x1b[0m ' + threads);
      console.log('  \x1b[36mTime Saved:\x1b[0m     Est. ' + Math.round((stats.filled / 500) * 1.5) + ' mins (based on 500 WPM reading speed)');
      console.log('');
      console.log('  \x1b[35m● \x1b[0m Truncated/Saved Tokens: \x1b[32m' + stats.compressed + '\x1b[0m');
      console.log('  \x1b[35m● \x1b[0m O.T.T.O Context Bar: \x1b[32m' + (config.defaults.showContextBar !== false ? 'ON' : 'OFF') + '\x1b[0m');
    },
    options: [
      { label: 'Go Back', action: () => phone.goBack() }
    ]
  });

  const createHomeView = (): PhoneView => ({
    id: 'home',
    title: 'Home',
    options: [
      {
        label: 'Enter Chat',
        description: 'Start a conversation with the AI agent',
        action: async () => {
          rootController.setMode('chat');
          await startChat();
          rootController.setMode('menu');
        }
      },
      {
        label: 'Switch Provider',
        description: 'Change the active LLM inference engine',
        action: () => phone.pushView(createProviderView())
      },
      {
        label: 'Manage Threads',
        description: `Manage your chat sessions (${dbManager.listThreads().length})`,
        action: () => phone.pushView(createThreadsView())
      },
      {
        label: 'Manage Terminal Sessions',
        description: 'View or kill running background processes',
        action: () => phone.pushView(createTerminalSessionsView())
      },
      {
        label: 'Command Palette',
        description: 'Fuzzy search actions and files (Ctrl+K style)',
        action: () => phone.pushView(createCommandPaletteView(phone, actions))
      },
      {
        label: 'Task Board (Kanban)',
        description: 'Manage your project tasks visually',
        action: () => phone.pushView(createTaskBoardView(phone))
      },
      {
        label: 'Project File Tree',
        description: 'Explore workspace directories visually',
        action: () => phone.pushView(createFileTreeView(phone))
      },
      {
        label: 'Git Dashboard',
        description: 'View version control status and branches',
        action: () => phone.pushView(createGitPanelView(phone))
      },
      {
        label: 'Analytics Dashboard',
        description: 'View token usage and performance metrics',
        action: () => phone.pushView(createAnalyticsView())
      },
      {
        label: 'Settings & Security',
        description: 'API keys, security mode, and display options',
        action: () => phone.pushView(createSettingsView())
      },
      {
        label: 'Exit',
        action: () => {
          process.stdout.write('\x1B[?1049l');
          process.exit(0);
        }
      }
    ]
  });

  const actions: any[] = [
    { label: 'Actions: Settings', action: () => phone.pushView(createSettingsView()) },
    { label: 'Actions: Task Master (Kanban)', action: () => phone.pushView(createTaskBoardView(phone)) },
    { label: 'Actions: Git Panel', action: () => phone.pushView(createGitPanelView(phone)) },
    { label: 'Navigate: File Tree', action: () => phone.pushView(createFileTreeView(phone)) },
    { label: 'Navigate: Analytics', action: () => phone.pushView(createAnalyticsView()) },
    { label: 'Settings: Profile (Username)', action: () => phone.pushView(createProfileView()) },
    { label: 'Settings: Max Threads Limit', action: () => phone.pushView(createMaxThreadsView()) },
    { label: 'Settings: Max Context Size', action: () => phone.pushView(createMaxCtxView()) },
    { label: 'Settings: API Keys Configuration', action: () => phone.pushView(createApiEditView()) },
    { label: 'Settings: Edit Models', action: () => phone.pushView(createModelEditView()) },
    { label: 'Settings: Allowed Tools & Commands', action: () => phone.pushView(createSecurityEditView()) },
    {
      label: 'Settings: Toggle Context Bar',
      action: async () => {
        const current = config.defaults.showContextBar !== false;
        config = Configurator.updateContextBar(!current) || config;
        phone.updateConfig(config);
        ui.success(`Context Bar turned ${!current ? 'ON' : 'OFF'}`);
        await new Promise(r => setTimeout(r, 800));
        phone.render();
      }
    },
    {
      label: 'Settings: Edit Ollama Base URL',
      action: async () => {
        phone.active = false;
        ui.clearScreen();
        const currentUrl = config.providers.ollama?.baseUrl || 'http://localhost:11434';
        const entered = await promptWithEscape(`Enter new Ollama Base URL (current: ${currentUrl}):`);
        if (entered !== null && entered.trim()) {
          config = Configurator.updateOllamaUrl(entered.trim()) || config;
          phone.updateConfig(config);
          ui.success(`Ollama URL updated to ${entered.trim()}`);
          await new Promise(r => setTimeout(r, 900));
        }
        phone.active = true;
        phone.render();
      }
    },
    { label: 'API Keys: Groq Keys', action: () => phone.pushView(createProviderApiKeyView('groq', 'Groq')) },
    { label: 'API Keys: OpenAI Keys', action: () => phone.pushView(createProviderApiKeyView('openai', 'OpenAI')) },
    { label: 'API Keys: Anthropic Keys', action: () => phone.pushView(createProviderApiKeyView('anthropic', 'Anthropic')) },
    { label: 'API Keys: Gemini Keys', action: () => phone.pushView(createProviderApiKeyView('gemini', 'Gemini')) },
    { label: 'API Keys: Mistral Keys', action: () => phone.pushView(createProviderApiKeyView('mistral', 'Mistral')) },
    { label: 'API Keys: NVIDIA Keys', action: () => phone.pushView(createProviderApiKeyView('nvidia', 'NVIDIA')) },
    { label: 'API Keys: AWS Bedrock Credentials', action: () => phone.pushView(createBedrockSettingsView()) },
    { label: 'Models: Groq Model Variants', action: () => phone.pushView(createProviderModelView('groq', 'Groq', 'qwen-qwq-32b', 'e.g. qwen-qwq-32b')) },
    { label: 'Models: OpenAI Model Variants', action: () => phone.pushView(createProviderModelView('openai', 'OpenAI', 'gpt-4o', 'e.g. gpt-4o')) },
    { label: 'Models: Anthropic Model Variants', action: () => phone.pushView(createProviderModelView('anthropic', 'Anthropic', 'claude-3-5-sonnet-20241022', 'e.g. claude-3-5-sonnet-20241022')) },
    { label: 'Models: Gemini Model Variants', action: () => phone.pushView(createProviderModelView('gemini', 'Gemini', 'gemini-1.5-pro', 'e.g. gemini-1.5-pro')) },
    { label: 'Models: Ollama Model Variants', action: () => phone.pushView(createProviderModelView('ollama', 'Ollama', 'llama3', 'e.g. llama3')) },
    { label: 'Models: Mistral Model Variants', action: () => phone.pushView(createProviderModelView('mistral', 'Mistral', 'mistral-large-latest', 'e.g. mistral-large-latest')) },
    { label: 'Models: AWS Bedrock Model Variants', action: () => phone.pushView(createProviderModelView('bedrock', 'AWS Bedrock', 'us.amazon.nova-pro-v1:0', 'e.g. us.amazon.nova-pro-v1:0')) }
  ];

  phone.registerCtrlKHandler(() => {
    const currentView = phone.history[phone.history.length - 1];
    if (currentView?.id === 'command_palette') return;
    phone.pushView(createCommandPaletteView(phone, actions));
  });

  // Launch OS via Ink React renderer
  phone.pushView(createHomeView());
  render(<AppShell phone={phone} chatUI={chatUI} />);
  phone.startListening();
}

process.on('uncaughtException', (error) => {
  try {
    fs.appendFileSync('otto-errors.log', `Uncaught Exception: ${error?.stack || error}\n`);
  } catch {}
});

process.on('unhandledRejection', (reason) => {
  try {
    fs.appendFileSync('otto-errors.log', `Unhandled Rejection: ${reason instanceof Error ? reason.stack : reason}\n`);
  } catch {}
});

const cleanupAndExit = () => {
  process.stdout.write('\x1B[?1049l');
  ui.tuiActive = false;
  process.exit(0);
};
process.on('SIGINT', cleanupAndExit);
process.on('SIGTERM', cleanupAndExit);

main().catch(err => {
  console.error(err);
  fs.writeFileSync('crash.txt', err.stack || err.message);
  process.exit(1);
});
