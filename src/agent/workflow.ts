import { BaseMessage, HumanMessage, AIMessage, ToolMessage } from '@langchain/core/messages';
import { RequestPipeline } from './request_pipeline.js';
import { NodeRunner } from './node_runner.js';
import { executor } from '../security/executor.js';
import { snapshotManager } from '../cli/snapshots.js';
import { ProviderRegistry } from '../providers/registry.js';
import { OttoConfig } from '../cli/configurator.js';

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
}

const PLAN_BLOCK_RE = /<!--\s*PLAN_START\s*-->[\s\S]*?<!--\s*PLAN_END\s*-->/;

export class AgentWorkflow {
  private runner: NodeRunner;

  constructor() {
    this.runner = new NodeRunner();
  }

  public async runAgentLoop(
    ctx: WorkflowContext,
    injectPrompt?: string,
    depth = 0
  ): Promise<void> {
    if (depth > 200) {
      ctx.ui.error('Agent loop max depth reached (200). Aborting to prevent infinite loop.');
      return;
    }
    
    if (ctx.chatSession.cancelledThreads.has(ctx.chatSession.threadId)) {
      return;
    }

    if (injectPrompt) {
      ctx.messages.push(new HumanMessage(injectPrompt));
      ctx.syncMessages();
    }

    const activeProvider = ctx.config.defaults.primaryProvider as string;
    const activeModel = ctx.config.providers[activeProvider as keyof typeof ctx.config.providers]?.activeModel || 'default';
    
    const finalMsgsToSend = await RequestPipeline.buildPayload(ctx.messages, ctx.config, activeModel);

    const aiMessage = new AIMessage('');
    ctx.messages.push(aiMessage);
    ctx.syncMessages();

    ctx.chatSession.agentStates.set(ctx.chatSession.threadId, 'thinking');
    if (ctx.chatSession.isChatActive) {
      ctx.render(true);
    }

    const stream = await ctx.provider.stream(finalMsgsToSend);
    
    this.runner.removeAllListeners();
    this.runner.on('stream_chunk', () => {
      if (ctx.chatSession.isChatActive) ctx.render();
    });
    this.runner.on('stream_update', () => {
      ctx.render(true);
    });

    const { finalMessage, isDone, hasToolCalls } = await this.runner.consumeStream(
      stream,
      aiMessage,
      ctx.chatSession.threadId,
      ctx.chatSession,
      ctx.stripToolBleed,
      ctx.parseFallbackToolCalls,
      ctx.messages
    );

    if (isDone) return;

    ctx.messages[ctx.messages.length - 1] = finalMessage;
    ctx.syncMessages();
    if (ctx.chatSession.isChatActive) {
      ctx.render(true);
    }

    const responseText = String(finalMessage?.content ?? '');
    const hasPlanBlock = PLAN_BLOCK_RE.test(responseText);

    if (hasPlanBlock && !hasToolCalls) {
      if (ctx.config.security.mode === 'full' || ctx.config.security.mode === 'approve') {
        ctx.setPendingPlan(false);
        setTimeout(() => {
          this.runAgentLoop(ctx, 'PLAN APPROVED. Do NOT output the plan tags again under any circumstances. Proceed immediately to execute ALL steps continuously.', depth + 1);
        }, 50);
        return;
      } else {
        ctx.setPendingPlan(true);
        ctx.setPlanMenuIndex(0);
        ctx.chatSession.agentStates.set(ctx.chatSession.threadId, 'idle');
        ctx.render(true);
        return;
      }
    }

    if (hasToolCalls && finalMessage.tool_calls) {
      ctx.chatSession.agentStates.set(ctx.chatSession.threadId, 'tools');
      ctx.render(true);

      for (const call of finalMessage.tool_calls) {
        if (ctx.chatSession.cancelledThreads.has(ctx.chatSession.threadId)) {
          break;
        }

        const toolCallId = call.id;
        const toolName = call.name;
        const args = call.args;

        if (ctx.config.security.mode === 'ask') {
          // Security prompt
          if (toolName === 'execute_terminal_command' || toolName === 'launch_os_app') {
            const cmdToCheck = toolName === 'execute_terminal_command' ? args.command : args.appNameOrPath;
            const list = toolName === 'execute_terminal_command' ? ctx.config.security.allowedCommands : ctx.config.security.allowedApps;
            const isWhitelisted = list.includes(String(cmdToCheck).split(' ')[0]);

            if (!isWhitelisted) {
              const approvalPromise = new Promise<'now' | 'always' | 'deny'>((resolve) => {
                ctx.chatSession.pendingApprovals.push({
                  threadId: ctx.chatSession.threadId,
                  cmd: String(cmdToCheck).split(' ')[0],
                  type: toolName === 'execute_terminal_command' ? 'command' : 'app',
                  resolve
                });
                ctx.render(true);
              });
              
              const choice = await approvalPromise;
              if (choice === 'deny') {
                const toolMsg = new ToolMessage({
                  tool_call_id: toolCallId,
                  content: 'USER DENIED EXECUTION.',
                  name: toolName
                });
                ctx.messages.push(toolMsg);
                ctx.syncMessages();
                continue;
              }
            }
          }
        }

        let result = '';
        try {
          if (toolName === 'execute_terminal_command') {
            result = await executor.executeCommand(args.command, args.background);
          } else {
            // we need to dynamically invoke the tool from our registry
            // for now, we just mock the interface assuming tool.invoke exists
            const { tools } = await import('../tools/registry.js');
            const tool = tools.find(t => t.name === toolName);
            if (tool) {
              result = await (tool as any).invoke(args);
            } else {
              result = `Error: Tool ${toolName} not found.`;
            }
          }
        } catch (e: any) {
          result = `Error: ${e.message}`;
        }

        const toolMsg = new ToolMessage({
          tool_call_id: toolCallId,
          content: typeof result === 'string' ? result : JSON.stringify(result),
          name: toolName
        });
        ctx.messages.push(toolMsg);
        ctx.syncMessages();
      }

      ctx.chatSession.agentStates.set(ctx.chatSession.threadId, 'idle');
      if (ctx.chatSession.isChatActive) ctx.render(true);

      if (!ctx.chatSession.cancelledThreads.has(ctx.chatSession.threadId)) {
        snapshotManager.saveCheckpoint(ctx.chatSession.threadId, ctx.messages.length - 1);
        await this.runAgentLoop(ctx, undefined, depth + 1);
      }
    } else {
      const strippedContent = ctx.stripToolBleed(finalMessage?.content?.toString() || '');
      if (!strippedContent.trim() && finalMessage?.content?.toString().includes('<think>')) {
        // The AI generated a think block but stopped without outputting text or tools
        ctx.messages.push(new HumanMessage('SYSTEM: You stopped generating without executing a tool or saying anything to the user. Proceed with your tool calls or respond to the user.'));
        ctx.syncMessages();
        if (ctx.chatSession.isChatActive) ctx.render(true);
        await this.runAgentLoop(ctx, undefined, depth + 1);
        return;
      }
      
      ctx.chatSession.agentStates.set(ctx.chatSession.threadId, 'idle');
      if (ctx.chatSession.isChatActive) ctx.render(true);
    }
  }
}
