import { ChatGroq } from '@langchain/groq';
import { ChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatOllama } from '@langchain/ollama';
import { OttoConfig } from '../cli/configurator.js';
import { Configurator } from '../cli/configurator.js';
import { quotaManager } from './quota.js';
import { ui } from '../cli/ui.js';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { tools } from './tools.js';

type ProviderName = 'groq' | 'openai' | 'anthropic' | 'ollama' | 'gemini';

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

        this.primaryModel = rawModel;
        ui.info(`Switched to Ollama - ${model}`);
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
    return error?.status === 429 ||
      error?.response?.status === 429 ||
      error?.error?.code === 'rate_limit_exceeded' ||
      error?.code === 'rate_limit_exceeded';
  }

  private tryFallback(attempt: number): boolean {
    const providerName = this.config.defaults.primaryProvider as ProviderName;
    if (providerName === 'ollama') return false;

    const rotateKeyFirst = attempt % 2 === 1;
    const actions = rotateKeyFirst
      ? ['key', 'model'] as const
      : ['model', 'key'] as const;

    for (const action of actions) {
      const beforeKey = Configurator.getActiveApiKey(this.config, providerName);
      const beforeModel = Configurator.getActiveModel(this.config, providerName);
      const nextConfig = action === 'key'
        ? Configurator.rotateApiKey(providerName)
        : Configurator.rotateModelVariant(providerName);

      if (!nextConfig) continue;

      const nextKey = Configurator.getActiveApiKey(nextConfig, providerName);
      const nextModel = Configurator.getActiveModel(nextConfig, providerName);
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

    try {
      const response = await this.primaryModel.invoke(messages);
      quotaManager.resetBackoff();
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

    try {
      const stream = await this.primaryModel.stream(messages);
      for await (const chunk of stream) {
        yield chunk;
      }
      quotaManager.resetBackoff();
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