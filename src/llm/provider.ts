import { ChatGroq } from '@langchain/groq';
import { ChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatOllama } from '@langchain/ollama';
import { ChatMistralAI } from '@langchain/mistralai';
import { ChatBedrockConverse } from '@langchain/aws';
import { OttoConfig } from '../cli/configurator.js';
import { Configurator } from '../cli/configurator.js';
import { quotaManager } from './quota.js';
import { ui } from '../cli/ui.js';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { tools } from './tools.js';
import { concat } from '@langchain/core/utils/stream';
import { executor } from '../security/executor.js';

type ProviderName = 'groq' | 'openai' | 'anthropic' | 'ollama' | 'gemini' | 'mistral' | 'bedrock';

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

  try {
    const sanitized = sanitizeJsonString(trimmed);
    const parsed = JSON.parse(sanitized);
    if (isToolCallFormat(parsed)) {
      if (Array.isArray(parsed)) {
        parsed.forEach(addIfValid);
      } else {
        addIfValid(parsed);
      }
      return foundCalls.length > 0 ? foundCalls : null;
    }
  } catch {}

  let hasJsonToolCallBlock = false;
  const jsonBlockRegex = /```json\s*([\s\S]*?)\s*```/g;
  let match;
  while ((match = jsonBlockRegex.exec(trimmed)) !== null) {
    try {
      const sanitized = sanitizeJsonString(match[1].trim());
      const parsed = JSON.parse(sanitized);
      if (isToolCallFormat(parsed)) {
        hasJsonToolCallBlock = true;
        if (Array.isArray(parsed)) {
          parsed.forEach(addIfValid);
        } else {
          addIfValid(parsed);
        }
      }
    } catch {}
  }

  if (hasJsonToolCallBlock) {
    return foundCalls.length > 0 ? foundCalls : null;
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
            const sanitized = sanitizeJsonString(potentialJson);
            const parsed = JSON.parse(sanitized);
            addIfValid(parsed);
          } catch {}
        }
      }
    }
  }

  if (foundCalls.length > 0) return foundCalls;

  const blockRegex = /```([a-zA-Z0-9_-]*)\s*([\s\S]*?)\s*```/g;
  let blockMatch;
  let lastIdx = 0;

  while ((blockMatch = blockRegex.exec(trimmed)) !== null) {
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

  return foundCalls.length > 0 ? foundCalls : null;
}

export class ProviderEngine {
  private config: OttoConfig;
  private primaryModel: BaseChatModel | null = null;

  constructor(config: OttoConfig) {
    this.config = Configurator.normalizeConfig(config);
    this.initProvider();
  }

  public initProvider() {
    const providerName = this.config.defaults.primaryProvider as ProviderName;

    try {
      if (providerName === 'groq' && Configurator.getActiveApiKey(this.config, 'groq')) {
        const model = Configurator.getActiveModel(this.config, 'groq') ?? 'qwen-qwq-32b';
        const apiKey = Configurator.getActiveApiKey(this.config, 'groq')!;
        this.primaryModel = new ChatGroq({
          apiKey,
          model,
          temperature: 0,
          maxRetries: 0,
          streaming: true
        }).bindTools(tools) as any;
        ui.info(`Switched to Groq - ${model}`);
      } else if (providerName === 'openai' && Configurator.getActiveApiKey(this.config, 'openai')) {
        const model = Configurator.getActiveModel(this.config, 'openai') ?? 'gpt-4o';
        const apiKey = Configurator.getActiveApiKey(this.config, 'openai')!;
        this.primaryModel = new ChatOpenAI({
          openAIApiKey: apiKey,
          modelName: model,
          temperature: 0,
          maxRetries: 0,
          streaming: true
        }).bindTools(tools) as any;
        ui.info(`Switched to OpenAI - ${model}`);
      } else if (providerName === 'anthropic' && Configurator.getActiveApiKey(this.config, 'anthropic')) {
        const model = Configurator.getActiveModel(this.config, 'anthropic') ?? 'claude-3-5-sonnet-20241022';
        const apiKey = Configurator.getActiveApiKey(this.config, 'anthropic')!;
        this.primaryModel = new ChatAnthropic({
          anthropicApiKey: apiKey,
          model,
          temperature: 0,
          maxRetries: 0,
          streaming: true
        }).bindTools(tools) as any;
        ui.info(`Switched to Anthropic - ${model}`);
      } else if (providerName === 'gemini' && Configurator.getActiveApiKey(this.config, 'gemini')) {
        const model = Configurator.getActiveModel(this.config, 'gemini') ?? 'gemini-1.5-pro';
        const apiKey = Configurator.getActiveApiKey(this.config, 'gemini')!;
        this.primaryModel = new ChatGoogleGenerativeAI({
          apiKey,
          model: model,
          temperature: 0,
          maxRetries: 0,
          streaming: true
        }).bindTools(tools) as any;
        ui.info(`Switched to Gemini - ${model}`);
      } else if (providerName === 'mistral' && Configurator.getActiveApiKey(this.config, 'mistral')) {
        const model = Configurator.getActiveModel(this.config, 'mistral') ?? 'mistral-large-latest';
        const apiKey = Configurator.getActiveApiKey(this.config, 'mistral')!;
        this.primaryModel = new ChatMistralAI({
          apiKey,
          model,
          temperature: 0,
          maxRetries: 0
        }).bindTools(tools) as any;
        ui.info(`Switched to Mistral AI - ${model}`);
      } else if (providerName === 'ollama') {
        const entry = this.config.providers.ollama;
        const model = entry?.activeModel ?? entry?.model ?? 'llama3';
        const baseUrl = entry?.baseUrl ?? 'http://localhost:11434';
        
        const rawModel = new ChatOllama({
          baseUrl,
          model,
          temperature: 0,
          maxRetries: 0,
          streaming: true
        }).bindTools(tools) as any;

        const originalInvoke = rawModel.invoke.bind(rawModel);
        rawModel.invoke = async (inputMessages: any, options: any) => {
          const response = await originalInvoke(inputMessages, options);
          if (response && response.content && (!response.tool_calls || response.tool_calls.length === 0)) {
            const fallbackCalls = parseFallbackToolCalls(response.content.toString(), inputMessages);
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

        this.primaryModel = rawModel;
        ui.info(`Switched to Ollama - ${model}`);
      } else if (providerName === 'bedrock') {
        const entry = this.config.providers.bedrock;
        const model = entry?.activeModel ?? entry?.model ?? 'us.amazon.nova-pro-v1:0';
        const region = entry?.region ?? process.env.AWS_REGION ?? 'us-east-1';
        const accessKeyId = entry?.accessKeyId ?? process.env.AWS_ACCESS_KEY_ID;
        const secretAccessKey = entry?.secretAccessKey ?? process.env.AWS_SECRET_ACCESS_KEY;
        const sessionToken = entry?.sessionToken ?? process.env.AWS_SESSION_TOKEN;

        const credentials = accessKeyId && secretAccessKey
          ? { accessKeyId, secretAccessKey, sessionToken }
          : undefined;

        this.primaryModel = new ChatBedrockConverse({
          region,
          credentials,
          model,
          temperature: 0,
          maxRetries: 0
        }).bindTools(tools) as any;
        ui.info(`Switched to AWS Bedrock - ${model} (${region})`);
      } else {
        ui.warning(`Provider ${providerName} is not fully configured or supported yet.`);
        this.primaryModel = null;
      }
    } catch (e: any) {
      ui.error(`Failed to initialize provider: ${e.message}`);
      this.primaryModel = null;
    }
  }

  public setConfig(newConfig: OttoConfig) {
    this.config = Configurator.normalizeConfig(newConfig);
    this.initProvider();
  }

  public getConfig(): OttoConfig {
    return this.config;
  }

  private isRateLimit(error: any): boolean {
    const msg = (error?.message || '').toLowerCase();
    return error?.status === 429 ||
      error?.response?.status === 429 ||
      error?.error?.code === 'rate_limit_exceeded' ||
      error?.code === 'rate_limit_exceeded' ||
      msg.includes('rate limit') ||
      msg.includes('rate_limit') ||
      msg.includes('too many requests') ||
      msg.includes('tpm') ||
      msg.includes('rpm') ||
      msg.includes('quota');
  }

  private tryFallback(attempt: number): boolean {
    const providerName = this.config.defaults.primaryProvider as ProviderName;
    if (providerName === 'ollama' || providerName === 'bedrock') return false;

    const rotatableProvider = providerName as 'groq' | 'openai' | 'anthropic' | 'gemini' | 'mistral';

    const rotateKeyFirst = attempt % 2 === 1;
    const actions = rotateKeyFirst
      ? ['key', 'model'] as const
      : ['model', 'key'] as const;

    for (const action of actions) {
      const beforeKey = Configurator.getActiveApiKey(this.config, rotatableProvider);
      const beforeModel = Configurator.getActiveModel(this.config, rotatableProvider);
      const nextConfig = action === 'key'
        ? Configurator.rotateApiKey(rotatableProvider)
        : Configurator.rotateModelVariant(rotatableProvider);

      if (!nextConfig) continue;

      const nextKey = Configurator.getActiveApiKey(nextConfig, rotatableProvider);
      const nextModel = Configurator.getActiveModel(nextConfig, rotatableProvider);
      if (beforeKey === nextKey && beforeModel === nextModel) continue;

      this.setConfig(nextConfig);
      ui.warning(`Rate limit hit. Rotated ${action === 'key' ? 'API key' : 'model'} and retrying.`);
      return true;
    }

    return false;
  }

  public async invoke(messages: any[], attempt = 1): Promise<any> {
    if (!this.primaryModel) {
      throw new Error('No valid LLM provider initialized.');
    }

    const activeProvider = this.config.defaults.primaryProvider as ProviderName;
    const activeModel = Configurator.getActiveModel(this.config, activeProvider) || 'default';
    const limits = this.config.modelLimits?.[activeModel];
    if (limits) {
      await quotaManager.enforceLimits(activeModel, limits);
    }

    try {
      const response = await this.primaryModel.invoke(messages);
      quotaManager.resetBackoff();

      // Record token usage
      const usage = (response?.usage_metadata || response?.response_metadata?.tokenUsage || {}) as any;
      let inputTokens = usage.input_tokens || usage.prompt_tokens;
      let outputTokens = usage.output_tokens || usage.completion_tokens;
      if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number') {
        const text = response?.content?.toString() || '';
        outputTokens = Math.ceil(text.length / 4);
        inputTokens = Math.ceil(messages.reduce((acc, m) => acc + (m.content?.toString() || '').length, 0) / 4);
      }
      quotaManager.recordUsage(activeModel, inputTokens, outputTokens);

      return response;
    } catch (error: any) {
      if (this.isRateLimit(error)) {
        const retryAfter = error?.response?.headers?.['retry-after'];

        if (attempt <= 6 && this.tryFallback(attempt)) {
          ui.info(`Retrying request with fallback (attempt ${attempt + 1}/6)...`);
          return this.invoke(messages, attempt + 1);
        }

        await quotaManager.handleRateLimit(retryAfter);
        if (attempt <= 6) {
          ui.info(`Retrying request after backoff (attempt ${attempt + 1}/6)...`);
          return this.invoke(messages, attempt + 1);
        }

        ui.error('Max retries exceeded due to TPM exhaustion.');
      }
      throw error;
    }
  }

  public async *stream(messages: any[], attempt = 1): AsyncGenerator<any, void, unknown> {
    if (!this.primaryModel) {
      throw new Error('No valid LLM provider initialized.');
    }

    const activeProvider = this.config.defaults.primaryProvider as ProviderName;
    const activeModel = Configurator.getActiveModel(this.config, activeProvider) || 'default';
    const limits = this.config.modelLimits?.[activeModel];
    if (limits) {
      await quotaManager.enforceLimits(activeModel, limits);
    }

    let finalMessage: any = null;
    try {
      const stream = await this.primaryModel.stream(messages);
      for await (const chunk of stream) {
        if (!finalMessage) finalMessage = chunk;
        else finalMessage = concat(finalMessage, chunk);
        yield chunk;
      }
      quotaManager.resetBackoff();

      // Record token usage
      const usage = (finalMessage?.usage_metadata || finalMessage?.response_metadata?.tokenUsage || {}) as any;
      let inputTokens = usage.input_tokens || usage.prompt_tokens;
      let outputTokens = usage.output_tokens || usage.completion_tokens;
      if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number') {
        const text = finalMessage?.content?.toString() || '';
        outputTokens = Math.ceil(text.length / 4);
        inputTokens = Math.ceil(messages.reduce((acc, m) => acc + (m.content?.toString() || '').length, 0) / 4);
      }
      quotaManager.recordUsage(activeModel, inputTokens, outputTokens);
    } catch (error: any) {
      if (this.isRateLimit(error)) {
        const retryAfter = error?.response?.headers?.['retry-after'];

        if (attempt <= 6 && this.tryFallback(attempt)) {
          ui.info(`Retrying stream with fallback (attempt ${attempt + 1}/6)...`);
          yield* this.stream(messages, attempt + 1);
          return;
        }

        await quotaManager.handleRateLimit(retryAfter);
        if (attempt <= 6) {
          ui.info(`Retrying stream after backoff (attempt ${attempt + 1}/6)...`);
          yield* this.stream(messages, attempt + 1);
          return;
        }

        ui.error('Max retries exceeded due to TPM exhaustion.');
      }
      throw error;
    }
  }

  public getModel(): BaseChatModel {
    if (!this.primaryModel) throw new Error('Model not initialized');
    return this.primaryModel;
  }
}