import { BaseMessage, HumanMessage, SystemMessage, AIMessage, ToolMessage } from '@langchain/core/messages';
import { trimMessages } from '@langchain/core/messages';
import { ui } from '../cli/ui.js';
import { Configurator, OttoConfig } from '../cli/configurator.js';

export class MemoryManager {
  private config: OttoConfig | null = null;

  public setConfig(newConfig: OttoConfig) {
    this.config = newConfig;
  }

  get C_max(): number {
    try {
      const config = this.config || Configurator.loadConfig();
      if (config) {
        const prov = config.defaults.primaryProvider;
        const model = Configurator.getActiveModel(config, prov as any);

        let providerDefault = 64000;
        if (prov === 'openai') providerDefault = 128000;
        else if (prov === 'anthropic') providerDefault = 200000;
        else if (prov === 'gemini') providerDefault = 128000;
        else if (prov === 'mistral') providerDefault = 128000;
        else if (prov === 'bedrock') providerDefault = 200000;
        else if (prov === 'groq') providerDefault = 32768;
        else if (prov === 'ollama') providerDefault = 64000;

        if (model) {
          const limits = config.modelLimits?.[model];
          if (limits && typeof limits.tpm === 'number' && limits.tpm > 0) {
            const safetyBuffer = Math.min(1000, Math.floor(limits.tpm * 0.1));
            return Math.min(config.defaults.maxCtx || providerDefault, limits.tpm - safetyBuffer);
          }
        }
        if (typeof config.defaults.maxCtx === 'number') {
          return Math.min(providerDefault, config.defaults.maxCtx);
        }
        return providerDefault;
      }
    } catch {}
    return 64000;
  }
  private B_sys: number = 3000;  // System prompt budget
  private B_out: number = 4000;  // Expected output buffer
  private Max_Msg_Tokens: number = 20000; // Increased truncation threshold for large files/logs
  private SummaryBudget: number = 4000;

  private lastContextSize: number = 0;
  private totalCompressedTokens: number = 0;
  private lastSummary: string = '';

  getChatBudget(): number {
    const cMax = this.C_max;
    const bSys = cMax < 10000 ? Math.floor(cMax * 0.25) : this.B_sys;
    const bOut = cMax < 10000 ? Math.floor(cMax * 0.25) : this.B_out;
    return cMax - (bSys + bOut);
  }

  getBudgetStats(): { max: number; filled: number; compressed: number } {
    return {
      max: this.C_max,
      filled: this.lastContextSize,
      compressed: this.totalCompressedTokens
    };
  }

  getBudgetStatsForMessages(messages: BaseMessage[], systemPrompt: string = ''): { max: number; filled: number; compressed: number } {
    const conversational = messages.filter(message => message._getType?.() !== 'system');
    const systemTokens = systemPrompt ? this.estimateTokens(systemPrompt) : 0;
    
    const isSmall = this.C_max < 5000;
    const limit = Math.min(this.Max_Msg_Tokens, Math.max(isSmall ? 200 : 1000, Math.floor(this.C_max * 0.5)));
    const baseBudget = this.getChatBudget();
    const summaryBudget = Math.min(this.SummaryBudget, Math.max(isSmall ? 50 : 400, Math.floor(baseBudget * 0.15)));
    const workingBudget = Math.max(isSmall ? 200 : 1200, baseBudget - summaryBudget);

    const reversed = [...conversational].reverse();
    let accumulated = 0;
    
    for (const msg of reversed) {
      const content = msg?.content?.toString?.() ?? '';
      const tokens = this.estimateTokens(content);
      const truncatedTokens = Math.min(tokens, limit);
      if (accumulated + truncatedTokens <= workingBudget) {
        accumulated += truncatedTokens;
      } else {
        break;
      }
    }
    
    const filled = systemTokens + accumulated;

    return {
      max: this.C_max,
      filled,
      compressed: this.totalCompressedTokens
    };
  }

  getLastSummary(): string {
    return this.lastSummary;
  }

  // Rough estimation of tokens based on character count (1 token ~= 4 chars)
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  public perMessageTruncate(text: string, workingBudget?: number): string {
    const tokens = this.estimateTokens(text);
    const limit = workingBudget ?? this.C_max;
    if (tokens > limit) {
      ui.alert(`Payload truncated. Original size: ~${tokens} tokens, limit: ${limit}`);
      const allowedChars = limit * 4;
      this.totalCompressedTokens += (tokens - limit);
      return text.substring(0, allowedChars) + '\n\n...[TRUNCATED BY OTTO BUDGETER]...';
    }
    return text;
  }

  public async optimizeContext(messages: BaseMessage[], systemPrompt: string, originalHistory?: BaseMessage[]): Promise<BaseMessage[]> {
    const baseBudget = this.getChatBudget();
    const isSmall = this.C_max < 5000;
    const summaryBudget = Math.min(this.SummaryBudget, Math.max(isSmall ? 50 : 400, Math.floor(baseBudget * 0.15)));
    const workingBudget = Math.max(isSmall ? 200 : 1200, baseBudget - summaryBudget);

    const conversationalMessages = messages.filter(message => message._getType() !== 'system');

    const normalizedMessages = conversationalMessages.map((message) => {
      const content = message.content.toString();
      const truncatedContent = this.perMessageTruncate(content, workingBudget);
      if (truncatedContent === content) return message;

      if (message instanceof HumanMessage) {
        return new HumanMessage(truncatedContent);
      }
      if (message instanceof AIMessage) {
        const msgOpts: any = { content: truncatedContent };
        if ((message as any).tool_calls) msgOpts.tool_calls = (message as any).tool_calls;
        if ((message as any).invalid_tool_calls) msgOpts.invalid_tool_calls = (message as any).invalid_tool_calls;
        return new AIMessage(msgOpts);
      }
      if (message instanceof ToolMessage) {
        return new ToolMessage({
          content: truncatedContent,
          tool_call_id: (message as any).tool_call_id,
          name: (message as any).name
        });
      }
      return new SystemMessage(truncatedContent);
    });



    const trimmed = await trimMessages(normalizedMessages, {
      maxTokens: workingBudget,
      tokenCounter: (msgs: BaseMessage[]) => msgs.reduce((acc, m) => acc + this.estimateTokens(m.content.toString()), 0),
      strategy: 'last',
      startOn: 'human',
      allowPartial: false,
      includeSystem: false
    });

    const dropped = normalizedMessages.slice(0, Math.max(0, normalizedMessages.length - trimmed.length));
    
    // Ensure we always preserve at least the latest human message to prevent API errors
    const hasHuman = trimmed.some(m => m._getType() === 'human');
    if (!hasHuman) {
      const lastHuman = [...normalizedMessages].reverse().find(m => m._getType() === 'human');
      if (lastHuman) {
        trimmed.unshift(lastHuman);
      }
    }

    let summaryText = '';
    if (dropped.length > 0) {
      if (originalHistory) {
        // Collect old summary system messages from the start of history to merge them
        const oldSummaries = originalHistory.filter(m => m._getType() === 'system');
        const itemsToSummarize = [...oldSummaries, ...dropped];
        summaryText = this.buildSummary(itemsToSummarize);
        this.lastSummary = summaryText;

        // Find where the first trimmed message starts in originalHistory
        let firstTrimmedIndex = originalHistory.length;
        if (trimmed.length > 0) {
          const firstTrimmed = trimmed[0];
          const idx = originalHistory.findIndex(m => m._getType() === firstTrimmed._getType() && m.content.toString() === firstTrimmed.content.toString());
          if (idx !== -1) {
            firstTrimmedIndex = idx;
          }
        }
        
        if (firstTrimmedIndex > 0) {
          originalHistory.splice(0, firstTrimmedIndex);
        }

        if (summaryText) {
          originalHistory.unshift(new SystemMessage(summaryText));
        }
      } else {
        summaryText = this.buildSummary(dropped);
        this.lastSummary = summaryText;
      }
    } else {
      if (originalHistory) {
        const existingSummary = originalHistory.find(m => m._getType() === 'system' && m.content.toString().startsWith('Conversation summary of earlier context:'));
        if (existingSummary) {
          summaryText = existingSummary.content.toString();
          this.lastSummary = summaryText;
        }
      }
    }

    const finalMessages = summaryText
      ? [new SystemMessage(systemPrompt), new SystemMessage(summaryText), ...trimmed.filter(m => m._getType() !== 'system')]
      : [new SystemMessage(systemPrompt), ...trimmed.filter(m => m._getType() !== 'system')];

    this.lastContextSize = finalMessages.reduce((acc, m) => acc + this.estimateTokens(m.content.toString()), 0);

    return finalMessages;
  }

  private buildSummary(dropped: BaseMessage[]): string {
    if (dropped.length === 0) return '';

    const userGoals: string[] = [];
    const files: string[] = [];
    const commands: string[] = [];
    const notes: string[] = [];

    for (const message of dropped) {
      const type = message._getType();
      const content = message.content.toString();
      const cleanedContent = content.replace(/\s+/g, ' ').trim();
      if (!cleanedContent) continue;

      if (type === 'system' && content.startsWith('Conversation summary of earlier context:')) {
        const lines = content.split('\n');
        for (const line of lines) {
          const cleanLine = line.trim();
          if (cleanLine.startsWith('- Earlier goals:')) {
            const items = cleanLine.substring('- Earlier goals:'.length).split('|').map(s => s.trim()).filter(Boolean);
            userGoals.push(...items);
          } else if (cleanLine.startsWith('- Files touched:')) {
            const items = cleanLine.substring('- Files touched:'.length).split(',').map(s => s.trim()).filter(Boolean);
            files.push(...items);
          } else if (cleanLine.startsWith('- Commands seen:')) {
            const items = cleanLine.substring('- Commands seen:'.length).split('|').map(s => s.trim()).filter(Boolean);
            commands.push(...items);
          } else if (cleanLine.startsWith('- Recent outcomes:')) {
            const items = cleanLine.substring('- Recent outcomes:'.length).split('|').map(s => s.trim()).filter(Boolean);
            notes.push(...items);
          }
        }
      } else if (type === 'human') {
        const short = this.shortenForSummary(cleanedContent, 100);
        if (short) userGoals.push(short);
        this.collectFiles(content, files);
      } else if (type === 'ai') {
        this.collectFiles(content, files);
        this.collectCommands(content, commands);
        const note = this.extractHeadline(content);
        if (note) notes.push(note);
      } else if (type === 'tool') {
        this.collectFiles(content, files);
        this.collectCommands(content, commands);
        const note = this.extractDiffHeadline(content);
        if (note) notes.push(note);
      }
    }

    const unique = (items: string[]) => Array.from(new Set(items)).slice(0, 8);
    const sections: string[] = [];

    const goals = unique(userGoals);
    if (goals.length) sections.push(`Earlier goals: ${goals.join(' | ')}`);

    const fileList = unique(files);
    if (fileList.length) sections.push(`Files touched: ${fileList.join(', ')}`);

    const cmdList = unique(commands);
    if (cmdList.length) sections.push(`Commands seen: ${cmdList.join(' | ')}`);

    const noteList = unique(notes);
    if (noteList.length) sections.push(`Recent outcomes: ${noteList.join(' | ')}`);

    if (!sections.length) return '';

    return [
      'Conversation summary of earlier context:',
      ...sections.map(line => `- ${line}`)
    ].join('\n');
  }

  private collectFiles(text: string, bucket: string[]) {
    const patterns = [
      /(?:^|[\s"'`([{])([A-Za-z]:[\\/][^\s"'`]+(?:\.[A-Za-z0-9_+-]+)?)/g,
      /(?:^|[\s"'`([{])([A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)+\.[A-Za-z0-9_+-]+?)/g,
      /---\s+([^\s]+)\s*$/gm,
      /\+\+\+\s+([^\s]+)\s*$/gm
    ];

    for (const pattern of patterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        const value = match[1].replace(/^[\s"'`([{]+|[\s"'`)\]}.,]+$/g, '');
        if (value && !bucket.includes(value)) bucket.push(value);
      }
    }
  }

  private collectCommands(text: string, bucket: string[]) {
    const match = text.match(/Command:\s*`([^`]+)`/i);
    if (match?.[1]) {
      const cmd = this.shortenForSummary(match[1], 120);
      if (cmd && !bucket.includes(cmd)) bucket.push(cmd);
    }
  }

  private extractHeadline(text: string): string {
    const sentence = text.split(/[.!?\n]/).map(s => s.trim()).find(Boolean) ?? '';
    return this.shortenForSummary(sentence, 110);
  }

  private extractDiffHeadline(text: string): string {
    const match = text.match(/^(Edited file|Created file|Deleted file):\s+(.+)$/m);
    if (match) return `${match[1]} ${this.shortenForSummary(match[2], 80)}`;
    return this.extractHeadline(text);
  }

  private shortenForSummary(text: string, maxLen: number): string {
    const cleaned = text.replace(/\s+/g, ' ').trim();
    if (!cleaned) return '';
    return cleaned.length > maxLen ? cleaned.slice(0, maxLen - 1).trimEnd() + '...' : cleaned;
  }
}

export const memoryManager = new MemoryManager();
