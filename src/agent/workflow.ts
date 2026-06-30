import { BaseMessage, HumanMessage, AIMessage, ToolMessage, SystemMessage } from '@langchain/core/messages';
import { RequestPipeline } from './request_pipeline.js';
import { NodeRunner } from './node_runner.js';
import { executor } from '../security/executor.js';
import { snapshotManager } from '../cli/snapshots.js';
import { ProviderRegistry } from '../providers/registry.js';
import { OttoConfig } from '../cli/configurator.js';
import { AgentMode, AgentRegistry } from './agents.js';
import { classifyAssistantStep } from './classify.js';
import { RouterAgent } from './router.js';
import { TokenLimiter } from './token_limiter.js';
import { buildAgentGraph } from './graph.js';

export interface WorkflowContext {
  chatSession: any;
  messages: BaseMessage[];
  config: OttoConfig;
  provider: ProviderRegistry;
  phone: any;
  ui: any;
  dbManager: any;
  stripToolBleed: (text: string) => string;
  parseFallbackToolCalls: (text: string, messages?: any[]) => any[] | null;
  setPendingPlan: (val: boolean) => void;
  setPlanMenuIndex: (val: number) => void;
  render: (force?: boolean) => void;
  syncMessages: () => void;
  agentMode?: AgentMode;
}

const PLAN_BLOCK_RE = /<!--\s*PLAN_START\s*-->[\s\S]*?<!--\s*PLAN_END\s*-->/;

export class AgentWorkflow {
  private graph: any;

  constructor() {
    this.graph = buildAgentGraph();
  }

  public async runAgentLoop(
    ctx: WorkflowContext,
    injectPrompt?: string
  ): Promise<void> {
    if (ctx.chatSession.cancelledThreads.has(ctx.chatSession.threadId)) {
      return;
    }

    if (injectPrompt) {
      ctx.messages.push(new HumanMessage(injectPrompt));
      ctx.syncMessages();
    }
    
    // Invoke LangGraph
    const initialState = {
      messages: ctx.messages,
      context: ctx,
      approvalStatus: 'none',
      activeAgent: 'build'
    };

    const config = { configurable: { thread_id: ctx.chatSession.threadId } };

    const finalState = await this.graph.invoke(initialState, config);
    
    // LangGraph appends messages to state
    ctx.messages.length = 0;
    ctx.messages.push(...finalState.messages);
    ctx.syncMessages();
    
    if (finalState.approvalStatus === 'pending') {
       return;
    }
    
    ctx.chatSession.agentStates.set(ctx.chatSession.threadId, 'idle');
    if (ctx.chatSession.isChatActive) ctx.render(true);
    
    if (!ctx.chatSession.cancelledThreads.has(ctx.chatSession.threadId)) {
      snapshotManager.saveCheckpoint(ctx.chatSession.threadId, ctx.messages.length - 1);
    }
  }
}
