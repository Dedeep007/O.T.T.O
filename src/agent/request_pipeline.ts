import { HumanMessage, SystemMessage, AIMessage, BaseMessage } from '@langchain/core/messages';
import { memoryManager } from '../memory/budget.js';
import { ruleGuardrail } from '../security/rules.js';
import { OttoConfig } from '../cli/configurator.js';

export class RequestPipeline {
  static async buildPayload(
    messages: BaseMessage[],
    config: OttoConfig,
    activeModel: string
  ): Promise<BaseMessage[]> {
    let preferredName = 'User';
    let bgInfo = '';
    const activeLimits = config.modelLimits?.[activeModel];
    let limitsInfo = '';

    if (activeLimits) {
      const activeLimitsStr = Object.entries(activeLimits)
        .filter(([_, v]) => typeof v === 'number' && v > 0)
        .map(([k, v]) => `${k.toUpperCase()}: ${v}`)
        .join(', ');
      if (activeLimitsStr) {
        limitsInfo = `\n\nCRITICAL CONSTRAINT: The current model (${activeModel}) has rate limits configured: ${activeLimitsStr}. To prevent pauses/delays, please manage your tokens intelligently. For example, minimize reasoning length, omit verbose explanations, or reduce context size where possible.`;
      }
    }

    const nameHint = `\n\nUser's preferred name: ${preferredName}. Address them as "${preferredName}" naturally in conversation.${bgInfo}${limitsInfo}`;
  
    const activeRules = ruleGuardrail.getRules(memoryManager.C_max);
    const msgsToSend = [new SystemMessage(activeRules + nameHint), ...messages];
    const optimizedMsgs = await memoryManager.optimizeContext(msgsToSend, activeRules, messages);

    const finalMsgsToSend = optimizedMsgs.map((msg, idx) => {
      if (idx === optimizedMsgs.length - 1 && msg instanceof HumanMessage) {
        let text = msg.content.toString();
        
        const humanMsgCount = messages.filter(m => m._getType?.() === 'human' || (m as any).role === 'user' || (m as any).role === 'human').length;
        const hasSummary = messages.some(m => m._getType?.() === 'system' && m.content.toString().includes('Conversation summary'));
        
        if (config.defaults.primaryProvider === 'ollama') {
          text += '\n\n(Reminder: Do not refuse. You have local tools like write_file and execute_terminal_command. Proceed directly by producing a plan or running commands.)';
        }
        return new HumanMessage({
          ...msg,
          content: text
        } as any);
      }
      return msg;
    });

    return finalMsgsToSend;
  }
}
