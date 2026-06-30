import { concat } from '@langchain/core/utils/stream';

// We need to move stripToolBleed and parseFallbackToolCalls from index.tsx 
// into a dedicated parser utility, or we can include them here.
// Let's create an event emitter to notify the UI.
import { EventEmitter } from 'events';

export class NodeRunner extends EventEmitter {
  public async consumeStream(
    stream: AsyncGenerator<any, void, unknown>,
    aiMessage: any,
    currentThreadId: string,
    chatSession: any,
    stripToolBleed: (text: string) => string,
    parseFallbackToolCalls: (text: string, messages?: any[]) => any[] | null,
    messages: any[]
  ) {
    let finalMessage: any = null;
    let isDone = false;
    let lastRenderTime = 0;

    for await (const chunk of stream) {
      if (chatSession.cancelledThreads.has(currentThreadId)) {
        isDone = true;
        aiMessage.content += '\n\n[Streaming terminated by user]';
        if (finalMessage) {
          finalMessage.content = aiMessage.content;
        }
        break;
      }
      if (!finalMessage) finalMessage = chunk;
      else finalMessage = concat(finalMessage, chunk);
      
      if (chunk) {
        const reasoning = finalMessage.additional_kwargs?.reasoning_content;
        if (reasoning || finalMessage.content) {
          if (chatSession.agentStates.get(currentThreadId) === 'thinking') {
            chatSession.agentStates.set(currentThreadId, 'idle');
            this.emit('stream_update');
          }
        }
        
        let content = '';
        if (reasoning) {
          content += `<think>\n${reasoning}`;
          if (finalMessage.content) {
            content += '\n</think>\n';
          }
        }
        content += finalMessage.content;
        aiMessage.content = stripToolBleed(content);

        if (finalMessage && finalMessage.tool_calls && finalMessage.tool_calls.length > 0) {
          aiMessage.tool_calls = finalMessage.tool_calls;
          chatSession.agentStates.set(currentThreadId, 'tools');
          this.emit('stream_update');
        }
        
        const now = Date.now();
        if (now - lastRenderTime > 50) {
          this.emit('stream_chunk');
          lastRenderTime = now;
        }
      }
    }
    
    // Ensure the final chunk renders
    this.emit('stream_chunk');

    if (isDone) return { finalMessage, isDone: true };

    let finalContent = '';
    const reasoning = finalMessage?.additional_kwargs?.reasoning_content;
    if (reasoning) {
      finalContent += `<think>\n${reasoning}\n</think>\n`;
    }
    finalContent += finalMessage?.content ?? '';
    
    if (finalMessage) {
      finalMessage.content = finalContent;
    }
    
    let hasToolCalls = finalMessage?.tool_calls && finalMessage.tool_calls.length > 0;
    if (!hasToolCalls && finalMessage?.content) {
      const fallbackCalls = parseFallbackToolCalls(finalMessage.content.toString(), messages);
      if (fallbackCalls && fallbackCalls.length > 0) {
        finalMessage.tool_calls = fallbackCalls;
        aiMessage.tool_calls = fallbackCalls;
        hasToolCalls = true;
      }
    }
    
    if (finalMessage?.content) {
      aiMessage.content = stripToolBleed(finalMessage.content.toString());
    }

    return { finalMessage, isDone: false, hasToolCalls };
  }
}
