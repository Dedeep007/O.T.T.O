import os from 'os';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { dbManager } from '../db/checkpoint.js';
import { ui } from './ui.js';
import { EventEmitter } from 'events';

export const sessionEvents = new EventEmitter();

type SerializedChatMessage = {
  role: 'human' | 'ai' | 'system' | 'tool';
  content: string;
  name?: string;
  id?: string;
  tool_call_id?: string;
  tool_calls?: any[];
  invalid_tool_calls?: any[];
  additional_kwargs?: Record<string, any>;
  response_metadata?: Record<string, any>;
};

export class ChatSession {
  public threadId: string;
  public threadName: string;
  private username: string;
  private hostname: string;
  public threadMessages = new Map<string, any[]>();
  public activeStreams = new Set<string>();
  public cancelledThreads = new Set<string>();
  public isChatActive = false;
  public pendingApprovals: {
    threadId: string;
    type: 'command' | 'app';
    cmd: string;
    commandStr: string;
    resolve: (choice: 'now' | 'always' | 'deny') => void;
  }[] = [];
  public pendingPlans = new Set<string>();
  public agentStates = new Map<string, 'thinking' | 'tools' | 'idle' | 'delaying'>();
  public delayMessages = new Map<string, string>();
  public planMenuIndices = new Map<string, number>();
  public approvalMenuIndices = new Map<string, number>();
  private static readonly DEFAULT_THREAD_NAME = 'New Chat';

  constructor() {
    this.username = os.userInfo().username;
    this.hostname = os.hostname();

    // Try to resume the last active thread
    const lastId = dbManager.getLastActiveThread();
    if (lastId) {
      this.threadId = lastId;
      const thread = dbManager.getThread(lastId);
      this.threadName = thread?.displayName ?? ChatSession.DEFAULT_THREAD_NAME;
      this.threadMessages.set(this.threadId, this.deserializeMessages(dbManager.loadThreadMessages(this.threadId)));
    } else {
      // Fresh start — create a new thread
      this.threadId = `session-${Math.random().toString(36).substring(2, 8)}`;
      this.threadName = ChatSession.DEFAULT_THREAD_NAME;
      dbManager.registerThread(this.threadId, this.threadName);
      this.threadMessages.set(this.threadId, []);
      dbManager.saveThreadMessages(this.threadId, []);
      dbManager.setLastActiveThread(this.threadId);
    }
  }

  public switchThread(id: string) {
    this.persistThread(this.threadId);
    this.threadId = id;
    const thread = dbManager.getThread(this.threadId);
    this.threadName = thread?.displayName ?? ChatSession.DEFAULT_THREAD_NAME;
    dbManager.registerThread(this.threadId, this.threadName);
    dbManager.setLastActiveThread(this.threadId);
    this.threadMessages.set(this.threadId, this.deserializeMessages(dbManager.loadThreadMessages(this.threadId)));
    ui.success(`Switched to thread: ${this.threadName}`);
  }

  public createFreshThread(displayName: string = ChatSession.DEFAULT_THREAD_NAME) {
    this.persistThread(this.threadId);
    this.threadId = `session-${Math.random().toString(36).substring(2, 8)}`;
    this.threadName = displayName;
    dbManager.registerThread(this.threadId, this.threadName);
    dbManager.setLastActiveThread(this.threadId);
    this.threadMessages.set(this.threadId, []);
    dbManager.saveThreadMessages(this.threadId, []);
  }

  public ensureNamedFromPrompt(prompt: string) {
    if (this.threadName !== ChatSession.DEFAULT_THREAD_NAME) return;
    const nextName = this.summarizeThreadName(prompt);
    this.threadName = nextName;
    dbManager.updateThreadName(this.threadId, nextName);
  }

  public listThreads() {
    const threads = dbManager.listThreads();
    ui.header('Available Threads');
    threads.forEach(t => ui.info(`${t.displayName} [${t.id}]${t.id === this.threadId ? ' (active)' : ''}`));
  }

  public getPromptInfo(): string {
    const cwd = process.cwd();
    const shortCwd = cwd.replace(os.homedir(), '~');
    return `[${this.threadName}] ${this.username}@${this.hostname}:${shortCwd}`;
  }

  public getMessages(): any[] {
    if (!this.threadMessages.has(this.threadId)) {
      this.threadMessages.set(this.threadId, this.deserializeMessages(dbManager.loadThreadMessages(this.threadId)));
    }
    return this.threadMessages.get(this.threadId)!;
  }

  public setMessages(messages: any[]) {
    const next = Array.from(messages ?? []);
    this.threadMessages.set(this.threadId, next);
    dbManager.saveThreadMessages(this.threadId, next.map(message => this.serializeMessage(message)).filter(Boolean));
  }

  public clearThreadMessages(id: string) {
    this.threadMessages.delete(id);
    dbManager.saveThreadMessages(id, []);
  }

  public clearAllThreadMessages() {
    this.threadMessages.clear();
    this.threadMessages.set(this.threadId, []);
    dbManager.saveThreadMessages(this.threadId, []);
  }

  private persistThread(id: string) {
    const messages = this.threadMessages.get(id);
    if (messages) {
      dbManager.saveThreadMessages(id, messages.map(message => this.serializeMessage(message)).filter(Boolean));
    }
  }

  private serializeMessage(message: any): SerializedChatMessage | null {
    if (!message?._getType) return null;
    const role = message._getType();
    const content = message.content?.toString?.() ?? '';
    const base = {
      content,
      name: message.name,
      id: message.id,
      additional_kwargs: message.additional_kwargs ?? {},
      response_metadata: message.response_metadata ?? {}
    };

    if (role === 'human') {
      return { role, ...base };
    }

    if (role === 'ai') {
      return {
        role,
        ...base,
        tool_calls: message.tool_calls ?? [],
        invalid_tool_calls: message.invalid_tool_calls ?? []
      };
    }

    if (role === 'tool') {
      return {
        role,
        ...base,
        tool_call_id: message.tool_call_id
      };
    }

    return { role: 'system', ...base };
  }

  private deserializeMessages(messages: any[]): any[] {
    if (!Array.isArray(messages)) return [];
    return messages.map((message: SerializedChatMessage) => {
      if (!message || typeof message !== 'object') return null;
      const content = message.content ?? '';

      if (message.role === 'human') {
        return new HumanMessage({
          content,
          name: message.name,
          id: message.id,
          additional_kwargs: message.additional_kwargs ?? {}
        } as any);
      }

      if (message.role === 'ai') {
        return new AIMessage({
          content,
          name: message.name,
          id: message.id,
          tool_calls: message.tool_calls ?? [],
          invalid_tool_calls: message.invalid_tool_calls ?? [],
          additional_kwargs: message.additional_kwargs ?? {},
          response_metadata: message.response_metadata ?? {}
        } as any);
      }

      if (message.role === 'tool') {
        return new ToolMessage({
          content,
          tool_call_id: message.tool_call_id ?? '',
          name: message.name,
          id: message.id,
          additional_kwargs: message.additional_kwargs ?? {}
        } as any);
      }

      return new SystemMessage({
        content,
        name: message.name,
        id: message.id,
        additional_kwargs: message.additional_kwargs ?? {}
      } as any);
    }).filter(Boolean);
  }

  private summarizeThreadName(prompt: string): string {
    const cleaned = prompt
      .replace(/[`"'()[\]{}<>]/g, ' ')
      .replace(/\b(can|could|would|please|help|with|that|this|need|want|make|build|create|write|generate|show|tell|about|for|the|a|an|to|of|in|on|and|or|my|me)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const tokens = cleaned
      .split(' ')
      .map(token => token.trim())
      .filter(Boolean);

    if (tokens.length === 0) return ChatSession.DEFAULT_THREAD_NAME;

    const normalized = tokens
      .slice(0, 4)
      .map(token => {
        const lower = token.toLowerCase();
        if (lower === 'cpp' || lower === 'c++') return 'CPP';
        if (lower === 'js') return 'JS';
        if (lower === 'ts') return 'TS';
        return lower.charAt(0).toUpperCase() + lower.slice(1);
      })
      .join(' ');

    return normalized.length > 40 ? normalized.slice(0, 40).trim() : normalized;
  }
}

export const chatSession = new ChatSession();
