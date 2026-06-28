import { BaseMessage, HumanMessage, SystemMessage, AIMessage } from '@langchain/core/messages';
import { ProviderRegistry } from '../providers/registry.js';
import { OttoConfig } from '../cli/configurator.js';

export interface RouterResult {
  classification: 'SIMPLE' | 'COMPLEX';
  response?: string;
}

const ROUTER_SYSTEM_PROMPT = `You are a high-speed routing agent for O.T.T.O, an AI coding assistant.
Your job is to read the user's latest message (and the recent conversation context) and determine if it requires a complex execution (using tools, writing code, reading files) or if it's a simple query/greeting that you can answer instantly.

CLASSIFICATION RULES:
1. SIMPLE: The user is saying "hi", "thank you", or asking a trivial conversational question (e.g. "what is the capital of France?"). You can answer this immediately without ANY tools or deep reasoning.
2. COMPLEX: The user is asking to build something, edit a file, run a command, search the codebase, explain architecture, or perform ANY task that requires checking the project state or writing code.

OUTPUT FORMAT:
You MUST output ONLY a raw JSON object and nothing else. No markdown formatting, no backticks, no extra text.
Format:
{
  "classification": "SIMPLE" | "COMPLEX",
  "response": "Hello! How can I help you?" // ONLY provide a response if classification is SIMPLE.
}
`;

export class RouterAgent {
  static async classify(
    messages: BaseMessage[],
    config: OttoConfig,
    provider: ProviderRegistry
  ): Promise<RouterResult> {
    // If the last message is a slash command (e.g. /analyze-code, /plan, /goal), it's ALWAYS complex.
    const lastMsg = messages[messages.length - 1];
    if (lastMsg && lastMsg.content.toString().trim().startsWith('/')) {
      return { classification: 'COMPLEX' };
    }

    try {
      // Build a lightweight context window (last 5 messages max)
      const contextMsgs = messages.slice(-5).map(msg => {
        // Strip out large tool outputs from context to keep it fast and cheap
        if (msg._getType?.() === 'tool' || (msg as any).role === 'tool') {
          return new SystemMessage('Tool execution output omitted for brevity.');
        }
        return msg;
      });

      const payload = [
        new SystemMessage(ROUTER_SYSTEM_PROMPT),
        ...contextMsgs
      ];

      const activeProvider = config.defaults.primaryProvider as string;
      const activeModel = config.providers[activeProvider as keyof typeof config.providers]?.activeModel || 'default';

      // Use a non-streaming invocation for the router.
      const resultMsg = await provider.invoke(payload);
      
      const rawText = resultMsg.content.toString().trim();
      
      // Clean up markdown block if the model accidentally included it
      const cleanedText = rawText.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
      
      const result = JSON.parse(cleanedText) as RouterResult;
      
      if (result.classification === 'SIMPLE' && result.response) {
        return result;
      }
      return { classification: 'COMPLEX' };
      
    } catch (e) {
      // If parsing fails or any error occurs, default to COMPLEX to safely pass it to the main agent loop.
      return { classification: 'COMPLEX' };
    }
  }
}
