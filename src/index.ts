import { Configurator } from './cli/configurator.js';
import { ui } from './cli/ui.js';
import { chatSession, sessionEvents } from './cli/session.js';
import { ProviderEngine } from './llm/provider.js';
import { executor } from './security/executor.js';
import { memoryManager } from './memory/budget.js';
import { vectorMemory } from './memory/vector.js';
import { ruleGuardrail } from './security/rules.js';
import { backgroundManager } from './security/background.js';
import { osController } from './hardware/os.js';
import { browserAutomation } from './hardware/browser.js';
import { serialBridge } from './hardware/serial.js';
import { dbManager } from './db/checkpoint.js';
import { PhoneOS, PhoneView } from './cli/nav.js';
import { createTaskBoardView } from './cli/views/taskBoard.js';
import { createFileTreeView } from './cli/views/fileTree.js';
import { createGitPanelView } from './cli/views/gitPanel.js';
import { createCommandPaletteView } from './cli/views/commandPalette.js';
import { promptWithEscape } from './cli/prompt.js';
import { captureWorkspaceSnapshot, formatWorkspaceChanges } from './cli/workspaceDiff.js';
import { parseAndExecuteCLI } from './cli/parser.js';
import * as readline from 'readline';

import { SystemMessage, HumanMessage, AIMessage, ToolMessage } from '@langchain/core/messages';
import { concat } from '@langchain/core/utils/stream';
import { tools } from './llm/tools.js';
import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import os from 'os';
async function main() {
  const args = process.argv.slice(2);
  const cliHandled = await parseAndExecuteCLI(args);
  if (cliHandled) {
    process.exit(0);
  }

  ui.clearScreen();
  let config = await Configurator.init();
  const provider = new ProviderEngine(config);
  const rules = ruleGuardrail.getRules();

  const phone = new PhoneOS(config);

  const startChat = async () => {
    // Enter the alternate screen buffer — streaming frames stay completely
    // out of the main scrollback so scrolling up never shows partial renders.
    process.stdout.write('\x1B[?1049h\x1B[H\x1B[J');
    const { ChatUI } = await import('./cli/chat.js');
    const chatUI = new ChatUI();
    const messages = chatSession.getMessages();
    let currentInput = '';
    let thinkingTimer: NodeJS.Timeout | null = null;
    let streamRenderTimer: NodeJS.Timeout | null = null;
    let lastStreamRender = 0;
    let lastStreamContentLength = 0;
    
    // pendingPlan: true when the AI last response contained a plan block and
    // we're waiting for the user's selection before executing any tool calls.
    let pendingPlan = false;
    let planMenuIndex = 0; // 0 = Approve, 1 = Edit/Request changes, 2 = Cancel
    const PLAN_MENU_OPTIONS = [
      { label: '✅  Approve — execute the plan', inject: 'approved — please proceed with the plan exactly as described.' },
      { label: '✏️   Edit — request changes first', inject: null },
      { label: '❌  Cancel — do not proceed', inject: 'cancel — do not proceed with this plan.' },
    ];

    const PLAN_BLOCK_RE = /<!--\s*PLAN_START\s*-->[\s\S]*?<!--\s*PLAN_END\s*-->/;
    // Convert history for rendering
    const getRenderMessages = () => {
      const renderMsgs: any[] = [];
      messages.forEach(m => {
        const messageType = m._getType();
        let content = m.content.toString();
        if (messageType === 'ai' && m.tool_calls && m.tool_calls.length > 0) {
          content += '\n\n- tool call sent';
        }
        
        if (content.trim() || m.tool_calls?.length > 0) {
          renderMsgs.push({
            role: messageType === 'human'
              ? 'user'
              : messageType === 'tool'
                ? 'tool'
                : messageType === 'system'
                  ? 'system'
                  : 'ai',
            content
          });
        }
      });
      return renderMsgs;
    };

    const syncMessages = () => {
      chatSession.setMessages(messages);
    };

    const stopThinkingAnimation = () => {
      if (thinkingTimer) {
        clearInterval(thinkingTimer);
        thinkingTimer = null;
      }
    };

    const flushStreamRender = (isPending = false) => {
      if (streamRenderTimer) {
        clearTimeout(streamRenderTimer);
        streamRenderTimer = null;
      }
      lastStreamRender = Date.now();
      render(false, isPending);
    };

    const scheduleStreamRender = (delay = 160) => {
      const elapsed = Date.now() - lastStreamRender;
      if (elapsed >= delay) {
        flushStreamRender();
        return;
      }
      if (!streamRenderTimer) {
        streamRenderTimer = setTimeout(flushStreamRender, delay - elapsed);
      }
    };

    const startThinkingAnimation = () => {
      if (thinkingTimer) return;
      thinkingTimer = setInterval(() => render(true), 350);
    };

    let diffsExpanded = false;

    const render = (isThinking = false, isPendingPlan = false) => {
      if (isThinking) startThinkingAnimation();
      else stopThinkingAnimation();
      const stats = memoryManager.getBudgetStatsForMessages(messages, rules);
      const prov = config.defaults.primaryProvider;
      const model = Configurator.getActiveModel(config, prov as any) ?? 'default';
      const ramMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
      chatUI.render(getRenderMessages(), currentInput, {
        ctxMax: stats.max,
        ctxUsed: stats.filled,
        ramMB,
        showContextBar: config.defaults.showContextBar !== false
      }, model, isThinking, isPendingPlan || pendingPlan, planMenuIndex, diffsExpanded);
    };

    const formatToolResult = (toolName: string, result: string, diffSummary: string, args: any) => {
      const sections: string[] = [`**${toolName}**`];
      const trimmedResult = result.trim();

      if (toolName === 'write_file' || toolName === 'replace_file_lines') {
        return trimmedResult
          ? `**${toolName}**\n\n${trimmedResult}`
          : `**${toolName}**\n\n_No file changes._`;
      }

      if (toolName === 'execute_terminal_command' && args?.command) {
        const command = String(args.command);
        sections.push(`Command: \`${command.length > 160 ? command.slice(0, 157) + '...' : command}\``);
      }

      sections.push(trimmedResult ? `\`\`\`text\n${trimmedResult.slice(0, 1200)}\n\`\`\`` : '_No terminal output._');

      if (diffSummary) {
        sections.push(diffSummary);
      }

      return sections.join('\n\n');
    };

    const formatChatError = (error: any) => {
      const message = error?.message ?? String(error);
      if (
        error?.status === 429 ||
        error?.response?.status === 429 ||
        error?.code === 'rate_limit_exceeded' ||
        message.toLowerCase().includes('rate limit')
      ) {
        return 'Rate limit reached after trying available API keys/model variants. Add another key in Settings > API Settings, add another model variant, or wait a moment and retry.';
      }
      return `Error: ${message}`;
    };

    return new Promise<void>((resolve) => {
      readline.emitKeypressEvents(process.stdin);
      if (process.stdin.isTTY) process.stdin.setRawMode(true);
      process.stdin.resume(); // ensure stdin is flowing after phone.cleanup() may have paused it

      let isStreaming = chatSession.activeStreams.has(chatSession.threadId);
      let isDetached = false;

      const onStreamUpdate = (id: string) => {
        if (id === chatSession.threadId && !isDetached) {
          if (!chatSession.activeStreams.has(id)) {
            isStreaming = false;
          }
          render(isStreaming);
        }
      };
      sessionEvents.on('stream_update', onStreamUpdate);

      const cleanup = () => {
        sessionEvents.removeListener('stream_update', onStreamUpdate);
        process.stdout.write('\x1B[?1049l');
        process.stdin.removeListener('keypress', onKeypress);
      };

      const onKeypress = async (str: string, key: any) => {
        if (key.ctrl && key.name === 'c') {
          stopThinkingAnimation();
          if (streamRenderTimer) clearTimeout(streamRenderTimer);
          // Exit alternate screen before hard-quitting so the terminal is clean
          process.stdout.write('\x1B[?1049l');
          process.exit(0);
        } else if (key.ctrl && key.name === 'e') {
          diffsExpanded = !diffsExpanded;
          render(isStreaming);
          return;
        } else if (key.name === 'escape') {
          stopThinkingAnimation();
          if (streamRenderTimer) {
            clearTimeout(streamRenderTimer);
            streamRenderTimer = null;
          }
          if (isStreaming) {
            isDetached = true;
          }
          cleanup();
          resolve();
        } else if (key.name === 'return') {
          // ── PLAN MENU SELECTION ───────────────────────────────────────────
          if (pendingPlan) {
            const chosen = PLAN_MENU_OPTIONS[planMenuIndex];
            if (chosen.inject !== null) {
              // Approve or Cancel: inject the canned response as human message
              pendingPlan = false;
              planMenuIndex = 0;
              // Do not remove keypress listener here!
              isStreaming = true;
              isDetached = false;
              chatSession.activeStreams.add(chatSession.threadId);
              messages.push(new HumanMessage(chosen.inject));
              syncMessages();
              chatUI.scrollToBottom();
              render(true);
              try {
                let isDone = false;
                const preferredName = Configurator.getUsername(config) || 'user';
                const nameHint = `\n\nUser's preferred name: ${preferredName}. Address them as "${preferredName}" naturally in conversation.`;
                while (!isDone) {
                  const msgsToSend = [new SystemMessage(rules + nameHint), ...messages];
                  const optimizedMsgs = await memoryManager.optimizeContext(msgsToSend, rules);
                  const aiMessage = new AIMessage('');
                  messages.push(aiMessage);
                  syncMessages();
                  let finalMessage: any = null;
                  const stream = await provider.stream(optimizedMsgs);
                  for await (const chunk of stream) {
                    if (!finalMessage) finalMessage = chunk;
                    else finalMessage = concat(finalMessage, chunk);
                    if (chunk && chunk.content) {
                      aiMessage.content = (aiMessage.content as string) + chunk.content;
                      syncMessages();
                      if (!isDetached) {
                         scheduleStreamRender(160);
                      } else {
                         sessionEvents.emit('stream_update', chatSession.threadId);
                      }
                    }
                  }
                  config = provider.getConfig();
                  phone.updateConfig(config);
                  messages[messages.length - 1] = finalMessage;
                  lastStreamContentLength = 0;
                  syncMessages();
                  const responseText = String(finalMessage?.content ?? '');
                  const hasPlanBlock = PLAN_BLOCK_RE.test(responseText);
                  const hasToolCalls = finalMessage?.tool_calls && finalMessage.tool_calls.length > 0;
                  if (hasPlanBlock && !hasToolCalls) {
                    pendingPlan = true;
                    planMenuIndex = 0;
                    isDone = true;
                    if (!isDetached) flushStreamRender(true);
                  } else if (hasToolCalls) {
                    pendingPlan = false;
                    if (!isDetached) flushStreamRender();
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
                        } catch (e: any) { toolResultStr = formatToolResult(call.name, `Error: ${e.message}`, '', call.args); }
                      } else { toolResultStr = formatToolResult(call.name, `Error: Tool ${call.name} not found.`, '', call.args); }
                      messages.push(new ToolMessage({ content: toolResultStr, tool_call_id: call.id, name: call.name }));
                      syncMessages();
                    }
                    if (!isDetached) {
                      render(true);
                    } else {
                      sessionEvents.emit('stream_update', chatSession.threadId);
                    }
                  } else {
                    pendingPlan = false;
                    isDone = true;
                    if (!isDetached) flushStreamRender();
                  }
                }
                isStreaming = false;
                chatSession.activeStreams.delete(chatSession.threadId);
                sessionEvents.emit('stream_update', chatSession.threadId);
              } catch (error: any) {
                isStreaming = false;
                chatSession.activeStreams.delete(chatSession.threadId);
                messages.push(new SystemMessage(formatChatError(error)));
                syncMessages();
                sessionEvents.emit('stream_update', chatSession.threadId);
              }
              if (!isDetached) {
                 render();
              }
            } else {
              // Edit mode: drop into normal input so user can type modifications
              pendingPlan = false;
              planMenuIndex = 0;
              render();
            }
            return;
          }
          // ── NORMAL MESSAGE SEND ─────────────────────────────────────────────
          if (!currentInput.trim()) return;
          const inputStr = currentInput.trim();
          currentInput = '';
          
          if (inputStr === '/rewind') {
            let lastHumanIdx = -1;
            for (let i = messages.length - 1; i >= 0; i--) {
              if (messages[i]._getType() === 'human') {
                lastHumanIdx = i;
                break;
              }
            }
            if (lastHumanIdx >= 0) {
              messages.splice(lastHumanIdx);
              syncMessages();
            }
            render(false);
            return;
          }
          if (chatSession.activeStreams.has(chatSession.threadId)) {
             // Block multiple streams
             return;
          }

          isStreaming = true;
          isDetached = false;
          chatSession.activeStreams.add(chatSession.threadId);
          chatSession.ensureNamedFromPrompt(inputStr);
          messages.push(new HumanMessage(inputStr));
          syncMessages();
          chatUI.scrollToBottom(); // always show new message being sent
          render(true);

          try {
            let isDone = false;
            const preferredName = Configurator.getUsername(config) || 'user';
            const nameHint = `\n\nUser's preferred name: ${preferredName}. Address them as "${preferredName}" naturally in conversation.`;
            while (!isDone) {
              const msgsToSend = [new SystemMessage(rules + nameHint), ...messages];
              const optimizedMsgs = await memoryManager.optimizeContext(msgsToSend, rules);
              
              const aiMessage = new AIMessage('');
              messages.push(aiMessage);
              syncMessages();
              
              let finalMessage: any = null;
              const stream = await provider.stream(optimizedMsgs);
              
              for await (const chunk of stream) {
                if (!finalMessage) finalMessage = chunk;
                else finalMessage = concat(finalMessage, chunk);
                
                if (chunk && chunk.content) {
                  aiMessage.content = (aiMessage.content as string) + chunk.content;
                  syncMessages();
                  const currentLength = (aiMessage.content as string).length;
                  const delta = currentLength - lastStreamContentLength;
                  const fenceCount = ((aiMessage.content as string).match(/```/g) ?? []).length;
                  const isInsideCodeFence = fenceCount % 2 === 1;
                  const shouldRender =
                    delta >= (isInsideCodeFence ? 96 : 24) ||
                    (!isInsideCodeFence && /[\s,.;:!?)\}\]\n]$/.test(String(chunk.content))) ||
                    currentLength < 24;
                  if (shouldRender) {
                    lastStreamContentLength = currentLength;
                    if (!isDetached) {
                      scheduleStreamRender(isInsideCodeFence ? 260 : 160);
                    } else {
                      sessionEvents.emit('stream_update', chatSession.threadId);
                    }
                  }
                }
              }
              config = provider.getConfig();
              phone.updateConfig(config);
              
              messages[messages.length - 1] = finalMessage;
              lastStreamContentLength = 0;
              syncMessages();

              const responseText = String(finalMessage?.content ?? '');
              const hasPlanBlock = PLAN_BLOCK_RE.test(responseText);
              const hasToolCalls = finalMessage?.tool_calls && finalMessage.tool_calls.length > 0;

              if (hasPlanBlock && !hasToolCalls) {
                pendingPlan = true;
                planMenuIndex = 0;
                isDone = true;
                if (!isDetached) flushStreamRender(true);
              } else if (hasToolCalls) {
                pendingPlan = false;
                if (!isDetached) flushStreamRender();
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
                    } catch (e: any) { toolResultStr = formatToolResult(call.name, `Error: ${e.message}`, '', call.args); }
                  } else { toolResultStr = formatToolResult(call.name, `Error: Tool ${call.name} not found.`, '', call.args); }
                  messages.push(new ToolMessage({ content: toolResultStr, tool_call_id: call.id, name: call.name }));
                  syncMessages();
                }
                if (!isDetached) {
                  render(true);
                } else {
                  sessionEvents.emit('stream_update', chatSession.threadId);
                }
              } else {
                pendingPlan = false;
                isDone = true;
                if (!isDetached) flushStreamRender();
              }
            }
            isStreaming = false;
            chatSession.activeStreams.delete(chatSession.threadId);
            sessionEvents.emit('stream_update', chatSession.threadId);
          } catch (error: any) {
            isStreaming = false;
            chatSession.activeStreams.delete(chatSession.threadId);
            messages.push(new SystemMessage(formatChatError(error)));
            syncMessages();
            sessionEvents.emit('stream_update', chatSession.threadId);
          }
          
          if (!isDetached) {
            render();
          }
        } else if (key.name === 'up') {
          if (pendingPlan) {
            planMenuIndex = (planMenuIndex - 1 + PLAN_MENU_OPTIONS.length) % PLAN_MENU_OPTIONS.length;
          } else {
            chatUI.scrollUp(3);
          }
          render(isStreaming);
        } else if (key.name === 'down') {
          if (pendingPlan) {
            planMenuIndex = (planMenuIndex + 1) % PLAN_MENU_OPTIONS.length;
          } else {
            chatUI.scrollDown(3);
          }
          render(isStreaming);
        } else if (key.name === 'pageup') {
          if (!pendingPlan) chatUI.scrollUp(Math.max(1, Math.floor(((process.stdout.rows || 24) - 1) / 2)));
          render(isStreaming);
        } else if (key.name === 'pagedown') {
          if (!pendingPlan) chatUI.scrollDown(Math.max(1, Math.floor(((process.stdout.rows || 24) - 1) / 2)));
          render(isStreaming);
        } else if (key.name === 'end') {
          if (!pendingPlan) chatUI.scrollToBottom();
          render(isStreaming);
        } else if (key.name === 'backspace') {
          if (isStreaming) return;
          if (!pendingPlan) { currentInput = currentInput.slice(0, -1); render(); }
        } else if (str && !key.ctrl && !key.meta) {
          if (isStreaming) return;
          if (!pendingPlan) { currentInput += str; render(); }
        }
      };

      process.stdin.on('keypress', onKeypress);
      render(isStreaming);
    });
  };

  const createProfileView = (): PhoneView => {
    const currentName = Configurator.getUsername(config) || 'user';
    return {
      id: 'profile',
      title: 'Profile',
      subtitle: 'Personalise how O.T.T.O addresses you',
      renderBody: () => {
        const name = Configurator.getUsername(config) || 'user';
        const isDefault = !config.profile?.username;
        console.log(chalk.white.bold('  Current Username'));
        console.log('  ' + chalk.hex('#56CFE1')(name) + (isDefault ? '  ' + chalk.hex('#6B7280')('(default — not set yet)') : ''));
        console.log('');
        console.log(chalk.hex('#6B7280')('  The agent will address you by this name in every conversation.'));
        console.log('');
      },
      options: [
        {
          label: currentName === 'user' || !config.profile?.username
            ? 'Set Username'
            : `Edit Username  (current: ${currentName})`,
          description: 'Enter the name you want the agent to call you',
          action: async () => {
            phone.active = false;
            ui.clearScreen();
            const entered = await promptWithEscape(
              'Enter your preferred username:',
              Configurator.getUsername(config) || ''
            );
            if (entered !== null && entered.trim()) {
              config = Configurator.updateUsername(entered.trim()) || config;
              phone.updateConfig(config);
              ui.success(`Username set to "${entered.trim()}". O.T.T.O will now call you that!`);
              await new Promise(r => setTimeout(r, 1200));
            }
            phone.active = true;
            phone.goBack();
            phone.pushView(createProfileView());
          }
        },
        {
          label: 'Reset to Default  (user)',
          description: 'Clear the custom username',
          action: async () => {
            config = Configurator.updateUsername('') || config;
            // clear it properly
            if (config.profile) config.profile.username = undefined;
            const raw = Configurator.loadConfig();
            if (raw?.profile) { raw.profile.username = undefined; Configurator.saveConfig(raw); config = raw; }
            phone.updateConfig(config);
            ui.success('Username reset to default.');
            await new Promise(r => setTimeout(r, 900));
            phone.goBack();
            phone.pushView(createProfileView());
          }
        },
        { label: 'Go Back', action: () => phone.goBack() }
      ]
    };
  };

  const createMaxThreadsView = (): PhoneView => {
    const maxT  = Configurator.getMaxThreads(config);
    const cores = require('os').cpus().length;
    const cpuDefault = Math.min(20, Math.max(5, cores * 2));
    return {
      id: 'max_threads',
      title: 'Max Threads',
      subtitle: 'Limit the number of saved sessions',
      renderBody: () => {
        const cur = Configurator.getMaxThreads(config);
        const cnt = dbManager.listThreads().length;
        console.log(chalk.white.bold('  Current Limit'));
        console.log('  ' + chalk.hex('#56CFE1')(String(cur)) + chalk.hex('#6B7280')(`  (${cnt} sessions stored)`));
        console.log('');
        console.log(chalk.hex('#6B7280')(`  CPU-healthy default for this machine: ${cpuDefault}  (${cores} cores × 2, capped at 20)`));
        console.log(chalk.hex('#6B7280')('  Older threads are kept but new ones cannot be created when at the limit.'));
        console.log('');
      },
      options: [
        {
          label: `Increase limit  (currently ${maxT})`,
          description: 'Allow more saved sessions',
          action: async () => {
            phone.active = false;
            ui.clearScreen();
            const entered = await promptWithEscape(`New max threads (current: ${maxT}):`);
            const n = parseInt(entered ?? '', 10);
            if (!isNaN(n) && n > 0) {
              config = Configurator.updateMaxThreads(n) || config;
              phone.updateConfig(config);
              ui.success(`Max threads set to ${n}.`);
              await new Promise(r => setTimeout(r, 900));
            }
            phone.active = true;
            phone.goBack();
            phone.pushView(createMaxThreadsView());
          }
        },
        {
          label: `Decrease limit  (currently ${maxT})`,
          description: 'Keep fewer sessions around',
          action: async () => {
            phone.active = false;
            ui.clearScreen();
            const entered = await promptWithEscape(`New max threads (current: ${maxT}):`);
            const n = parseInt(entered ?? '', 10);
            if (!isNaN(n) && n > 0) {
              config = Configurator.updateMaxThreads(n) || config;
              phone.updateConfig(config);
              ui.success(`Max threads set to ${n}.`);
              await new Promise(r => setTimeout(r, 900));
            }
            phone.active = true;
            phone.goBack();
            phone.pushView(createMaxThreadsView());
          }
        },
        {
          label: `Reset to CPU default  (${cpuDefault})`,
          description: 'Restore the automatically calculated healthy limit',
          action: async () => {
            config = Configurator.updateMaxThreads(cpuDefault) || config;
            phone.updateConfig(config);
            ui.success(`Max threads reset to ${cpuDefault}.`);
            await new Promise(r => setTimeout(r, 900));
            phone.goBack();
            phone.pushView(createMaxThreadsView());
          }
        },
        { label: 'Go Back', action: () => phone.goBack() }
      ]
    };
  };

  const createSettingsView = (): PhoneView => ({
    id: 'settings',
    title: 'Settings & Security',
    subtitle: 'Manage keys, models, security mode, and display',
    options: [
      {
        label: 'Profile',
        description: 'Set the username O.T.T.O uses to address you',
        action: async () => { phone.pushView(createProfileView()); }
      },
      {
        label: `Max Threads  [${Configurator.getMaxThreads(config)}]`,
        description: 'Limit stored sessions to reduce memory pressure',
        action: async () => { phone.pushView(createMaxThreadsView()); }
      },
      {
        label: 'API Settings',
        description: 'Add, select, and rotate provider API keys',
        action: async () => { phone.pushView(createApiEditView()); }
      },
      {
        label: 'Edit Models',
        description: 'Set the model name used for each provider',
        action: async () => { phone.pushView(createModelEditView()); }
      },
      {
        label: 'Edit Ollama Base URL',
        description: 'Set localhost or remote URL for Ollama',
        action: async () => {
          phone.active = false;
          ui.clearScreen();
          const currentUrl = config.providers.ollama?.baseUrl || 'http://localhost:11434';
          const entered = await promptWithEscape(`Enter new Ollama Base URL (current: ${currentUrl}):`);
          if (entered !== null && entered.trim()) {
            config = Configurator.updateOllamaUrl(entered.trim()) || config;
            phone.updateConfig(config);
            ui.success(`Ollama URL updated to ${entered.trim()}`);
            await new Promise(r => setTimeout(r, 900));
          }
          phone.active = true;
          phone.goBack();
          phone.pushView(createSettingsView());
        }
      },
      {
        label: 'Allowed Tools & Commands',
        description: 'Set the execution guardrail policy',
        action: async () => { phone.pushView(createSecurityEditView()); }
      },
      {
        label: `Toggle Context Bar  [${config.defaults.showContextBar !== false ? 'ON' : 'OFF'}]`,
        description: 'Show or hide the context budget indicator',
        action: async () => {
          const current = config.defaults.showContextBar !== false;
          config = Configurator.updateContextBar(!current) || config;
          phone.updateConfig(config);
          phone.render();
        }
      },
      { label: 'Go Back', action: () => phone.goBack() }
    ]
  });


  const createProviderModelView = (
    providerName: 'groq' | 'openai' | 'anthropic' | 'ollama' | 'gemini',
    providerLabel: string,
    defaultModel: string,
    examples: string
  ): PhoneView => {
    const currentModels = Configurator.getModelVariants(config, providerName);
    const activeModel = Configurator.getActiveModel(config, providerName) ?? defaultModel;

    return {
      id: `${providerName}_models`,
      title: `${providerLabel} Models`,
      subtitle: 'Add, select, or remove model variants',
      renderBody: () => {
        console.log(chalk.white.bold('  Active Model'));
        console.log('  ' + chalk.hex('#56CFE1')(activeModel));
        console.log('');
        console.log(chalk.white.bold('  Saved Variants'));
        if (currentModels.length === 0) {
          console.log('  ' + chalk.dim('No saved variants yet.'));
        } else {
          currentModels.forEach(model => {
            const mark = model === activeModel ? chalk.green('*') : chalk.dim('-');
            console.log(`  ${mark} ${chalk.white(model)}`);
          });
        }
        console.log('');
      },
      options: [
        {
          label: 'Add Model Variant',
          description: examples,
          action: async () => {
            phone.active = false;
            ui.clearScreen();
            const m = await promptWithEscape(`${providerLabel} model name:`);
            if (m && m.trim()) {
              config = Configurator.addModelVariant(providerName, m.trim()) || config;
              provider.setConfig(config);
              phone.updateConfig(config);
              ui.success(`Added ${m.trim()}.`);
              await new Promise(r => setTimeout(r, 1000));
            }
            phone.active = true;
            phone.goBack();
            phone.pushView(createProviderModelView(providerName, providerLabel, defaultModel, examples));
          }
        },
        {
          label: 'Select Active Model',
          description: 'Choose which saved model to use',
          action: () => phone.pushView({
            id: `${providerName}_model_select`,
            title: `Select ${providerLabel} Model`,
            options: [
              ...currentModels.map(model => ({
                label: model,
                action: async () => {
                  config = Configurator.setActiveModel(providerName, model) || config;
                  provider.setConfig(config);
                  phone.updateConfig(config);
                  ui.success(`Active ${providerLabel} model set to ${model}`);
                  await new Promise(r => setTimeout(r, 800));
                  phone.goBack();
                  phone.goBack();
                  phone.pushView(createProviderModelView(providerName, providerLabel, defaultModel, examples));
                }
              })),
              { label: 'Go Back', action: () => phone.goBack() }
            ]
          })
        },
        {
          label: 'Remove Model Variant',
          description: 'Delete a saved model from this provider',
          action: () => phone.pushView({
            id: `${providerName}_model_remove`,
            title: `Remove ${providerLabel} Model`,
            options: [
              ...currentModels.map(model => ({
                label: model,
                action: async () => {
                  config = Configurator.removeModelVariant(providerName, model) || config;
                  provider.setConfig(config);
                  phone.updateConfig(config);
                  ui.success(`Removed ${model}`);
                  await new Promise(r => setTimeout(r, 800));
                  phone.goBack();
                  phone.goBack();
                  phone.pushView(createProviderModelView(providerName, providerLabel, defaultModel, examples));
                }
              })),
              { label: 'Go Back', action: () => phone.goBack() }
            ]
          })
        },
        {
          label: 'Edit Model Variant',
          description: 'Rename a saved model without losing the active selection',
          action: () => phone.pushView({
            id: `${providerName}_model_edit_variant`,
            title: `Edit ${providerLabel} Model`,
            options: [
              ...currentModels.map(model => ({
                label: model,
                action: async () => {
                  phone.active = false;
                  ui.clearScreen();
                  const nextName = await promptWithEscape(`Rename ${model} to:`, model);
                  if (nextName && nextName.trim() && nextName.trim() !== model) {
                    config = Configurator.renameModelVariant(providerName, model, nextName.trim()) || config;
                    provider.setConfig(config);
                    phone.updateConfig(config);
                    ui.success(`Renamed ${model} to ${nextName.trim()}`);
                    await new Promise(r => setTimeout(r, 800));
                  }
                  phone.active = true;
                  phone.goBack();
                  phone.goBack();
                  phone.pushView(createProviderModelView(providerName, providerLabel, defaultModel, examples));
                }
              })),
              { label: 'Go Back', action: () => phone.goBack() }
            ]
          })
        },
        { label: 'Go Back', action: () => phone.goBack() }
      ]
    };
  };

  const createModelEditView = (): PhoneView => ({
    id: 'model_edit',
    title: 'Edit Models',
    subtitle: 'Manage multiple model variants per provider',
    options: [
      {
        label: `Groq  ${Configurator.getActiveModel(config, 'groq') ? '-> ' + Configurator.getActiveModel(config, 'groq') : '(default: qwen-qwq-32b)'}`,
        description: 'e.g. qwen-qwq-32b, llama-3.3-70b-versatile, mixtral-8x7b-32768',
        action: async () => phone.pushView(createProviderModelView('groq', 'Groq', 'qwen-qwq-32b', 'e.g. qwen-qwq-32b, llama-3.3-70b-versatile, mixtral-8x7b-32768'))
      },
      {
        label: `OpenAI  ${Configurator.getActiveModel(config, 'openai') ? '-> ' + Configurator.getActiveModel(config, 'openai') : '(default: gpt-4o)'}`,
        description: 'e.g. gpt-4o, gpt-4o-mini, gpt-4-turbo, o1-preview',
        action: async () => phone.pushView(createProviderModelView('openai', 'OpenAI', 'gpt-4o', 'e.g. gpt-4o, gpt-4o-mini, gpt-4-turbo, o1-preview'))
      },
      {
        label: `Anthropic  ${Configurator.getActiveModel(config, 'anthropic') ? '-> ' + Configurator.getActiveModel(config, 'anthropic') : '(default: claude-3-5-sonnet-20241022)'}`,
        description: 'e.g. claude-3-5-sonnet-20241022, claude-3-haiku-20240307',
        action: async () => phone.pushView(createProviderModelView('anthropic', 'Anthropic', 'claude-3-5-sonnet-20241022', 'e.g. claude-3-5-sonnet-20241022, claude-3-haiku-20240307'))
      },
      {
        label: `Gemini  ${Configurator.getActiveModel(config, 'gemini') ? '-> ' + Configurator.getActiveModel(config, 'gemini') : '(default: gemini-1.5-pro)'}`,
        description: 'e.g. gemini-1.5-pro, gemini-1.5-flash',
        action: async () => phone.pushView(createProviderModelView('gemini', 'Gemini', 'gemini-1.5-pro', 'e.g. gemini-1.5-pro, gemini-1.5-flash'))
      },
      {
        label: `Ollama  ${Configurator.getActiveModel(config, 'ollama') ? '-> ' + Configurator.getActiveModel(config, 'ollama') : '(default: llama3)'}`,
        description: 'e.g. llama3, mistral, phi3',
        action: async () => phone.pushView(createProviderModelView('ollama', 'Ollama', 'llama3', 'e.g. llama3, mistral, phi3'))
      },
    ]
  });

  const maskApiKey = (key: string) => {
    if (!key) return '(empty)';
    if (key.length <= 10) return key.slice(0, 2) + '...' + key.slice(-2);
    return key.slice(0, 6) + '...' + key.slice(-4);
  };

  const createProviderApiKeyView = (
    providerName: 'groq' | 'openai' | 'anthropic' | 'gemini',
    providerLabel: string
  ): PhoneView => {
    const apiKeys = Configurator.getApiKeys(config, providerName);
    const activeKey = Configurator.getActiveApiKey(config, providerName);

    return {
      id: `${providerName}_api_keys`,
      title: `${providerLabel} API Keys`,
      subtitle: 'Add, select, or remove keys used for automatic rotation',
      renderBody: () => {
        console.log(chalk.white.bold('  Active Key'));
        console.log('  ' + chalk.hex('#56CFE1')(activeKey ? maskApiKey(activeKey) : '(none)'));
        console.log('');
        console.log(chalk.white.bold('  Saved Keys'));
        if (apiKeys.length === 0) {
          console.log('  ' + chalk.dim('No saved keys yet.'));
        } else {
          apiKeys.forEach(key => {
            const mark = key === activeKey ? chalk.green('*') : chalk.dim('-');
            console.log(`  ${mark} ${chalk.white(maskApiKey(key))}`);
          });
        }
        console.log('');
      },
      options: [
        {
          label: 'Add API Key',
          description: 'Save another key for this provider',
          action: async () => {
            phone.active = false;
            ui.clearScreen();
            const newKey = await promptWithEscape(`Enter API Key for ${providerLabel}:`);
            if (newKey && newKey.trim()) {
              config = Configurator.addApiKey(providerName, newKey.trim()) || config;
              provider.setConfig(config);
              phone.updateConfig(config);
              ui.success('Saved API key.');
              await new Promise(r => setTimeout(r, 800));
            }
            phone.active = true;
            phone.goBack();
            phone.pushView(createProviderApiKeyView(providerName, providerLabel));
          }
        },
        {
          label: 'Select Active Key',
          description: 'Choose which key is used first',
          action: () => phone.pushView({
            id: `${providerName}_api_key_select`,
            title: `Select ${providerLabel} Key`,
            options: [
              ...apiKeys.map(key => ({
                label: `${key === activeKey ? '* ' : ''}${maskApiKey(key)}`,
                action: async () => {
                  config = Configurator.setActiveApiKey(providerName, key) || config;
                  provider.setConfig(config);
                  phone.updateConfig(config);
                  ui.success(`Active ${providerLabel} key updated.`);
                  await new Promise(r => setTimeout(r, 800));
                  phone.goBack();
                  phone.goBack();
                  phone.pushView(createProviderApiKeyView(providerName, providerLabel));
                }
              })),
              { label: 'Go Back', action: () => phone.goBack() }
            ]
          })
        },
        {
          label: 'Remove API Key',
          description: 'Delete a saved key from rotation',
          action: () => phone.pushView({
            id: `${providerName}_api_key_remove`,
            title: `Remove ${providerLabel} Key`,
            options: [
              ...apiKeys.map(key => ({
                label: `${key === activeKey ? '* ' : ''}${maskApiKey(key)}`,
                action: async () => {
                  config = Configurator.removeApiKey(providerName, key) || config;
                  provider.setConfig(config);
                  phone.updateConfig(config);
                  ui.success(`Removed ${providerLabel} key.`);
                  await new Promise(r => setTimeout(r, 800));
                  phone.goBack();
                  phone.goBack();
                  phone.pushView(createProviderApiKeyView(providerName, providerLabel));
                }
              })),
              { label: 'Go Back', action: () => phone.goBack() }
            ]
          })
        },
        { label: 'Go Back', action: () => phone.goBack() }
      ]
    };
  };

  const createApiEditView = (): PhoneView => ({
    id: 'api_keys',
    title: 'API Settings',
    subtitle: 'Manage multiple API keys per provider',
    options: [
      {
        label: `Groq  ${Configurator.getApiKeys(config, 'groq').length} key(s)`,
        description: Configurator.getActiveApiKey(config, 'groq') ? `active: ${maskApiKey(Configurator.getActiveApiKey(config, 'groq')!)}` : 'no key',
        action: async () => phone.pushView(createProviderApiKeyView('groq', 'Groq'))
      },
      {
        label: `OpenAI  ${Configurator.getApiKeys(config, 'openai').length} key(s)`,
        description: Configurator.getActiveApiKey(config, 'openai') ? `active: ${maskApiKey(Configurator.getActiveApiKey(config, 'openai')!)}` : 'no key',
        action: async () => phone.pushView(createProviderApiKeyView('openai', 'OpenAI'))
      },
      {
        label: `Anthropic  ${Configurator.getApiKeys(config, 'anthropic').length} key(s)`,
        description: Configurator.getActiveApiKey(config, 'anthropic') ? `active: ${maskApiKey(Configurator.getActiveApiKey(config, 'anthropic')!)}` : 'no key',
        action: async () => phone.pushView(createProviderApiKeyView('anthropic', 'Anthropic'))
      },
      {
        label: `Gemini  ${Configurator.getApiKeys(config, 'gemini').length} key(s)`,
        description: Configurator.getActiveApiKey(config, 'gemini') ? `active: ${maskApiKey(Configurator.getActiveApiKey(config, 'gemini')!)}` : 'no key',
        action: async () => phone.pushView(createProviderApiKeyView('gemini', 'Gemini'))
      },
      { label: 'Go Back', action: () => phone.goBack() }
    ]
  });

  const createWhitelistRemoveView = (): PhoneView => ({
    id: 'security_whitelist_remove',
    title: 'Remove Whitelisted Command',
    subtitle: 'Select a command to remove from the whitelist',
    options: [
      ...config.security.allowedCommands.map(cmd => ({
        label: cmd,
        action: async () => {
          config = Configurator.updateAllowedCommands(
            config.security.allowedCommands.filter(current => current !== cmd)
          ) || config;
          phone.updateConfig(config);
          ui.success(`Removed ${cmd} from whitelist.`);
          await new Promise(r => setTimeout(r, 800));
          phone.goBack();
          phone.goBack();
          phone.pushView(createSecurityEditView());
        }
      })),
      { label: 'Go Back', action: () => phone.goBack() }
    ]
  });

  const createSecurityEditView = (): PhoneView => ({
    id: 'security_mode',
    title: 'Security Mode',
    subtitle: 'Set the execution guardrail policy',
    renderBody: () => {
      console.log(chalk.white.bold('  Whitelisted Commands'));
      if (config.security.allowedCommands.length === 0) {
        console.log('  ' + chalk.dim('No commands whitelisted.'));
      } else {
        config.security.allowedCommands.forEach(cmd => {
          console.log('  ' + chalk.hex('#56CFE1')('•') + ' ' + chalk.white(cmd));
        });
      }
      console.log('');
    },
    options: [
      {
        label: `Ask for approval  ${config.security.mode === 'ask' ? '✓ (active)' : ''}`,
        description: 'Prompt before every action — safest',
        action: async () => {
          config = Configurator.updateSecurityMode('ask') || config;
          phone.updateConfig(config);
          ui.success('Set to Ask.'); await new Promise(r => setTimeout(r, 1000));
          phone.goBack(); phone.pushView(createSecurityEditView());
        }
      },
      {
        label: `Approve for me  ${config.security.mode === 'approve' ? '✓ (active)' : ''}`,
        description: 'Auto-approve whitelisted commands silently',
        action: async () => {
          config = Configurator.updateSecurityMode('approve') || config;
          phone.updateConfig(config);
          ui.success('Set to Approve.'); await new Promise(r => setTimeout(r, 1000));
          phone.goBack(); phone.pushView(createSecurityEditView());
        }
      },
      {
        label: `Full access  ${config.security.mode === 'full' ? '✓ (active)' : ''}`,
        description: 'No guardrails — dangerous',
        action: async () => {
          config = Configurator.updateSecurityMode('full') || config;
          phone.updateConfig(config);
          ui.success('Set to Full.'); await new Promise(r => setTimeout(r, 1000));
          phone.goBack(); phone.pushView(createSecurityEditView());
        }
      },
      {
        label: 'Add Whitelisted Command',
        description: 'Allow a command for approve mode',
        action: async () => {
          phone.active = false;
          ui.clearScreen();
          const cmd = await promptWithEscape('Add command to whitelist:');
          if (cmd && cmd.trim()) {
            const nextCommands = Array.from(new Set([...config.security.allowedCommands, cmd.trim()]));
            config = Configurator.updateAllowedCommands(nextCommands) || config;
            phone.updateConfig(config);
            ui.success(`Added ${cmd.trim()} to whitelist.`);
            await new Promise(r => setTimeout(r, 800));
          }
          phone.active = true;
          phone.goBack();
          phone.pushView(createSecurityEditView());
        }
      },
      {
        label: 'Remove Whitelisted Command',
        description: 'Delete a command from the whitelist',
        action: () => phone.pushView(createWhitelistRemoveView())
      },
      { label: 'Go Back', action: () => phone.goBack() }
    ]
  });

  const createProviderView = (): PhoneView => ({
    id: 'provider',
    title: 'Switch Provider',
    subtitle: 'Change the active LLM inference engine',
    options: [
      {
        label: `Groq  ${config.defaults.primaryProvider === 'groq' ? '[active]' : ''}  ${Configurator.getActiveApiKey(config, 'groq') ? '' : '-- no key'}`,
        description: Configurator.getActiveModel(config, 'groq') ? `model: ${Configurator.getActiveModel(config, 'groq')}` : 'model: qwen-qwq-32b (default)',
        action: async () => {
          if (!Configurator.getActiveApiKey(config, 'groq')) {
            phone.active = false;
            ui.clearScreen();
            const key = await promptWithEscape('Enter API Key for Groq:');
            if (key === null) {
              phone.active = true;
              phone.goBack();
              phone.pushView(createProviderView());
              return;
            }
            config = Configurator.updateApiKey('groq', key) || config;
            phone.active = true;
          }
          config = Configurator.updatePrimaryProvider('groq') || config;
          provider.setConfig(config);
          phone.updateConfig(config);
          ui.success('Switched to Groq.');
          await new Promise(r => setTimeout(r, 1000));
          phone.goBack(); phone.pushView(createProviderView());
        }
      },
      {
        label: `OpenAI  ${config.defaults.primaryProvider === 'openai' ? '[active]' : ''}  ${Configurator.getActiveApiKey(config, 'openai') ? '' : '-- no key'}`,
        description: Configurator.getActiveModel(config, 'openai') ? `model: ${Configurator.getActiveModel(config, 'openai')}` : 'model: gpt-4o (default)',
        action: async () => {
          if (!Configurator.getActiveApiKey(config, 'openai')) {
            phone.active = false;
            ui.clearScreen();
            const key = await promptWithEscape('Enter API Key for OpenAI:');
            if (key === null) {
              phone.active = true;
              phone.goBack();
              phone.pushView(createProviderView());
              return;
            }
            config = Configurator.updateApiKey('openai', key) || config;
            phone.active = true;
          }
          config = Configurator.updatePrimaryProvider('openai') || config;
          provider.setConfig(config);
          phone.updateConfig(config);
          ui.success('Switched to OpenAI.');
          await new Promise(r => setTimeout(r, 1000));
          phone.goBack(); phone.pushView(createProviderView());
        }
      },
      {
        label: `Anthropic  ${config.defaults.primaryProvider === 'anthropic' ? '[active]' : ''}  ${Configurator.getActiveApiKey(config, 'anthropic') ? '' : '-- no key'}`,
        description: Configurator.getActiveModel(config, 'anthropic') ? `model: ${Configurator.getActiveModel(config, 'anthropic')}` : 'model: claude-3-5-sonnet-20241022 (default)',
        action: async () => {
          if (!Configurator.getActiveApiKey(config, 'anthropic')) {
            phone.active = false;
            ui.clearScreen();
            const key = await promptWithEscape('Enter API Key for Anthropic:');
            if (key === null) {
              phone.active = true;
              phone.goBack();
              phone.pushView(createProviderView());
              return;
            }
            config = Configurator.updateApiKey('anthropic', key) || config;
            phone.active = true;
          }
          config = Configurator.updatePrimaryProvider('anthropic') || config;
          provider.setConfig(config);
          phone.updateConfig(config);
          ui.success('Switched to Anthropic.');
          await new Promise(r => setTimeout(r, 1000));
          phone.goBack(); phone.pushView(createProviderView());
        }
      },
      {
        label: `Gemini  ${config.defaults.primaryProvider === 'gemini' ? '[active]' : ''}  ${Configurator.getActiveApiKey(config, 'gemini') ? '' : '-- no key'}`,
        description: Configurator.getActiveModel(config, 'gemini') ? `model: ${Configurator.getActiveModel(config, 'gemini')}` : 'model: gemini-1.5-pro (default)',
        action: async () => {
          if (!Configurator.getActiveApiKey(config, 'gemini')) {
            phone.active = false;
            ui.clearScreen();
            const key = await promptWithEscape('Enter API Key for Gemini:');
            if (key === null) {
              phone.active = true;
              phone.goBack();
              phone.pushView(createProviderView());
              return;
            }
            config = Configurator.updateApiKey('gemini', key) || config;
            phone.active = true;
          }
          config = Configurator.updatePrimaryProvider('gemini') || config;
          provider.setConfig(config);
          phone.updateConfig(config);
          ui.success('Switched to Gemini.');
          await new Promise(r => setTimeout(r, 1000));
          phone.goBack(); phone.pushView(createProviderView());
        }
      },
      {
        label: `Ollama (Local)  ${config.defaults.primaryProvider === 'ollama' ? '[active]' : ''}`,
        description: Configurator.getActiveModel(config, 'ollama') ? `model: ${Configurator.getActiveModel(config, 'ollama')}` : 'model: llama3 (default)',
        action: async () => {
          config = Configurator.updatePrimaryProvider('ollama') || config;
          provider.setConfig(config);
          phone.updateConfig(config);
          ui.success('Switched to Ollama.');
          await new Promise(r => setTimeout(r, 1000));
          phone.goBack(); phone.pushView(createProviderView());
        }
      },
      { label: 'Go Back', action: () => phone.goBack() }
    ]
  });

  const createThreadsView = (): PhoneView => {
    const threads  = dbManager.listThreads();
    const maxT     = Configurator.getMaxThreads(config);
    const atLimit  = threads.length >= maxT;

    // Helper: prompt user to resolve the limit before creating a new thread
    const tryCreateThread = () => {
      if (atLimit) {
        phone.pushView({
          id: 'thread_limit',
          title: 'Thread Limit Reached',
          subtitle: `You have ${threads.length}/${maxT} sessions stored`,
          renderBody: () => {
            console.log(chalk.hex('#F59E0B').bold('  ⚠  Max thread limit reached'));
            console.log('');
            console.log(chalk.hex('#6B7280')(`  You have ${threads.length} saved sessions and the limit is ${maxT}.`));
            console.log(chalk.hex('#6B7280')('  Delete a session to make room, or raise the limit in Settings.'));
            console.log('');
          },
          options: [
            {
              label: 'Delete a Thread to Make Room',
              description: 'Remove an old session then create a new one',
              action: () => phone.pushView(createThreadsView())
            },
            {
              label: 'Raise the Thread Limit',
              description: 'Go to Settings › Max Threads',
              action: () => phone.pushView(createMaxThreadsView())
            },
            { label: 'Cancel', action: () => phone.goBack() }
          ]
        });
        return;
      }
      chatSession.createFreshThread();
      ui.success('Created a new thread.');
      phone.goBack();
      phone.pushView(createThreadsView());
    };

    if (threads.length === 0) {
      return {
        id: 'threads',
        title: 'Manage Threads',
        options: [
          {
            label: 'Create New Thread',
            description: 'Start a new empty thread',
            action: tryCreateThread
          },
          { label: 'No threads available. (Go Back)', action: () => phone.goBack() }
        ]
      };
    }
    
    return {
      id: 'threads',
      title: 'Manage Threads',
      subtitle: `${threads.length}/${maxT} sessions${atLimit ? '  ⚠ limit reached' : ''}`,
      options: [
        {
          label: atLimit
            ? chalk.hex('#F59E0B')('Create New Thread  [limit reached]')
            : 'Create New Thread',
          description: atLimit
            ? `At the ${maxT}-thread limit — delete one first or raise the limit`
            : 'Start a fresh session and make it active',
          action: tryCreateThread
        },
        {
          label: chalk.red('Delete All Threads'),
          description: 'Remove every saved thread and start fresh',
          action: async () => {
            phone.active = false;
            ui.clearScreen();
            const approved = await confirm({
              message: 'Delete all saved threads?',
              default: false
            });
            if (approved) {
              dbManager.deleteAllThreads();
              chatSession.clearAllThreadMessages();
              chatSession.createFreshThread();
              ui.success('Deleted all threads. Started a fresh chat.');
              await new Promise(r => setTimeout(r, 800));
            }
            phone.active = true;
            phone.goBack();
            phone.pushView(createThreadsView());
          }
        },
        ...threads.map(t => {
          const isRunning = chatSession.activeStreams.has(t.id);
          const runningTag = isRunning ? chalk.green(' 🟢 [running]') : '';
          const activeTag = t.id === chatSession.threadId ? chalk.hex('#6B7280')(' (active)') : '';
          return {
            label: t.displayName + activeTag + runningTag,
            description: t.id,
          action: () => {
             phone.pushView({
               id: 'thread_actions',
               title: 'Thread Actions',
               subtitle: `${t.displayName}  [${t.id}]`,
               options: [
                 {
                   label: 'Switch to Thread',
                   action: async () => {
                     phone.active = false;
                     ui.clearScreen();
                     chatSession.switchThread(t.id);
                     ui.success(`Switched to ${t.displayName}`);
                     await new Promise(r => setTimeout(r, 600));
                     phone.active = true;
                     phone.goBack();
                     phone.goBack();
                     phone.pushView(createThreadsView());
                   }
                 },
                 {
                   label: chalk.red('Delete Thread'),
                   action: async () => {
                     phone.active = false;
                     ui.clearScreen();
                     dbManager.deleteThread(t.id);
                     chatSession.clearThreadMessages(t.id);
                     if (chatSession.threadId === t.id) {
                       chatSession.createFreshThread();
                       ui.success(`Deleted ${t.displayName}. Started a fresh chat.`);
                     } else {
                       ui.success(`Deleted ${t.displayName}`);
                     }
                     await new Promise(r => setTimeout(r, 600));
                     phone.active = true;
                     phone.goBack();
                     phone.goBack();
                     phone.pushView(createThreadsView());
                   }
                 },
                 { label: 'Go Back', action: () => phone.goBack() }
               ]
             });
          }
        };
        }),
        { label: 'Go Back', action: () => phone.goBack() }
      ]
    };
  };

  const createAnalyticsView = (): PhoneView => ({
    id: 'analytics',
    title: 'Analytics Dashboard',
    subtitle: 'Real-time performance metrics and usage insights',
    renderBody: () => {
      const stats = memoryManager.getBudgetStatsForMessages(chatSession.getMessages(), rules);
      const threads = dbManager.listThreads().length;
      console.log('  \x1b[36mTokens Filled:\x1b[0m   ' + stats.filled + ' tk');
      console.log('  \x1b[36mContext Limit:\x1b[0m  ' + stats.max + ' tk');
      console.log('  \x1b[36mTotal Sessions:\x1b[0m ' + threads);
      console.log('  \x1b[36mTime Saved:\x1b[0m     Est. ' + Math.round((stats.filled / 500) * 1.5) + ' mins (based on 500 WPM reading speed)');
      console.log('');
      console.log('  \x1b[35m● \x1b[0m Truncated/Saved Tokens: \x1b[32m' + stats.compressed + '\x1b[0m');
      console.log('  \x1b[35m● \x1b[0m O.T.T.O Context Bar: \x1b[32m' + (config.defaults.showContextBar !== false ? 'ON' : 'OFF') + '\x1b[0m');
    },
    options: [
      { label: 'Go Back', action: () => phone.goBack() }
    ]
  });

  const createHomeView = (): PhoneView => ({
    id: 'home',
    title: 'Home',
    renderBody: () => {
      const W = process.stdout.columns ? Math.max(Math.min(process.stdout.columns - 8, 110), 60) : 95;
      const isCompact = (process.stdout.columns && process.stdout.columns < 85) || (process.stdout.rows && process.stdout.rows < 28);
      const threads = dbManager.listThreads();
      const model = (config.providers as any)[config.defaults.primaryProvider]?.model || 'Default Model';

      // Sleek Text Logo (ANSI Shadow Block Font)
      const logoLines = [
        "  ██████╗ ████████╗████████╗ ██████╗ ",
        " ██╔═══██╗╚══██╔══╝╚══██╔══╝██╔═══██╗",
        " ██║   ██║   ██║      ██║   ██║   ██║",
        " ██║   ██║   ██║      ██║   ██║   ██║",
        " ╚██████╔╝   ██║      ██║   ╚██████╔╝",
        "  ╚═════╝    ╚═╝      ╚═╝    ╚═════╝ "
      ];

      const borderDim = chalk.hex('#F5C400');
      const textDim = chalk.hex('#6B7280');
      const accent = chalk.hex('#56CFE1');
      const purple = chalk.hex('#9D4EDD');
      const displayName = Configurator.getUsername(config) || 'user';
      const isDefaultName = !config.profile?.username;

      if (isCompact) {
        console.log(borderDim(' ╭─ O.T.T.O v1.1.10 ' + '─'.repeat(Math.max(0, W - 18)) + '╮'));
        console.log(borderDim(' │ ') + chalk.whiteBright(`Welcome back, ${displayName}!`).padEnd(Math.max(0, W - 1)) + borderDim('│'));
        if (isDefaultName) {
          console.log(borderDim(' │ ') + chalk.hex('#F59E0B')('⚠  Go to Settings › Profile to set your username').padEnd(Math.max(0, W - 1)) + borderDim('│'));
        }
        console.log(borderDim(' ╰' + '─'.repeat(W) + '╯'));
        return;
      }

      const vlen = (s: string) => s.replace(/\x1B\[[0-9;]*m/g, '').length;
      const leftWidth = Math.max(40, Math.floor(W * 0.55));
      const rightWidth = W - leftWidth;

      const drawRow = (left: string, right: string, leftColor: any, rightColor: any) => {
        const lPad = Math.max(0, leftWidth - vlen(left));
        const rPad = Math.max(0, rightWidth - vlen(right));
        process.stdout.write(borderDim(' │') + leftColor(left) + ' '.repeat(lPad) + rightColor(right) + ' '.repeat(rPad) + borderDim('│\n'));
      };

      const rightRows = [
        '',
        chalk.hex('#F5C400').bold('  [ SYSTEM STATUS ]'),
        `    Agent    ${chalk.green('● Ready')}`,
        `    Security ${purple('● ' + config.security.mode)}`,
        `    Thread   ${accent('● ' + (threads.length > 0 ? chatSession.threadId : 'None'))}`,
        '',
        chalk.hex('#F5C400').bold('  [ NAVIGATION ]'),
        `    ${textDim('↑↓')} Navigate   ${textDim('↵')} Select`,
        `    ${textDim('←→')} Switch     ${textDim('^C')} Quit`,
        ''
      ];

      console.log(borderDim(' ╭─ O.T.T.O v1.1.10 ' + '─'.repeat(Math.max(0, W - 18)) + '╮'));

      drawRow(`      Welcome back, ${displayName}!`, rightRows[0], chalk.white, chalk.white);
      if (isDefaultName) {
        drawRow(`      ${chalk.hex('#F59E0B')('⚠')} ${chalk.hex('#6B7280')('Go to Settings › Profile to set your username')}`, rightRows[1], chalk.white, chalk.white);
      } else {
        drawRow('', rightRows[1], chalk.white, chalk.white);
      }
      
      drawRow(`   ${logoLines[0]}`, rightRows[2], borderDim, chalk.white);
      drawRow(`   ${logoLines[1]}`, rightRows[3], borderDim, chalk.white);
      drawRow(`   ${logoLines[2]}`, rightRows[4], borderDim, chalk.white);
      drawRow(`   ${logoLines[3]}`, rightRows[5], borderDim, chalk.white);
      drawRow(`   ${logoLines[4]}`, rightRows[6], borderDim, chalk.white);
      drawRow(`   ${logoLines[5]}`, rightRows[7], borderDim, chalk.white);

      drawRow(`    ${model} ·(active)`, rightRows[8], textDim, chalk.white);
      
      let pth = process.cwd();
      if (pth.length > leftWidth - 4) pth = '...' + pth.slice(-(leftWidth - 7));
      drawRow(`    ${pth}`, rightRows[9], textDim, chalk.white);

      console.log(borderDim(' ╰' + '─'.repeat(W) + '╯'));
    },
    options: [
      {
        label: 'Enter Chat',
        description: 'Start a conversation with the AI agent',
        action: async () => {
          phone.cleanup();
          await startChat();
          phone.startListening();
          phone.render();
        }
      },
      {
        label: 'Switch Provider',
        description: 'Change the active LLM inference engine',
        action: () => phone.pushView(createProviderView())
      },
      {
        label: 'Manage Threads',
        description: `Manage your chat sessions (${dbManager.listThreads().length})`,
        action: () => phone.pushView(createThreadsView())
      },
      {
        label: 'Manage Terminal Sessions',
        description: 'View or kill running background processes',
        action: () => {
          const procs = backgroundManager.getProcesses();
          phone.pushView({
            id: 'terminal_sessions',
            title: 'Manage Terminal Sessions',
            options: procs.length === 0 ? [
              { label: 'No background processes running. (Go Back)', action: () => phone.goBack() }
            ] : [
              ...procs.map(p => ({
                label: `[PID ${p.pid}] ${p.command}`,
                description: `Running for ${Math.round((Date.now() - p.startTime) / 1000)}s`,
                action: async () => {
                  phone.active = false;
                  ui.clearScreen();
                  const confirmKill = await confirm({ message: `Kill process ${p.pid} (${p.command})?`, default: false });
                  if (confirmKill) {
                    try {
                      await backgroundManager.killProcess(p.pid);
                      ui.success(`Killed process ${p.pid}`);
                    } catch (e: any) {
                      ui.error(`Failed to kill: ${e.message}`);
                    }
                    await new Promise(r => setTimeout(r, 1000));
                  }
                  phone.active = true;
                  phone.goBack();
                }
              })),
              { label: 'Go Back', action: () => phone.goBack() }
            ]
          });
        }
      },
      {
        label: 'Command Palette',
        description: 'Fuzzy search actions and files (Ctrl+K style)',
        action: () => phone.pushView(createCommandPaletteView(
           phone,
           () => phone.pushView(createSettingsView()),
           () => phone.pushView(createTaskBoardView(phone)),
           () => phone.pushView(createGitPanelView(phone)),
           () => phone.pushView(createFileTreeView(phone)),
           () => phone.pushView(createAnalyticsView())
        ))
      },
      {
        label: 'Task Board (Kanban)',
        description: 'Manage your project tasks visually',
        action: () => phone.pushView(createTaskBoardView(phone))
      },
      {
        label: 'Project File Tree',
        description: 'Explore workspace directories visually',
        action: () => phone.pushView(createFileTreeView(phone))
      },
      {
        label: 'Git Dashboard',
        description: 'View version control status and branches',
        action: () => phone.pushView(createGitPanelView(phone))
      },
      {
        label: 'Analytics Dashboard',
        description: 'View token usage and performance metrics',
        action: () => phone.pushView(createAnalyticsView())
      },
      {
        label: 'Settings & Security',
        description: 'API keys, security mode, and display options',
        action: () => phone.pushView(createSettingsView())
      },
      {
        label: 'Exit',
        action: () => {
          ui.clearScreen();
          process.exit(0);
        }
      }
    ]
  });

  // Launch OS
  phone.pushView(createHomeView());
  phone.startListening();
  phone.render();
}

main().catch(err => {
  ui.error(err.message);
  process.exit(1);
});
