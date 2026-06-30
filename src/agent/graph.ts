import { StateGraph, START, END, Annotation } from "@langchain/langgraph";
import { BaseMessage, HumanMessage, AIMessage, SystemMessage } from "@langchain/core/messages";
import { WorkflowContext } from "./workflow.js";
import { RouterAgent } from "./router.js";
import { AgentMode } from "./agents.js";
import { RequestPipeline } from "./request_pipeline.js";
import { formatSkillsForKnowledgeGraph, getSkillRegistry } from "../skills/loader.js";
import { NodeRunner } from "./node_runner.js";

// We define the state graph annotation
export const GraphState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (x, y) => x.concat(y),
    default: () => [],
  }),
  context: Annotation<WorkflowContext>({
    reducer: (x, y) => y, // Pass context references
    default: () => ({} as WorkflowContext),
  }),
  approvalStatus: Annotation<'pending' | 'approved' | 'rejected' | 'none'>({
    reducer: (x, y) => y,
    default: () => "none",
  }),
  activeAgent: Annotation<AgentMode>({
    reducer: (x, y) => y,
    default: () => "build",
  })
});

// Helper for invoking an agent
async function invokeAgent(
  state: typeof GraphState.State,
  mode: AgentMode,
  systemPromptAddendum?: string
): Promise<BaseMessage> {
  const { messages, context } = state;
  const config = context.config;
  const activeProvider = config.defaults.primaryProvider as string;
  const activeModel = config.providers[activeProvider as keyof typeof config.providers]?.activeModel || 'default';
  
  const finalMsgsToSend = await RequestPipeline.buildPayload(messages, config, activeModel, mode);
  
  if (systemPromptAddendum) {
    finalMsgsToSend.push(new SystemMessage(systemPromptAddendum));
  }
  
  if (mode === 'coder') {
     const registry = getSkillRegistry();
     const skillsInfo = formatSkillsForKnowledgeGraph(registry);
     if (skillsInfo) {
       finalMsgsToSend.push(new SystemMessage(skillsInfo));
     }
  }

  const aiMessage = new AIMessage('');
  context.messages.push(aiMessage);
  
  context.chatSession.agentStates.set(context.chatSession.threadId, `[${mode.toUpperCase()}]`);
  context.chatSession.delayMessage = `${mode.toUpperCase()} Agent is active`;
  context.render(true);

  const runner = new NodeRunner();
  const stream = await context.provider.stream(finalMsgsToSend);
  
  runner.on('stream_chunk', () => context.render());
  runner.on('stream_update', () => context.render(true));

  const { finalMessage } = await runner.consumeStream(
    stream,
    aiMessage,
    context.chatSession.threadId,
    context.chatSession,
    context.stripToolBleed,
    context.parseFallbackToolCalls,
    context.messages
  );

  context.chatSession.delayMessage = null;
  return finalMessage;
}

// Node logic
const routerNode = async (state: typeof GraphState.State) => {
  const decision = await RouterAgent.classify(state.messages, state.context.config, state.context.provider);
  if (decision.classification === 'CHAT' && decision.response) {
    return { messages: [new AIMessage(decision.response)] };
  }
  if (decision.classification === 'SIMPLE_CODE') {
    return { messages: [new SystemMessage("Bypassing architect for simple code task. Routing to Coder.")] };
  }
  return { messages: [] };
};

const architectNode = async (state: typeof GraphState.State) => {
  const msg = await invokeAgent(state, 'plan', "You are the Architect. Output your plan wrapped in <!-- PLAN_START --> and <!-- PLAN_END -->.");
  return { messages: [msg], activeAgent: 'plan' };
};

const plannerReviewNode = async (state: typeof GraphState.State) => {
  const msg = await invokeAgent(state, 'explore', "You are a Senior Staff Code Reviewer. Critique the Architect's plan. If perfect, say 'LGTM'.");
  return { messages: [msg], activeAgent: 'explore' };
};

const approvalNode = async (state: typeof GraphState.State) => {
  const ctx = state.context;
  if (ctx.config.security.mode === 'full' || ctx.config.security.mode === 'approve') {
    ctx.setPendingPlan(false);
    return { approvalStatus: 'approved' as const };
  } else {
    ctx.setPendingPlan(true);
    ctx.setPlanMenuIndex(0);
    ctx.chatSession.agentStates.set(ctx.chatSession.threadId, 'idle');
    ctx.render(true);
    return { approvalStatus: 'pending' as const };
  }
};

const taskerNode = async (state: typeof GraphState.State) => {
  const msg = await invokeAgent(state, 'tasker', "Divide the approved plan into actionable, sequential tasks.");
  return { messages: [msg], activeAgent: 'tasker' };
};

const taskerReviewNode = async (state: typeof GraphState.State) => {
  const msg = await invokeAgent(state, 'explore', "Review the Tasker's breakdown. If flawless, output 'LGTM'.");
  return { messages: [msg], activeAgent: 'explore' };
};

const coderNode = async (state: typeof GraphState.State) => {
  const msg = await invokeAgent(state, 'coder', "You are the Coding Agent. Execute the sequence of tasks.");
  return { messages: [msg], activeAgent: 'coder' };
};

const answerNode = async (state: typeof GraphState.State) => {
  return { messages: [new AIMessage("All steps completed.")] };
};

export function buildAgentGraph() {
  const graph = new StateGraph(GraphState)
    .addNode("router", routerNode)
    .addNode("architect", architectNode)
    .addNode("plannerReview", plannerReviewNode)
    .addNode("approval", approvalNode)
    .addNode("tasker", taskerNode)
    .addNode("taskerReview", taskerReviewNode)
    .addNode("coder", coderNode)
    .addNode("answer", answerNode)
    .addNode("tools", async (state) => {
       const msg = state.messages[state.messages.length - 1];
       const toolCalls = msg.additional_kwargs?.tool_calls || (msg as any).tool_calls || [];
       const ctx = state.context;
       
       ctx.chatSession.agentStates.set(ctx.chatSession.threadId, 'tools');
       ctx.render(true);

       const toolMsgs = [];
       for (const call of toolCalls) {
           if (ctx.chatSession.cancelledThreads.has(ctx.chatSession.threadId)) {
             break;
           }

           const toolName = call.name;
           const args = call.args;

           if (ctx.config.security.mode === 'ask') {
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
                   toolMsgs.push({
                     role: 'tool',
                     tool_call_id: call.id,
                     name: toolName,
                     content: 'USER DENIED EXECUTION.'
                   } as any);
                   continue;
                 }
               }
             }
           }

           const { tools } = await import('../tools/registry.js');
           const tool = tools.find(t => t.name === toolName);
           let result = '';
           try {
             if (tool) {
                result = await (tool as any).invoke(args);
             } else {
                result = `Error: Tool ${toolName} not found.`;
             }
           } catch (e: any) {
             result = `Error: ${e.message}`;
           }
           toolMsgs.push({
             role: 'tool',
             tool_call_id: call.id,
             name: toolName,
             content: typeof result === 'string' ? result : JSON.stringify(result)
           } as any);
       }
       return { messages: toolMsgs };
    })
    
    // Edges
    .addEdge(START, "router")
    
    // Conditional routing
    .addConditionalEdges("router", 
      (state) => {
        const lastMsg = state.messages[state.messages.length - 1];
        if (lastMsg && lastMsg.content && lastMsg._getType() === 'ai') return "answer";
        if (lastMsg && lastMsg.content && String(lastMsg.content).includes('PLAN APPROVED')) return "tasker";
        if (lastMsg && lastMsg.content && String(lastMsg.content).includes('Bypassing architect')) return "coder";
        return "architect";
      },
      {
        answer: "answer",
        coder: "coder",
        tasker: "tasker",
        architect: "architect"
      }
    )
    
    .addEdge("architect", "plannerReview")
    
    .addConditionalEdges("plannerReview",
      (state) => {
        const text = state.messages[state.messages.length - 1].content.toString();
        if (text.includes("LGTM")) return "approval";
        return "architect";
      },
      {
        approval: "approval",
        architect: "architect"
      }
    )
    
    .addConditionalEdges("approval",
      (state) => state.approvalStatus,
      {
        approved: "tasker",
        pending: "__end__",
        rejected: "__end__",
        none: "__end__"
      }
    )
    
    .addEdge("tasker", "taskerReview")
    
    .addConditionalEdges("taskerReview",
      (state) => {
        const text = state.messages[state.messages.length - 1].content.toString();
        if (text.includes("LGTM")) return "coder";
        return "tasker";
      },
      {
        coder: "coder",
        tasker: "tasker"
      }
    )
    
    .addConditionalEdges("coder",
      (state) => {
        const msg = state.messages[state.messages.length - 1];
        if (msg.additional_kwargs?.tool_calls?.length || (msg as any).tool_calls?.length) {
          return "tools";
        }
        return "answer";
      },
      {
        tools: "tools",
        answer: "answer"
      }
    )
    .addConditionalEdges("tools", 
       (state) => state.activeAgent, 
       {
         coder: "coder",
         plan: "architect",
         explore: "plannerReview",
         tasker: "tasker",
         build: "coder"
       }
    )
    
    .addEdge("answer", END);

  return graph.compile();
}
