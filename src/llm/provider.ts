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
import { ToolMessage } from '@langchain/core/messages';
import { tools } from './tools.js';
import { createReactAgent } from '@langchain/langgraph/prebuilt';

type ProviderName = 'groq' | 'openai' | 'anthropic' | 'ollama' | 'gemini';

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
          maxRetries: 0,
          streaming: true
        }).bindTools(tools) as any;
        ui.info(`Switched to Gemini - ${model}`);
      } else if (providerName === 'ollama') {
        const entry = this.config.providers.ollama;
        const model = entry?.activeModel ?? entry?.model ?? 'llama3';
        const baseUrl = entry?.baseUrl ?? 'http://localhost:11434';
        
        this.primaryModel = new ChatOllama({
          baseUrl,
          model,
          temperature: 0, // Enforces strict JSON tool schemas across all local models
          maxRetries: 0,
          streaming: true
        }).bindTools(tools) as any;
        
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

  public async *streamReactAgent(messages: any[], attempt = 1): AsyncGenerator<any, void, unknown> {
    if (!this.primaryModel) {
      throw new Error('No valid LLM provider initialized.');
    }

    try {
      const agent = createReactAgent({ llm: this.primaryModel, tools });
      const stream = await agent.streamEvents({ messages }, { version: 'v2' });
      for await (const event of stream) {
        if (event.event === "on_chat_model_stream" && event.data?.chunk) {
          yield { chunk: event.data.chunk, metadata: event.metadata };
        } else if (event.event === "on_tool_end" && event.data?.output !== undefined) {
          const output = event.data.output;
          let contentStr = "";
          if (output && typeof output === 'object' && output._getType) {
             yield { chunk: output, metadata: event.metadata };
          } else {
             contentStr = typeof output === 'string' ? output : JSON.stringify(output);
             const toolMsg = new ToolMessage({
               content: contentStr,
               name: event.name,
               tool_call_id: event.run_id
             });
             yield { chunk: toolMsg, metadata: event.metadata };
          }
        }
      }
      quotaManager.resetBackoff();
    } catch (error: any) {
      if (this.isRateLimit(error)) {
        const retryAfter = error?.response?.headers?.['retry-after'];

        if (attempt <= 6 && this.tryFallback(attempt)) {
          ui.info(`Retrying agent stream with fallback (attempt ${attempt + 1}/6)...`);
          yield* this.streamReactAgent(messages, attempt + 1);
          return;
        }

        await quotaManager.handleRateLimit(retryAfter);
        if (attempt <= 6) {
          ui.info(`Retrying agent stream after backoff (attempt ${attempt + 1}/6)...`);
          yield* this.streamReactAgent(messages, attempt + 1);
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