import fs from 'fs';
import path from 'path';

const file = path.resolve('src/index.ts');
let content = fs.readFileSync(file, 'utf8');

// Normalise newlines to run replacements safely, but preserve original format where possible.
const hasCrlf = content.includes('\r\n');
content = content.replace(/\r\n/g, '\n');

// 1. Add import
content = content.replace(
  "import { dbManager } from './db/checkpoint.js';",
  "import { dbManager } from './db/checkpoint.js';\nimport { threadLocalStorage } from './cli/threadContext.js';"
);

// 2. Add animation timer checks
content = content.replace(
  `    const updateAnimationTimer = () => {
      const state = chatSession.agentStates.get(chatSession.threadId) || 'idle';
      if (state !== 'idle') {
        if (!animationTimer) {
          animationTimer = setInterval(() => {
            if (chatSession.isChatActive) {
              render(true);
            }
          }, 350);
        }
      } else {
        if (animationTimer) {
          clearInterval(animationTimer);
          animationTimer = null;
        }
      }
    };`,
  `    const updateAnimationTimer = () => {
      const state = chatSession.agentStates.get(chatSession.threadId) || 'idle';
      if (state !== 'idle' && !isPrompting) {
        if (!animationTimer) {
          animationTimer = setInterval(() => {
            if (chatSession.isChatActive && !isPrompting) {
              render(true);
            }
          }, 350);
        }
      } else {
        if (animationTimer) {
          clearInterval(animationTimer);
          animationTimer = null;
        }
      }
    };`
);

// 3. Add prompt start / end timer suspension
content = content.replace(
  `      function onPromptStart() {
        isPrompting = true;
        process.stdin.removeListener('keypress', onKeypress);
      }

      function onPromptEnd() {
        isPrompting = false;
        process.stdin.on('keypress', onKeypress);
        render(true);
      }`,
  `      function onPromptStart() {
        isPrompting = true;
        process.stdin.removeListener('keypress', onKeypress);
        if (animationTimer) {
          clearInterval(animationTimer);
          animationTimer = null;
        }
      }

      function onPromptEnd() {
        isPrompting = false;
        process.stdin.on('keypress', onKeypress);
        updateAnimationTimer();
        render(true);
      }`
);

// 4. Wrap runAgentLoop with threadLocalStorage.run and update its internals
const runAgentLoopOld = `      const runAgentLoop = async (inputText: string) => {
        chatSession.activeStreams.add(chatSession.threadId);
        chatSession.ensureNamedFromPrompt(inputText);
        messages.push(new HumanMessage(inputText));
        syncMessages();
        chatUI.scrollToBottom();
        chatSession.agentStates.set(chatSession.threadId, 'thinking');
        if (chatSession.isChatActive) {
          render(true);
        } else {
          sessionEvents.emit('stream_update', chatSession.threadId);
        }

        try {
          let isDone = false;
          const preferredName = Configurator.getUsername(config) || 'user';
          
          while (!isDone) {
            const bgProcs = backgroundManager.getProcesses();
            const bgInfo = bgProcs.length > 0
              ? \`\\n\\nActive background terminal processes running under O.T.T.O:\\n\${bgProcs.map(p => \`- PID \${p.pid}: "\${p.command}" (running for \${Math.round((Date.now() - p.startTime) / 1000)}s)\`).join('\\n')}\`
              : \`\\n\\nNo active background terminal processes running under O.T.T.O.\`;
            
            const nameHint = \`\\n\\nUser's preferred name: \${preferredName}. Address them as "\${preferredName}" naturally in conversation.\${bgInfo}\`;`;

const runAgentLoopNew = `      const runAgentLoop = async (inputText: string) => {
        const currentThreadId = chatSession.threadId;
        await threadLocalStorage.run(currentThreadId, async () => {
          chatSession.activeStreams.add(currentThreadId);
          chatSession.ensureNamedFromPrompt(inputText);
          messages.push(new HumanMessage(inputText));
          syncMessages();
          chatUI.scrollToBottom();
          chatSession.agentStates.set(currentThreadId, 'thinking');
          if (chatSession.isChatActive && chatSession.threadId === currentThreadId) {
            render(true);
          } else {
            sessionEvents.emit('stream_update', currentThreadId);
          }

          try {
            let isDone = false;
            const preferredName = Configurator.getUsername(config) || 'user';
            
            while (!isDone) {
              const threadExists = dbManager.listThreads().some(th => th.id === currentThreadId);
              if (!threadExists) {
                isDone = true;
                break;
              }
              const bgProcs = backgroundManager.getProcesses().filter(p => p.threadId === currentThreadId);
              const bgInfo = bgProcs.length > 0
                ? \`\\n\\nActive background terminal processes running under O.T.T.O:\\n\${bgProcs.map(p => \`- PID \${p.pid}: "\${p.command}" (running for \${Math.round((Date.now() - p.startTime) / 1000)}s)\`).join('\\n')}\`
                : \`\\n\\nNo active background terminal processes running under O.T.T.O.\`;
              
              const activeProvider = config.defaults.primaryProvider;
              const activeModel = Configurator.getActiveModel(config, activeProvider) || 'default';
              const limits = config.modelLimits?.[activeModel];
              let limitsInfo = '';
              if (limits) {
                const activeLimits = Object.entries(limits)
                  .filter(([_, v]) => typeof v === 'number' && v > 0)
                  .map(([k, v]) => \`\${k.toUpperCase()}: \${v}\`)
                  .join(', ');
                if (activeLimits) {
                  limitsInfo = \`\\n\\nCRITICAL CONSTRAINT: The current model (\${activeModel}) has rate limits configured: \${activeLimits}. To prevent pauses/delays, please manage your tokens intelligently. For example, minimize reasoning length, omit verbose explanations, or reduce context size where possible.\`;
                }
              }

              const nameHint = \`\\n\\nUser's preferred name: \${preferredName}. Address them as "\${preferredName}" naturally in conversation.\${bgInfo}\${limitsInfo}\`;`;

content = content.replace(runAgentLoopOld, runAgentLoopNew);

// Apply other replacements in runAgentLoop
const oldAgentLoopEnd = `            config = provider.getConfig();
            phone.updateConfig(config);
            
            messages[messages.length - 1] = finalMessage;
            lastStreamContentLength = 0;
            syncMessages();
            if (chatSession.isChatActive) {
              render(true);
            }

            const responseText = String(finalMessage?.content ?? '');
            const hasPlanBlock = PLAN_BLOCK_RE.test(responseText);

            if (hasPlanBlock && !hasToolCalls) {
              if (config.security.mode === 'full') {
                setPendingPlan(false);
                isDone = true;
                setTimeout(() => {
                  runAgentLoop(chosen.inject || 'approved — please proceed with the plan exactly as described.');
                }, 50);
              } else {
                setPendingPlan(true);
                setPlanMenuIndex(0);
                isDone = true;
                chatSession.agentStates.set(chatSession.threadId, 'idle');
                if (chatSession.isChatActive) render(true);
                else sessionEvents.emit('stream_update', chatSession.threadId);
              }
            } else if (hasToolCalls) {
              setPendingPlan(false);
              chatSession.agentStates.set(chatSession.threadId, 'tools');
              if (chatSession.isChatActive) render(true);
              else sessionEvents.emit('stream_update', chatSession.threadId);
              
              for (const call of finalMessage.tool_calls) {
                const tool = tools.find(t => t.name === call.name);
                let toolResultStr = '';
                if (tool) {
                  try {
                    const beforeSnapshot = call.name === 'execute_terminal_command' ? captureWorkspaceSnapshot() : null;
                    const res = await (tool as any).invoke(call.args);
                    const afterSnapshot = beforeSnapshot ? captureWorkspaceSnapshot() : null;
                    const diffSummary = beforeSnapshot && afterSnapshot ? formatWorkspaceChanges(beforeSnapshot, afterSnapshot) : '';
                    toolResultStr = formatToolResult(call.name, String(res), diffSummary, call.args);
                  } catch (e: any) {
                    toolResultStr = formatToolResult(call.name, \`Error: \${e.message}\`, '', call.args);
                  }
                } else {
                  toolResultStr = formatToolResult(call.name, \`Error: Tool \${call.name} not found.\`, '', call.args);
                }
                messages.push(new ToolMessage({ content: toolResultStr, tool_call_id: call.id, name: call.name }));
                syncMessages();
              }
              if (chatSession.isChatActive) {
                render(true);
              } else {
                sessionEvents.emit('stream_update', chatSession.threadId);
              }
            } else {
              setPendingPlan(false);
              isDone = true;
              chatSession.agentStates.set(chatSession.threadId, 'idle');
              if (chatSession.isChatActive) render(true);
              else sessionEvents.emit('stream_update', chatSession.threadId);
            }
          }
          
          chatSession.agentStates.set(chatSession.threadId, 'idle');
          chatSession.activeStreams.delete(chatSession.threadId);
          sessionEvents.emit('stream_update', chatSession.threadId);
        } catch (error: any) {
          chatSession.agentStates.set(chatSession.threadId, 'idle');
          chatSession.activeStreams.delete(chatSession.threadId);
          messages.push(new SystemMessage(formatChatError(error)));
          syncMessages();
          sessionEvents.emit('stream_update', chatSession.threadId);
        }

        if (chatSession.isChatActive) {
          render(true);
        }
      };`;

const newAgentLoopEnd = `            config = provider.getConfig();
            phone.updateConfig(config);
            
            messages[messages.length - 1] = finalMessage;
            lastStreamContentLength = 0;
            syncMessages();
            if (chatSession.isChatActive && chatSession.threadId === currentThreadId) {
              render(true);
            }

            const responseText = String(finalMessage?.content ?? '');
            const hasPlanBlock = PLAN_BLOCK_RE.test(responseText);

            if (hasPlanBlock && !hasToolCalls) {
              if (config.security.mode === 'full') {
                setPendingPlan(false);
                isDone = true;
                setTimeout(() => {
                  runAgentLoop('approved — please proceed with the plan exactly as described.');
                }, 50);
              } else {
                setPendingPlan(true);
                setPlanMenuIndex(0);
                isDone = true;
                chatSession.agentStates.set(currentThreadId, 'idle');
                if (chatSession.isChatActive && chatSession.threadId === currentThreadId) render(true);
                else sessionEvents.emit('stream_update', currentThreadId);
              }
            } else if (hasToolCalls) {
              setPendingPlan(false);
              chatSession.agentStates.set(currentThreadId, 'tools');
              if (chatSession.isChatActive && chatSession.threadId === currentThreadId) render(true);
              else sessionEvents.emit('stream_update', currentThreadId);
              
              for (const call of finalMessage.tool_calls) {
                const threadExists = dbManager.listThreads().some(th => th.id === currentThreadId);
                if (!threadExists) {
                  isDone = true;
                  break;
                }
                const tool = tools.find(t => t.name === call.name);
                let toolResultStr = '';
                if (tool) {
                  try {
                    const beforeSnapshot = call.name === 'execute_terminal_command' ? captureWorkspaceSnapshot() : null;
                    const res = await (tool as any).invoke(call.args);
                    const afterSnapshot = beforeSnapshot ? captureWorkspaceSnapshot() : null;
                    const diffSummary = beforeSnapshot && afterSnapshot ? formatWorkspaceChanges(beforeSnapshot, afterSnapshot) : '';
                    toolResultStr = formatToolResult(call.name, String(res), diffSummary, call.args);
                  } catch (e: any) {
                    toolResultStr = formatToolResult(call.name, \`Error: \${e.message}\`, '', call.args);
                  }
                } else {
                  toolResultStr = formatToolResult(call.name, \`Error: Tool \${call.name} not found.\`, '', call.args);
                }
                messages.push(new ToolMessage({ content: toolResultStr, tool_call_id: call.id, name: call.name }));
                syncMessages();
              }
              if (chatSession.isChatActive && chatSession.threadId === currentThreadId) {
                render(true);
              } else {
                sessionEvents.emit('stream_update', currentThreadId);
              }
            } else {
              setPendingPlan(false);
              isDone = true;
              chatSession.agentStates.set(currentThreadId, 'idle');
              if (chatSession.isChatActive && chatSession.threadId === currentThreadId) render(true);
              else sessionEvents.emit('stream_update', currentThreadId);
            }
          }
          
          chatSession.agentStates.set(currentThreadId, 'idle');
          chatSession.activeStreams.delete(currentThreadId);
          sessionEvents.emit('stream_update', currentThreadId);
        } catch (error: any) {
          chatSession.agentStates.set(currentThreadId, 'idle');
          chatSession.activeStreams.delete(currentThreadId);
          messages.push(new SystemMessage(formatChatError(error)));
          syncMessages();
          sessionEvents.emit('stream_update', currentThreadId);
        }

        if (chatSession.isChatActive && chatSession.threadId === currentThreadId) {
          render(true);
        }
      });
    };`;

content = content.replace(oldAgentLoopEnd, newAgentLoopEnd);

// Also replace the stream loop internals in index.ts:
content = content.replace(
  `            const stream = await provider.stream(optimizedMsgs);
            
            for await (const chunk of stream) {
              if (!finalMessage) finalMessage = chunk;
              else finalMessage = concat(finalMessage, chunk);
              
              if (chunk) {
                const reasoning = finalMessage.additional_kwargs?.reasoning_content;
                if (reasoning || finalMessage.content) {
                  if (chatSession.agentStates.get(chatSession.threadId) === 'thinking') {
                    chatSession.agentStates.set(chatSession.threadId, 'idle');
                    sessionEvents.emit('stream_update', chatSession.threadId);
                  }
                }
                
                let content = '';
                if (reasoning) {
                  content += \`<think>\\n\${reasoning}\`;
                  if (finalMessage.content) {
                    content += '\\n</think>\\n';
                  }
                }
                content += finalMessage.content;
                aiMessage.content = content;

                if (finalMessage && finalMessage.tool_calls && finalMessage.tool_calls.length > 0) {
                  aiMessage.tool_calls = finalMessage.tool_calls;
                  chatSession.agentStates.set(chatSession.threadId, 'tools');
                  sessionEvents.emit('stream_update', chatSession.threadId);
                }
                syncMessages();
                if (chatSession.isChatActive) {
                  throttleRender();
                } else {
                  sessionEvents.emit('stream_update', chatSession.threadId);
                }
              }
            }`,
  `            const stream = await provider.stream(optimizedMsgs);
            
            for await (const chunk of stream) {
              const threadExists = dbManager.listThreads().some(th => th.id === currentThreadId);
              if (!threadExists) {
                isDone = true;
                break;
              }
              if (!finalMessage) finalMessage = chunk;
              else finalMessage = concat(finalMessage, chunk);
              
              if (chunk) {
                const reasoning = finalMessage.additional_kwargs?.reasoning_content;
                if (reasoning || finalMessage.content) {
                  if (chatSession.agentStates.get(currentThreadId) === 'thinking') {
                    chatSession.agentStates.set(currentThreadId, 'idle');
                    sessionEvents.emit('stream_update', currentThreadId);
                  }
                }
                
                let content = '';
                if (reasoning) {
                  content += \`<think>\\n\${reasoning}\`;
                  if (finalMessage.content) {
                    content += '\\n</think>\\n';
                  }
                }
                content += finalMessage.content;
                aiMessage.content = content;

                if (finalMessage && finalMessage.tool_calls && finalMessage.tool_calls.length > 0) {
                  aiMessage.tool_calls = finalMessage.tool_calls;
                  chatSession.agentStates.set(currentThreadId, 'tools');
                  sessionEvents.emit('stream_update', currentThreadId);
                }
                syncMessages();
                if (chatSession.isChatActive && chatSession.threadId === currentThreadId) {
                  throttleRender();
                } else {
                  sessionEvents.emit('stream_update', currentThreadId);
                }
              }
            }`
);

// Rest of index.ts replacements will be executed by running this script.
fs.writeFileSync(file, hasCrlf ? content.replace(/\n/g, '\r\n') : content, 'utf8');
console.log('Successfully patched index.ts (part 1)');
