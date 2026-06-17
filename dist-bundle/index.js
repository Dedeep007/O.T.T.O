// src/cli/configurator.ts
import fs from "fs";
import path from "path";
import os from "os";
import { input, select } from "@inquirer/prompts";

// src/cli/ui.ts
import chalk from "chalk";
import { marked } from "marked";
import TerminalRenderer from "marked-terminal";
marked.setOptions({
  renderer: new TerminalRenderer({
    // Customize styles if needed, but defaults are usually fine
    // We want yellow accent color
    firstHeading: chalk.yellow.bold,
    heading: chalk.yellow.bold,
    strong: chalk.bold,
    em: chalk.italic,
    codespan: chalk.yellow,
    del: chalk.dim.strikethrough,
    link: chalk.blue,
    href: chalk.blue.underline
  })
});
var ui = {
  accent: chalk.yellow,
  header: (text) => {
    console.log(chalk.yellow.bold(`
=== ${text} ===
`));
  },
  alert: (text) => {
    console.log(chalk.yellow(`[!] ${text}`));
  },
  warning: (text) => {
    console.log(chalk.yellow.inverse(` WARNING `) + chalk.yellow(` ${text}`));
  },
  info: (text) => {
    console.log(chalk.blue(`[i] ${text}`));
  },
  success: (text) => {
    console.log(chalk.green(`[\u2713] ${text}`));
  },
  error: (text) => {
    console.log(chalk.red.bold(`[X] ERROR: `) + chalk.red(text));
  },
  renderMarkdown: (markdownString) => {
    const rendered = marked.parse(markdownString);
    console.log(rendered);
  },
  printPrompt: (machineInfo) => {
    process.stdout.write(chalk.yellow(`OTTO://${machineInfo}$ `));
  }
};

// src/cli/configurator.ts
var rcPath = path.join(os.homedir(), ".ottorc");
var Configurator = {
  loadConfig: () => {
    if (fs.existsSync(rcPath)) {
      try {
        const raw = fs.readFileSync(rcPath, "utf-8");
        return JSON.parse(raw);
      } catch (e) {
        ui.error(`Failed to parse ${rcPath}`);
        return null;
      }
    }
    return null;
  },
  saveConfig: (config) => {
    fs.writeFileSync(rcPath, JSON.stringify(config, null, 2), "utf-8");
    ui.success(`Saved configuration to ${rcPath}`);
  },
  wizard: async () => {
    ui.header("O.T.T.O Initial Configurator Wizard");
    const primaryProvider = await select({
      message: "Select your primary LLM provider:",
      choices: [
        { name: "Groq", value: "groq" },
        { name: "OpenAI", value: "openai" },
        { name: "Anthropic", value: "anthropic" },
        { name: "Ollama (Local)", value: "ollama" }
      ]
    });
    const providers = {};
    if (primaryProvider === "groq") {
      const apiKey = await input({ message: "Enter your Groq API Key:" });
      providers.groq = { apiKey, frequency_penalty: 0 };
    }
    const securityMode = await select({
      message: "Select Security Mode:",
      choices: [
        { name: "Ask for approval (Safest)", value: "ask" },
        { name: "Approve for me (Executes whitelisted silently)", value: "approve" },
        { name: "Full access (Docker Isolated)", value: "full" }
      ]
    });
    const config = {
      providers,
      defaults: {
        primaryProvider
      },
      security: {
        mode: securityMode,
        allowedCommands: ["npm", "git", "node", "tsc"],
        allowedApps: [],
        allowedPorts: []
      },
      memory: {
        embeddingsProvider: "ollama"
      }
    };
    Configurator.saveConfig(config);
    return config;
  },
  init: async () => {
    let config = Configurator.loadConfig();
    if (!config) {
      config = await Configurator.wizard();
    }
    return config;
  }
};

// src/cli/session.ts
import os3 from "os";

// src/db/checkpoint.ts
import Database from "better-sqlite3";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import path2 from "path";
import os2 from "os";
var DBManager = class {
  db;
  saver;
  constructor() {
    const dbPath = path2.join(os2.homedir(), ".otto_checkpoint.db");
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS otto_threads (
        id TEXT PRIMARY KEY,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    this.saver = new SqliteSaver(this.db);
  }
  async setup() {
    await this.saver.setup();
  }
  registerThread(id) {
    const stmt = this.db.prepare(`
      INSERT INTO otto_threads (id) VALUES (?)
      ON CONFLICT(id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
    `);
    stmt.run(id);
  }
  listThreads() {
    const stmt = this.db.prepare("SELECT id FROM otto_threads ORDER BY updated_at DESC");
    return stmt.all().map((row) => row.id);
  }
};
var dbManager = new DBManager();

// src/cli/session.ts
var ChatSession = class {
  threadId;
  username;
  hostname;
  constructor() {
    this.threadId = `session-${Math.random().toString(36).substring(2, 8)}`;
    this.username = os3.userInfo().username;
    this.hostname = os3.hostname();
    dbManager.registerThread(this.threadId);
  }
  switchThread(id) {
    this.threadId = id;
    dbManager.registerThread(this.threadId);
    ui.success(`Switched to thread: ${id}`);
  }
  listThreads() {
    const threads = dbManager.listThreads();
    ui.header("Available Threads");
    threads.forEach((t) => ui.info(t + (t === this.threadId ? " (active)" : "")));
  }
  getPromptInfo() {
    const cwd = process.cwd();
    const shortCwd = cwd.replace(os3.homedir(), "~");
    return `[${this.threadId}]\u{1F464} ${this.username}@${this.hostname}:${shortCwd}`;
  }
};
var chatSession = new ChatSession();

// src/llm/provider.ts
import { ChatGroq } from "@langchain/groq";
import { ChatOpenAI } from "@langchain/openai";

// src/llm/quota.ts
var QuotaManager = class {
  backoffTime = 1e3;
  maxRetries = 3;
  async handleRateLimit(retryAfterHeader) {
    let waitTime = this.backoffTime;
    if (retryAfterHeader) {
      const parsed = parseInt(retryAfterHeader, 10);
      if (!isNaN(parsed)) {
        waitTime = parsed * 1e3;
      }
    }
    ui.warning(`Rate limit hit (429). Pausing execution for ${waitTime}ms to prevent TPM exhaustion.`);
    return new Promise((resolve) => setTimeout(() => {
      this.backoffTime = Math.min(this.backoffTime * 2 + Math.random() * 500, 6e4);
      resolve();
    }, waitTime));
  }
  resetBackoff() {
    this.backoffTime = 1e3;
  }
};
var quotaManager = new QuotaManager();

// src/llm/provider.ts
var ProviderEngine = class {
  config;
  primaryModel = null;
  constructor(config) {
    this.config = config;
    this.initProvider();
  }
  initProvider() {
    const providerName = this.config.defaults.primaryProvider;
    try {
      if (providerName === "groq" && this.config.providers.groq?.apiKey) {
        this.primaryModel = new ChatGroq({
          apiKey: this.config.providers.groq.apiKey,
          model: "qwen-2.5-coder-32b",
          // Closest to requested qwen3.6-27b on Groq if exact match fails
          temperature: 0,
          maxRetries: 0
          // We handle retries manually for quota
        });
        ui.info("Initialized Groq Provider Engine.");
      } else if (providerName === "openai" && this.config.providers.openai?.apiKey) {
        this.primaryModel = new ChatOpenAI({
          openAIApiKey: this.config.providers.openai.apiKey,
          modelName: "gpt-4o",
          maxRetries: 0
        });
        ui.info("Initialized OpenAI Provider Engine.");
      } else {
        ui.warning(`Provider ${providerName} is not fully configured or supported yet.`);
      }
    } catch (e) {
      ui.error(`Failed to initialize provider: ${e.message}`);
    }
  }
  async invoke(messages, attempt = 1) {
    if (!this.primaryModel) {
      throw new Error("No valid LLM provider initialized.");
    }
    try {
      const response = await this.primaryModel.invoke(messages);
      quotaManager.resetBackoff();
      return response;
    } catch (error) {
      if (error?.status === 429 || error?.response?.status === 429) {
        const retryAfter = error?.response?.headers?.["retry-after"];
        await quotaManager.handleRateLimit(retryAfter);
        if (attempt <= 3) {
          ui.info(`Retrying request (Attempt ${attempt + 1}/3)...`);
          return this.invoke(messages, attempt + 1);
        } else {
          ui.error("Max retries exceeded due to TPM exhaustion.");
          throw error;
        }
      }
      throw error;
    }
  }
  getModel() {
    if (!this.primaryModel) throw new Error("Model not initialized");
    return this.primaryModel;
  }
};

// src/memory/budget.ts
import { SystemMessage } from "@langchain/core/messages";
import { trimMessages } from "@langchain/core/messages";
var MemoryManager = class {
  C_max = 32e3;
  // Qwen context limit estimate or could be parameterized
  B_sys = 2e3;
  // System prompt budget
  B_out = 2e3;
  // Expected output buffer
  Max_Msg_Tokens = 4e3;
  // Truncation threshold for single huge payloads
  getChatBudget() {
    return this.C_max - (this.B_sys + this.B_out);
  }
  // Rough estimation of tokens based on character count (1 token ~= 4 chars)
  estimateTokens(text) {
    return Math.ceil(text.length / 4);
  }
  perMessageTruncate(text) {
    const tokens = this.estimateTokens(text);
    if (tokens > this.Max_Msg_Tokens) {
      ui.alert(`Payload truncated. Original size: ~${tokens} tokens, limit: ${this.Max_Msg_Tokens}`);
      const allowedChars = this.Max_Msg_Tokens * 4;
      return text.substring(0, allowedChars) + "\n\n...[TRUNCATED BY OTTO BUDGETER]...";
    }
    return text;
  }
  async optimizeContext(messages, systemPrompt) {
    const budget = this.getChatBudget();
    const trimmed = await trimMessages(messages, {
      maxTokens: budget,
      tokenCounter: (msgs) => msgs.reduce((acc, m) => acc + this.estimateTokens(m.content.toString()), 0),
      strategy: "last",
      allowPartial: false,
      includeSystem: true
      // Keep the system message intact
    });
    const hasSystem = trimmed.find((m) => m._getType() === "system");
    const finalMessages = hasSystem ? trimmed : [new SystemMessage(systemPrompt), ...trimmed];
    return finalMessages;
  }
};
var memoryManager = new MemoryManager();

// src/security/rules.ts
import fs2 from "fs";
import path3 from "path";
import os4 from "os";
import { select as select2 } from "@inquirer/prompts";
var RuleGuardrail = class {
  rulesPath;
  constructor() {
    this.rulesPath = path3.join(os4.homedir(), ".otto", "rules.md");
    this.ensureRulesExist();
  }
  ensureRulesExist() {
    const dir = path3.dirname(this.rulesPath);
    if (!fs2.existsSync(dir)) fs2.mkdirSync(dir, { recursive: true });
    if (!fs2.existsSync(this.rulesPath)) {
      fs2.writeFileSync(this.rulesPath, "# O.T.T.O System Directives\n\nThese are the core rules the agent must follow.", "utf-8");
    }
  }
  getRules() {
    return fs2.readFileSync(this.rulesPath, "utf-8");
  }
  async requestRuleChange(newRulesContent) {
    const currentRules = this.getRules();
    ui.header("CRITICAL: Rule Modification Requested (L3 Guardrail)");
    ui.alert("The agent is attempting to modify its own core directives.");
    console.log(ui.accent("--- Current Rules ---"));
    console.log(currentRules);
    console.log(ui.accent("--- Proposed Rules ---"));
    console.log(newRulesContent);
    const approved = await select2({
      message: "Do you authorize this permanent change to the System Directives?",
      choices: [
        { name: "Approve", value: true },
        { name: "Deny", value: false }
      ]
    });
    if (approved) {
      fs2.writeFileSync(this.rulesPath, newRulesContent, "utf-8");
      ui.success("Rules updated successfully.");
      return true;
    } else {
      ui.error("Rule modification denied.");
      return false;
    }
  }
};
var ruleGuardrail = new RuleGuardrail();

// src/index.ts
import * as readline from "readline";
import { SystemMessage as SystemMessage2, HumanMessage as HumanMessage2 } from "@langchain/core/messages";
async function main() {
  const config = await Configurator.init();
  const provider = new ProviderEngine(config);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  ui.header("O.T.T.O Core Initialized");
  const rules = ruleGuardrail.getRules();
  const chatLoop = () => {
    ui.printPrompt(chatSession.getPromptInfo());
    rl.question("", async (inputStr) => {
      inputStr = inputStr.trim();
      if (!inputStr) return chatLoop();
      if (inputStr.startsWith("/")) {
        const [cmd, ...args] = inputStr.split(" ");
        if (cmd === "/exit") {
          ui.info("Shutting down O.T.T.O...");
          rl.close();
          process.exit(0);
        } else if (cmd === "/threads") {
          chatSession.listThreads();
        } else if (cmd === "/switch") {
          if (args[0]) chatSession.switchThread(args[0]);
        }
        return chatLoop();
      }
      try {
        const messages = [new SystemMessage2(rules), new HumanMessage2(inputStr)];
        const optimizedMsgs = await memoryManager.optimizeContext(messages, rules);
        ui.info("Agent thinking...");
        const response = await provider.invoke(optimizedMsgs);
        ui.renderMarkdown(response.content.toString());
      } catch (error) {
        ui.error(error.message);
      }
      chatLoop();
    });
  };
  chatLoop();
}
main().catch((err) => {
  ui.error(err.message);
  process.exit(1);
});
