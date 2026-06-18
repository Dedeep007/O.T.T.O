import fs from 'fs';
import path from 'path';
import os from 'os';
import { input, select, confirm } from '@inquirer/prompts';
import { ui } from './ui.js';

export interface OttoConfig {
  providers: {
    groq?:     { apiKey: string; apiKeys?: string[]; activeApiKey?: string; model?: string; models?: string[]; activeModel?: string; frequency_penalty: number };
    openai?:   { apiKey: string; apiKeys?: string[]; activeApiKey?: string; model?: string; models?: string[]; activeModel?: string; parallel_tool_calls: boolean };
    anthropic?:{ apiKey: string; apiKeys?: string[]; activeApiKey?: string; model?: string; models?: string[]; activeModel?: string; effort: string };
    ollama?:   { baseUrl: string; model?: string; models?: string[]; activeModel?: string; num_ctx: number };
    gemini?:   { apiKey: string; apiKeys?: string[]; activeApiKey?: string; model?: string; models?: string[]; activeModel?: string };
  };
  defaults: {
    primaryProvider: 'groq' | 'openai' | 'anthropic' | 'ollama' | 'gemini';
    secondaryProvider?: 'groq' | 'openai' | 'anthropic' | 'ollama' | 'gemini';
    tertiaryProvider?: 'groq' | 'openai' | 'anthropic' | 'ollama' | 'gemini';
    showContextBar: boolean;
    maxThreads?: number;  // cap on stored sessions; undefined = use cpuHealthyDefault
  };
  security: {
    mode: 'ask' | 'approve' | 'full';
    allowedCommands: string[];
    allowedApps: string[];
    allowedPorts: string[];
  };
  memory: {
    embeddingsProvider: string;
  };
  profile?: {
    username?: string;
  };
}

const rcPath = path.join(os.homedir(), '.ottorc');
type ProviderName = 'groq' | 'openai' | 'anthropic' | 'ollama' | 'gemini';

function normalizeModels(models?: string[]): string[] {
  return Array.from(new Set((models ?? []).map(m => m.trim()).filter(Boolean)));
}

function normalizeApiKeys(apiKeys?: string[]): string[] {
  return Array.from(new Set((apiKeys ?? []).map(key => key.trim()).filter(Boolean)));
}

function getProviderEntry(config: OttoConfig, provider: ProviderName) {
  return config.providers[provider] as any;
}

function getPrimaryModel(entry: any): string | undefined {
  return entry?.activeModel || entry?.model || entry?.models?.[0];
}

function getPrimaryApiKey(entry: any): string | undefined {
  return entry?.activeApiKey || entry?.apiKey || entry?.apiKeys?.[0];
}

export const Configurator = {
  normalizeConfig: (config: OttoConfig): OttoConfig => {
    const next: OttoConfig = JSON.parse(JSON.stringify(config));
    (['groq', 'openai', 'anthropic', 'ollama', 'gemini'] as ProviderName[]).forEach((provider) => {
      const entry = getProviderEntry(next, provider);
      if (!entry) return;
      entry.models = normalizeModels(entry.models);
      entry.apiKeys = normalizeApiKeys(entry.apiKeys);

      const activeApiKey = getPrimaryApiKey(entry);
      if (activeApiKey) {
        entry.activeApiKey = activeApiKey;
        entry.apiKey = activeApiKey;
        if (!entry.apiKeys.includes(activeApiKey)) entry.apiKeys.unshift(activeApiKey);
      } else if (entry.apiKey) {
        entry.apiKeys = normalizeApiKeys([entry.apiKey, ...entry.apiKeys]);
        entry.activeApiKey = entry.apiKey;
      }

      const active = getPrimaryModel(entry);
      if (active) {
        entry.activeModel = active;
        entry.model = active;
        if (!entry.models.includes(active)) entry.models.unshift(active);
      } else if (entry.model) {
        entry.models = normalizeModels([entry.model, ...entry.models]);
        entry.activeModel = entry.model;
      }
    });
    return next;
  },

  loadConfig: (): OttoConfig | null => {
    if (fs.existsSync(rcPath)) {
      try {
        const raw = fs.readFileSync(rcPath, 'utf-8');
        return Configurator.normalizeConfig(JSON.parse(raw) as OttoConfig);
      } catch (e) {
        ui.error(`Failed to parse ${rcPath}`);
        return null;
      }
    }
    return null;
  },

  saveConfig: (config: OttoConfig) => {
    fs.writeFileSync(rcPath, JSON.stringify(Configurator.normalizeConfig(config), null, 2), 'utf-8');
    ui.success(`Saved configuration to ${rcPath}`);
  },

  wizard: async (): Promise<OttoConfig> => {
    ui.header('O.T.T.O Initial Configurator Wizard');

    const primaryProvider = await select({
      message: 'Select your primary LLM provider:',
      choices: [
        { name: 'Groq', value: 'groq' },
        { name: 'OpenAI', value: 'openai' },
        { name: 'Anthropic', value: 'anthropic' },
        { name: 'Gemini', value: 'gemini' },
        { name: 'Ollama (Local)', value: 'ollama' }
      ]
    }) as 'groq' | 'openai' | 'anthropic' | 'ollama' | 'gemini';

    const providers: OttoConfig['providers'] = {};
    
    // As per user request, we have a Groq API Key explicitly, so we should prioritize it if selected or default to it.
    if (primaryProvider === 'groq') {
      const apiKey = await input({ message: 'Enter your Groq API Key:' });
      // Validate lightweight request could be done here. For now, trust the input and validate at runtime.
      providers.groq = { apiKey, frequency_penalty: 0.0 };
    } else if (primaryProvider === 'gemini') {
      const apiKey = await input({ message: 'Enter your Gemini API Key:' });
      providers.gemini = { apiKey };
    } else if (primaryProvider === 'ollama') {
      const baseUrl = await input({ message: 'Enter your Ollama base URL (e.g. http://localhost:11434):', default: 'http://localhost:11434' });
      const model = await input({ message: 'Enter your Ollama model name (e.g. llama3):' });
      providers.ollama = { baseUrl, model, num_ctx: 4096 };
    }

    const securityMode = await select({
      message: 'Select Security Mode:',
      choices: [
        { name: 'Ask for approval (Safest)', value: 'ask' },
        { name: 'Approve for me (Executes whitelisted silently)', value: 'approve' },
        { name: 'Full access (Docker Isolated)', value: 'full' }
      ]
    }) as 'ask' | 'approve' | 'full';

    const config: OttoConfig = {
      providers,
      defaults: {
        primaryProvider,
        showContextBar: true
      },
      security: {
        mode: securityMode,
        allowedCommands: ['npm', 'git', 'node', 'tsc'],
        allowedApps: [],
        allowedPorts: []
      },
      memory: {
        embeddingsProvider: 'ollama'
      }
    };

    Configurator.saveConfig(config);
    return config;
  },

  init: async (): Promise<OttoConfig> => {
    let config = Configurator.loadConfig();
    if (!config) {
      config = await Configurator.wizard();
    }
    return config;
  },

  getActiveModel: (config: OttoConfig, provider: ProviderName): string | undefined => {
    const entry = getProviderEntry(config, provider);
    return getPrimaryModel(entry);
  },

  getModelVariants: (config: OttoConfig, provider: ProviderName): string[] => {
    const entry = getProviderEntry(config, provider);
    return normalizeModels(entry?.models ?? (entry?.model ? [entry.model] : []));
  },

  getActiveApiKey: (config: OttoConfig, provider: ProviderName): string | undefined => {
    const entry = getProviderEntry(config, provider);
    return getPrimaryApiKey(entry);
  },

  getApiKeys: (config: OttoConfig, provider: ProviderName): string[] => {
    const entry = getProviderEntry(config, provider);
    return normalizeApiKeys(entry?.apiKeys ?? (entry?.apiKey ? [entry.apiKey] : []));
  },

  updatePrimaryProvider: (newProvider: ProviderName) => {
    const config = Configurator.loadConfig();
    if (config) {
      config.defaults.primaryProvider = newProvider;
      Configurator.saveConfig(config);
      return config;
    }
    return null;
  },

  updateApiKey: (provider: 'groq' | 'openai' | 'anthropic' | 'gemini', apiKey: string) => {
    const config = Configurator.loadConfig();
    if (config) {
      if (!config.providers[provider]) {
        config.providers[provider] = { apiKey, apiKeys: [apiKey], activeApiKey: apiKey } as any;
      } else {
        const entry = config.providers[provider] as any;
        entry.apiKey = apiKey;
        entry.activeApiKey = apiKey;
        entry.apiKeys = normalizeApiKeys([...(entry.apiKeys ?? []), apiKey]);
      }
      Configurator.saveConfig(config);
      return config;
    }
    return null;
  },

  addApiKey: (provider: 'groq' | 'openai' | 'anthropic' | 'gemini', apiKey: string) => {
    const config = Configurator.loadConfig();
    if (config) {
      if (!config.providers[provider]) {
        config.providers[provider] = { apiKey, apiKeys: [apiKey], activeApiKey: apiKey } as any;
      } else {
        const entry = config.providers[provider] as any;
        entry.apiKeys = normalizeApiKeys([...(entry.apiKeys ?? []), apiKey]);
        if (!entry.apiKey && !entry.activeApiKey) {
          entry.apiKey = apiKey;
          entry.activeApiKey = apiKey;
        }
      }
      Configurator.saveConfig(config);
      return config;
    }
    return null;
  },

  removeApiKey: (provider: 'groq' | 'openai' | 'anthropic' | 'gemini', apiKey: string) => {
    const config = Configurator.loadConfig();
    if (config && config.providers[provider]) {
      const entry = config.providers[provider] as any;
      entry.apiKeys = normalizeApiKeys((entry.apiKeys ?? []).filter((key: string) => key !== apiKey));
      if (entry.activeApiKey === apiKey || entry.apiKey === apiKey) {
        const next = entry.apiKeys[0];
        entry.activeApiKey = next;
        entry.apiKey = next;
      }
      Configurator.saveConfig(config);
      return config;
    }
    return null;
  },

  setActiveApiKey: (provider: 'groq' | 'openai' | 'anthropic' | 'gemini', apiKey: string) => {
    const config = Configurator.loadConfig();
    if (config) {
      if (!config.providers[provider]) {
        config.providers[provider] = { apiKey, apiKeys: [apiKey], activeApiKey: apiKey } as any;
      } else {
        const entry = config.providers[provider] as any;
        entry.apiKeys = normalizeApiKeys([...(entry.apiKeys ?? []), apiKey]);
        entry.activeApiKey = apiKey;
        entry.apiKey = apiKey;
      }
      Configurator.saveConfig(config);
      return config;
    }
    return null;
  },

  rotateApiKey: (provider: 'groq' | 'openai' | 'anthropic' | 'gemini'): OttoConfig | null => {
    const config = Configurator.loadConfig();
    if (config && config.providers[provider]) {
      const entry = config.providers[provider] as any;
      const keys = normalizeApiKeys(entry.apiKeys ?? (entry.apiKey ? [entry.apiKey] : []));
      if (keys.length <= 1) return null;
      const current = getPrimaryApiKey(entry) ?? keys[0];
      const currentIndex = Math.max(0, keys.indexOf(current));
      const next = keys[(currentIndex + 1) % keys.length];
      entry.activeApiKey = next;
      entry.apiKey = next;
      Configurator.saveConfig(config);
      return config;
    }
    return null;
  },

  rotateModelVariant: (provider: ProviderName): OttoConfig | null => {
    const config = Configurator.loadConfig();
    if (config && config.providers[provider]) {
      const entry = config.providers[provider] as any;
      const models = normalizeModels(entry.models ?? (entry.model ? [entry.model] : []));
      if (models.length <= 1) return null;
      const current = getPrimaryModel(entry) ?? models[0];
      const currentIndex = Math.max(0, models.indexOf(current));
      const next = models[(currentIndex + 1) % models.length];
      entry.activeModel = next;
      entry.model = next;
      Configurator.saveConfig(config);
      return config;
    }
    return null;
  },

  updateSecurityMode: (mode: 'ask' | 'approve' | 'full') => {
    const config = Configurator.loadConfig();
    if (config) {
      config.security.mode = mode;
      Configurator.saveConfig(config);
      return config;
    }
    return null;
  },

  updateContextBar: (show: boolean) => {
    const config = Configurator.loadConfig();
    if (config) {
      config.defaults.showContextBar = show;
      Configurator.saveConfig(config);
      return config;
    }
    return null;
  },

  updateAllowedCommands: (allowedCommands: string[]) => {
    const config = Configurator.loadConfig();
    if (config) {
      config.security.allowedCommands = allowedCommands;
      Configurator.saveConfig(config);
      return config;
    }
    return null;
  },

  updateModel: (provider: ProviderName, model: string) => {
    const config = Configurator.loadConfig();
    if (config) {
      if (!config.providers[provider]) {
        config.providers[provider] = { model, models: [model], activeModel: model } as any;
      } else {
        const entry = config.providers[provider] as any;
        entry.model = model;
        entry.activeModel = model;
        entry.models = normalizeModels([...(entry.models ?? []), model]);
      }
      Configurator.saveConfig(config);
      return config;
    }
    return null;
  },

  addModelVariant: (provider: ProviderName, model: string) => {
    const config = Configurator.loadConfig();
    if (config) {
      if (!config.providers[provider]) {
        config.providers[provider] = { model, models: [model], activeModel: model } as any;
      } else {
        const entry = config.providers[provider] as any;
        entry.models = normalizeModels([...(entry.models ?? []), model]);
        if (!entry.activeModel && !entry.model) {
          entry.activeModel = model;
          entry.model = model;
        }
      }
      Configurator.saveConfig(config);
      return config;
    }
    return null;
  },

  removeModelVariant: (provider: ProviderName, model: string) => {
    const config = Configurator.loadConfig();
    if (config && config.providers[provider]) {
      const entry = config.providers[provider] as any;
      entry.models = normalizeModels((entry.models ?? []).filter((m: string) => m !== model));
      if (entry.activeModel === model || entry.model === model) {
        const next = entry.models[0];
        entry.activeModel = next;
        entry.model = next;
      }
      Configurator.saveConfig(config);
      return config;
    }
    return null;
  },

  renameModelVariant: (provider: ProviderName, oldModel: string, newModel: string) => {
    const config = Configurator.loadConfig();
    if (config && config.providers[provider]) {
      const entry = config.providers[provider] as any;
      const nextModels = normalizeModels((entry.models ?? []).map((m: string) => (m === oldModel ? newModel : m)));
      entry.models = nextModels;
      if (entry.activeModel === oldModel || entry.model === oldModel) {
        entry.activeModel = newModel;
        entry.model = newModel;
      }
      Configurator.saveConfig(config);
      return config;
    }
    return null;
  },

  setActiveModel: (provider: ProviderName, model: string) => {
    const config = Configurator.loadConfig();
    if (config) {
      if (!config.providers[provider]) {
        config.providers[provider] = { model, models: [model], activeModel: model } as any;
      } else {
        const entry = config.providers[provider] as any;
        entry.models = normalizeModels([...(entry.models ?? []), model]);
        entry.activeModel = model;
        entry.model = model;
      }
      Configurator.saveConfig(config);
      return config;
    }
    return null;
  },

  updateUsername: (username: string) => {
    const config = Configurator.loadConfig();
    if (config) {
      if (!config.profile) config.profile = {};
      config.profile.username = username.trim();
      Configurator.saveConfig(config);
      return config;
    }
    return null;
  },

  updateOllamaUrl: (url: string) => {
    const config = Configurator.loadConfig();
    if (config) {
      if (!config.providers.ollama) {
        config.providers.ollama = { baseUrl: url, num_ctx: 4096 };
      } else {
        config.providers.ollama.baseUrl = url;
      }
      Configurator.saveConfig(config);
      return config;
    }
    return null;
  },

  getUsername: (config: OttoConfig): string => {
    return config.profile?.username?.trim() || '';
  },

  /** Returns stored max or a CPU-healthy default: min(20, max(5, cores*2)) */
  getMaxThreads: (config: OttoConfig): number => {
    if (typeof config.defaults.maxThreads === 'number' && config.defaults.maxThreads > 0) {
      return config.defaults.maxThreads;
    }
    const cores = os.cpus().length;
    return Math.min(20, Math.max(5, cores * 2));
  },

  updateMaxThreads: (n: number) => {
    const config = Configurator.loadConfig();
    if (config) {
      config.defaults.maxThreads = Math.max(1, Math.round(n));
      Configurator.saveConfig(config);
      return config;
    }
    return null;
  }
};
