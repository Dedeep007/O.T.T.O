import { AIMessage, BaseMessage } from '@langchain/core/messages';

export type StepClassification =
  | { type: 'final'; hasContent: boolean }
  | { type: 'tools'; count: number }
  | { type: 'think-only' }
  | { type: 'empty' }
  | { type: 'native-generation-error' }
  | { type: 'cancelled' };

export function classifyAssistantStep(
  finalMessage: AIMessage | any,
  isCancelled: boolean,
  stripToolBleed: (text: string) => string
): StepClassification {
  if (isCancelled) {
    return { type: 'cancelled' };
  }

  if (!finalMessage) {
    return { type: 'empty' };
  }

  const hasToolCalls = finalMessage.tool_calls && finalMessage.tool_calls.length > 0;
  
  if (hasToolCalls) {
    return { type: 'tools', count: finalMessage.tool_calls.length };
  }

  const rawContent = finalMessage.content?.toString() || '';
  const strippedContent = stripToolBleed(rawContent);

  if (strippedContent.includes('failed_generation') && strippedContent.includes('Failed to call a function')) {
    return { type: 'native-generation-error' };
  }

  const hasThinkBlock = rawContent.includes('<think>');
  const hasTextOutput = strippedContent.trim().length > 0;

  if (hasThinkBlock && !hasTextOutput) {
    return { type: 'think-only' };
  }

  if (!hasTextOutput) {
    return { type: 'empty' };
  }

  return { type: 'final', hasContent: hasTextOutput };
}
