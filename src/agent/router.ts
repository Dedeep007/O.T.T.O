import { BaseMessage, HumanMessage, SystemMessage, AIMessage } from '@langchain/core/messages';
import { ProviderRegistry } from '../providers/registry.js';
import { OttoConfig } from '../cli/configurator.js';

export interface RouterResult {
  classification: 'CHAT' | 'SIMPLE_CODE' | 'COMPLEX_CODE';
  response?: string;
}

const ROUTER_SYSTEM_PROMPT = `You are a high-speed routing agent for O.T.T.O, an AI coding assistant.
Your job is to read the user's latest message (and the recent conversation context) and determine how it should be handled.

CLASSIFICATION RULES:
1. CHAT: The user is saying "hi", "thank you", or asking a trivial conversational question (e.g. "what is the capital of France?"). You can answer this immediately without ANY tools or deep reasoning.
2. SIMPLE_CODE: The user is asking to make a minor edit to a single file, fix a typo, run a specific command, or debug a small issue. This does NOT require extensive architectural planning.
3. COMPLEX_CODE: The user is asking to build a new feature, create multiple files, refactor architecture, or solve a complex problem that requires a detailed step-by-step plan.

OUTPUT FORMAT:
You MUST output ONLY a raw JSON object and nothing else. No markdown formatting, no backticks, no extra text.
Format:
{
  "classification": "CHAT" | "SIMPLE_CODE" | "COMPLEX_CODE",
  "response": "Hello! How can I help you?" // ONLY provide a response if classification is CHAT.
}
`;

export class RouterAgent {
  static async classify(
    messages: BaseMessage[],
    config: OttoConfig,
    provider: ProviderRegistry
  ): Promise<RouterResult> {
    // If the last message is a slash command (e.g. /analyze-code, /plan, /goal), it's ALWAYS complex code routing.
    const lastMsg = messages[messages.length - 1];
    if (lastMsg && lastMsg.content.toString().trim().startsWith('/')) {
      return { classification: 'COMPLEX_CODE' };
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
      
      if (result.classification === 'CHAT' && result.response) {
        return result;
      }
      return result;
      
    } catch (e) {
      // If parsing fails or any error occurs, default to COMPLEX_CODE to safely pass it to the main agent loop.
      return { classification: 'COMPLEX_CODE' };
    }
  }
}
