import { BaseMessage, HumanMessage, SystemMessage, AIMessage, ToolMessage } from '@langchain/core/messages';
import { trimMessages } from '@langchain/core/messages';
import { ui } from '../cli/ui.js';

export class MemoryManager {
  private C_max: number = 32000; // Qwen context limit estimate or could be parameterized
  private B_sys: number = 2000;  // System prompt budget
  private B_out: number = 2000;  // Expected output buffer
  private Max_Msg_Tokens: number = 4000; // Truncation threshold for single huge payloads
  private SummaryBudget: number = 1200;

  private lastContextSize: number = 0;
  private totalCompressedTokens: number = 0;
  private lastSummary: string = '';

  getChatBudget(): number {
    return this.C_max - (this.B_sys + this.B_out);
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
    const filled = conversational.reduce((acc, message) => {
      const content = message?.content?.toString?.() ?? '';
      return acc + this.estimateTokens(content);
    }, systemTokens);

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

  public perMessageTruncate(text: string): string {
    const tokens = this.estimateTokens(text);
    if (tokens > this.Max_Msg_Tokens) {
      ui.alert(`Payload truncated. Original size: ~${tokens} tokens, limit: ${this.Max_Msg_Tokens}`);
      const allowedChars = this.Max_Msg_Tokens * 4;
      this.totalCompressedTokens += (tokens - this.Max_Msg_Tokens);
      return text.substring(0, allowedChars) + '\n\n...[TRUNCATED BY OTTO BUDGETER]...';
    }
    return text;
  }

  public async optimizeContext(messages: BaseMessage[], systemPrompt: string): Promise<BaseMessage[]> {
    const conversationalMessages = messages.filter(message => message._getType() !== 'system');

    const normalizedMessages = conversationalMessages.map((message) => {
      const content = message.content.toString();
      const truncatedContent = this.perMessageTruncate(content);
      if (truncatedContent === content) return message;

      if (message instanceof HumanMessage) {
        return new HumanMessage(truncatedContent);
      }
      if (message instanceof AIMessage) {
        return new AIMessage(truncatedContent);
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

    const baseBudget = this.getChatBudget();
    const summaryBudget = Math.min(this.SummaryBudget, Math.max(400, Math.floor(baseBudget * 0.15)));
    const workingBudget = Math.max(1200, baseBudget - summaryBudget);

    const trimmed = await trimMessages(normalizedMessages, {
      maxTokens: workingBudget,
      tokenCounter: (msgs: BaseMessage[]) => msgs.reduce((acc, m) => acc + this.estimateTokens(m.content.toString()), 0),
      strategy: 'last',
      allowPartial: false,
      includeSystem: false
    });

    const dropped = normalizedMessages.slice(0, Math.max(0, normalizedMessages.length - trimmed.length));
    const summaryText = this.buildSummary(dropped);
    this.lastSummary = summaryText;

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
      const content = message.content.toString().replace(/\s+/g, ' ').trim();
      if (!content) continue;

      if (type === 'human') {
        const short = this.shortenForSummary(content, 100);
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
