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

    // Pre-LLM Fast Path via Router Agent
    const lastMsg = ctx.messages[ctx.messages.length - 1];
    if (lastMsg instanceof HumanMessage && !injectPrompt && depth === 0) {
      // Use the router to classify the request complexity
      const routingDecision = await RouterAgent.classify(ctx.messages, ctx.config, ctx.provider);
      
      if (routingDecision.classification === 'SIMPLE' && routingDecision.response) {
        ctx.messages.push(new AIMessage(routingDecision.response));
        ctx.syncMessages();
        ctx.chatSession.agentStates.set(ctx.chatSession.threadId, 'idle');
        if (ctx.chatSession.isChatActive) ctx.render(true);
        return;
      } else {
        // Multi-Agent Workflow: Complex tasks start with the Architect
        ctx.agentMode = 'plan';
        ctx.messages.push(new SystemMessage(`[MULTI-AGENT ORCHESTRATION]
You are the Architect Agent. Break down the user's request into:
1. Plan (high-level approach)
2. Tasks (step-by-step division of labor)
3. Artifacts (files to create/modify)

Output your plan wrapped in <!-- PLAN_START --> and <!-- PLAN_END -->. The Reviewer Agent will critique it before execution.`));
        ctx.syncMessages();
      }
    }

    const mode = ctx.agentMode || 'build';

    const activeProvider = ctx.config.defaults.primaryProvider as string;
    
    // Check global token limit before invoking LLM
    await TokenLimiter.getInstance().checkAndWait(activeProvider, ctx.config, ctx.ui);
    const activeModel = ctx.config.providers[activeProvider as keyof typeof ctx.config.providers]?.activeModel || 'default';
    
    const finalMsgsToSend = await RequestPipeline.buildPayload(ctx.messages, ctx.config, activeModel, mode);

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

    // Track token and request usage approximations globally
    const outTok = Math.ceil(String(finalMessage?.content || '').length / 4);
    const inTok = Math.ceil(JSON.stringify(finalMsgsToSend).length / 4);
    TokenLimiter.getInstance().addUsage(inTok + outTok);

    const stepClass = classifyAssistantStep(
      finalMessage,
      ctx.chatSession.cancelledThreads.has(ctx.chatSession.threadId),
      ctx.stripToolBleed
    );

    if (stepClass.type === 'cancelled') {
      return;
    }

    if (stepClass.type === 'native-generation-error') {
      ctx.messages.push(new HumanMessage('SYSTEM: Your previous tool call failed due to a native API generation error. Please output your tool call as a raw markdown JSON block instead of using the native function calling format.'));
      ctx.syncMessages();
      if (ctx.chatSession.isChatActive) ctx.render(true);
      await this.runAgentLoop(ctx, undefined, depth + 1);
      return;
    }

    if (stepClass.type === 'think-only' || stepClass.type === 'empty') {
      ctx.messages.push(new HumanMessage('SYSTEM: You stopped generating without executing a tool or saying anything to the user. Proceed with your tool calls or respond to the user.'));
      ctx.syncMessages();
      if (ctx.chatSession.isChatActive) ctx.render(true);
      await this.runAgentLoop(ctx, undefined, depth + 1);
      return;
    }

    const responseText = String(finalMessage?.content ?? '');
    const hasPlanBlock = PLAN_BLOCK_RE.test(responseText);

    if (hasPlanBlock && stepClass.type !== 'tools') {
      if (ctx.agentMode === 'plan') {
        // Multi-Agent Debate Phase: Reviewer Critiques the Architect's Plan
        ctx.chatSession.delayMessage = "Reviewer Agent is critiquing the plan";
        ctx.render(true);
        
        const planText = responseText.match(PLAN_BLOCK_RE)?.[0] || responseText;
        const critiqueMsg = await ctx.provider.invoke([
          new SystemMessage("You are a Senior Staff Code Reviewer. Critique the following technical implementation plan. Point out flaws, missing logic, or potential runtime bugs. Be extremely harsh but concise. If it's perfect, say 'LGTM'."),
          new HumanMessage(planText)
        ]);

        ctx.chatSession.delayMessage = null;
        
        ctx.messages.push(new AIMessage(`\n\n[REVIEWER CRITIQUE]:\n${critiqueMsg.content}`));
        ctx.messages.push(new HumanMessage("SYSTEM: You are now the Builder Agent. Refine the plan based on the Reviewer's critique if necessary, divide the tasks, and immediately execute them using tools. Do not output PLAN tags again."));
        ctx.agentMode = 'build';
        ctx.syncMessages();
        
        await this.runAgentLoop(ctx, undefined, depth + 1);
        return;
      }

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

    if (stepClass.type === 'tools' && finalMessage.tool_calls) {
      ctx.chatSession.agentStates.set(ctx.chatSession.threadId, 'tools');
      ctx.render(true);

      const agentRole = AgentRegistry.getAgent(mode);

      for (const call of finalMessage.tool_calls) {
        if (ctx.chatSession.cancelledThreads.has(ctx.chatSession.threadId)) {
          break;
        }

        const toolCallId = call.id;
        const toolName = call.name;
        const args = call.args;

        if (!agentRole.allowedTools.includes('*') && !agentRole.allowedTools.includes(toolName)) {
           const toolMsg = new ToolMessage({
            tool_call_id: toolCallId,
            content: `Error: Tool '${toolName}' is not allowed in ${mode} mode.`,
            name: toolName
          });
          ctx.messages.push(toolMsg);
          ctx.syncMessages();
          continue;
        }

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
            const { tools } = await import('../tools/registry.js');
            const tool = tools.find(t => t.name === toolName);
            if (tool) {
              result = await (tool as any).invoke(args);
            } else {
              result = `Error: Tool ${toolName} not found.`;
            }
          }
          
          // Explicit Tool Validation
          if (toolName === 'execute_terminal_command' && !args.background) {
             if (result.includes('Error:') || result.toLowerCase().includes('failed') || result.toLowerCase().includes('command not found')) {
                result += `\n\n[SYSTEM VALIDATION: The command appears to have failed. Please re-evaluate your approach, check the tool syntax, and retry.]`;
             } else {
                result += `\n\n[SYSTEM VALIDATION: Tool executed successfully.]`;
             }
          }
        } catch (e: any) {
          result = `Error: ${e.message}\n[SYSTEM VALIDATION: A fatal error occurred during tool execution. Fix the arguments and retry.]`;
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
    } else if (stepClass.type === 'final') {
      ctx.chatSession.agentStates.set(ctx.chatSession.threadId, 'idle');
      if (ctx.chatSession.isChatActive) ctx.render(true);
    }
  }
}
