import React, { useState, useEffect } from 'react';
import { Box, Text, useInput, Static } from 'ink';
import chalk from 'chalk';
import { marked, Marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import fs from 'fs';
import path from 'path';

export interface ChatMessage {
  role: 'user' | 'ai' | 'system' | 'tool';
  content: string;
  toolInfo?: {
    name: string;
    args: any;
    status: 'running' | 'done' | 'error';
    rawOutput?: string;
  };
  toolCalls?: any[];
  state?: string;
}

export interface ChatTelemetry {
  ctxMax: number;
  ctxUsed: number;
  ramMB: number;
  showContextBar: boolean;
  isStreaming?: boolean;
}

marked.use(markedTerminal({
  showSectionPrefix: false,
  unescape: true,
  tab: 2
}) as any);

export function renderMarkdownWithOttoStyles(text: string, W: number, diffsExpanded: boolean) {
  let md = marked.parse(text) as string;
  return md;
}

export class ChatUI {
  public scrollOffset = 0;
  public totalContentLines = 0;
  public notification: string = '';
  public notificationType: 'success' | 'warning' | 'error' | 'info' | 'alert' = 'success';
  private notificationTimeout?: NodeJS.Timeout;

  private listeners: (() => void)[] = [];
  public currentData: any = null;
  private keyHandler?: (str: string, key: any) => void;

  showNotification(msg: string, type: 'success' | 'warning' | 'error' | 'info' | 'alert' = 'success', timeoutMs: number = 2000) {
    this.notification = msg;
    this.notificationType = type;
    if (this.notificationTimeout) {
      clearTimeout(this.notificationTimeout);
    }
    this.notify();
    this.notificationTimeout = setTimeout(() => {
      this.notification = '';
      this.notify();
    }, timeoutMs);
  }

  registerKeyHandler(handler: (str: string, key: any) => void) {
    this.keyHandler = handler;
  }

  removeKeyHandler() {
    this.keyHandler = undefined;
  }

  getKeyHandler() {
    return this.keyHandler;
  }

  subscribe(listener: () => void) {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  notify() {
    this.listeners.forEach(l => l());
  }

  scrollUp(n = 3) {
    this.scrollOffset += n;
    this.notify();
  }

  scrollDown(n = 3) {
    this.scrollOffset = Math.max(0, this.scrollOffset - n);
    this.notify();
  }

  scrollToBottom() {
    this.scrollOffset = 0;
    this.notify();
  }

  isAtBottom(): boolean {
    return this.scrollOffset === 0;
  }

  render(
    messages: ChatMessage[],
    currentInput: string,
    telemetry: ChatTelemetry,
    model: string,
    isThinking: boolean = false,
    pendingPlan: boolean = false,
    planMenuIndex: number = 0,
    diffsExpanded: boolean = false,
    delayMessage?: string,
    pendingApproval?: { type: 'command' | 'app', cmd: string, commandStr: string },
    approvalMenuIndex: number = 0
  ) {
    this.currentData = {
      messages,
      currentInput,
      telemetry,
      model,
      isThinking,
      pendingPlan,
      planMenuIndex,
      diffsExpanded,
      delayMessage,
      pendingApproval,
      approvalMenuIndex
    };
    this.notify();
  }
}

export function translateInkKey(input: string, key: any) {
  let name = '';
  if (key.upArrow) name = 'up';
  else if (key.downArrow) name = 'down';
  else if (key.leftArrow) name = 'left';
  else if (key.rightArrow) name = 'right';
  else if (key.return) name = 'return';
  else if (key.escape) name = 'escape';
  else if (key.backspace || key.delete || input === '\x7f' || input === '\x08') name = 'backspace';
  else if (key.tab) name = 'tab';
  else if (key.pageUp) name = 'pageup';
  else if (key.pageDown) name = 'pagedown';
  else if (input) name = input.toLowerCase();

  return { ctrl: !!key.ctrl, meta: !!key.meta, shift: !!key.shift, name };
}

function ChatUIInput({ chatUI }: { chatUI: ChatUI }) {
  useInput((input, key) => {
    const handler = chatUI.getKeyHandler();
    if (handler) {
      const translatedKey = translateInkKey(input, key);
      handler(input, translatedKey);
    }
  });
  return null;
}

// ── INK COMPONENTS ── //

const ToolBlock = ({ tool }: { tool: any }) => {
  const isRunning = tool.status === 'running';
  const isError = tool.status === 'error';
  const icon = isError ? '✗' : '⌕';
  const statusColor = isRunning ? '#7a6a1a' : isError ? '#8a3a3a' : '#3d8a2a';
  const statusBg = isRunning ? '#1a1500' : isError ? '#1a0a0a' : '#0a1a00';
  const statusText = isRunning ? ' ● running ' : isError ? ' ✗ error ' : ' ✓ done ';

  return (
    <Box flexDirection="column" borderStyle="single" borderLeft={true} borderRight={false} borderTop={false} borderBottom={false} borderColor="#c9a800" paddingLeft={1} marginBottom={1}>
      <Box justifyContent="space-between">
        <Text>
          <Text backgroundColor="#1a1500" color="#c9a800"> {icon} </Text>
          <Text color="#c9a800" bold> {tool.name}</Text>
        </Text>
        <Text backgroundColor={statusBg} color={statusColor}>{statusText}</Text>
      </Box>
      {tool.args && Object.keys(tool.args).length > 0 && (
        <Box marginTop={1} flexDirection="column">
          {Object.entries(tool.args).map(([k, v]) => (
            <Text key={k}>
              <Text color="#6a6040">{k}: </Text>
              <Text color="#c9a800">"{typeof v === 'object' ? JSON.stringify(v) : String(v)}"</Text>
            </Text>
          ))}
        </Box>
      )}
      {!isRunning && tool.rawOutput && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="#2a2000">{'─'.repeat(50)}</Text>
          <Text color={isError ? '#8a3a3a' : '#3d3310'}>{isError ? 'ERROR' : 'OUTPUT'}</Text>
          <Text color="#7a6a3a" dimColor>{tool.rawOutput.substring(0, 500)}{tool.rawOutput.length > 500 ? '...' : ''}</Text>
        </Box>
      )}
    </Box>
  );
};

const AgentMessage = ({ msg, isThinking, diffsExpanded }: { msg: string, isThinking: boolean, diffsExpanded: boolean }) => {
  let rawContent = msg;
  let thinkBlock = null;
  const thinkMatch = rawContent.match(/<(?:think|thought)>([\s\S]*?)(?:<\/(?:think|thought)>|$)/);
  if (thinkMatch) {
    rawContent = rawContent.replace(/<(?:think|thought)>[\s\S]*?(?:<\/(?:think|thought)>|$)/, '').trim();
    const thinkLines = thinkMatch[1].trim().split('\n');
    thinkBlock = diffsExpanded ? (
      <Box flexDirection="column" marginBottom={1}>
        {thinkLines.map((l, i) => <Text key={i} color="#5a5040" backgroundColor="#161407">{l}</Text>)}
      </Box>
    ) : (
      <Text color="#5a5040" backgroundColor="#161407" marginBottom={1}>[ Reasoning Process ({thinkLines.length} lines) - Press Ctrl+E to Expand ]</Text>
    );
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text backgroundColor="#161407">
        <Text color="#c9a800">◆ </Text><Text color="#7a6a1a">otto</Text>
      </Text>
      {thinkBlock}
      {msg.includes('<think>') && !msg.includes('</think>') && (
        <Text color="#5a5040" backgroundColor="#161407">Thinking...</Text>
      )}
      {rawContent && (
        <Box backgroundColor="#161407" paddingLeft={1} paddingRight={1}>
           {/* Rendering markdown properly in Ink usually requires a custom component. For now we use markedTerminal output */}
           <Text>{renderMarkdownWithOttoStyles(rawContent, 80, diffsExpanded).trim()}</Text>
        </Box>
      )}
    </Box>
  );
};

const UserMessage = ({ msg }: { msg: string }) => {
  return (
    <Box flexDirection="column" alignItems="flex-end" marginBottom={1} width="100%">
      <Text backgroundColor="#1c1c1c" color="#484848"> you </Text>
      <Box backgroundColor="#1c1c1c" paddingLeft={1} paddingRight={1}>
        <Text color="#d4d4d4">{msg.trim()}</Text>
      </Box>
    </Box>
  );
};

export function ChatUIApp({ chatUI }: { chatUI: ChatUI }) {
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    return chatUI.subscribe(() => forceUpdate(prev => prev + 1));
  }, [chatUI]);

  if (!chatUI.currentData) return <Box><Text>Loading...</Text></Box>;

  const {
    messages,
    currentInput,
    telemetry,
    model,
    isThinking,
    pendingPlan,
    planMenuIndex,
    diffsExpanded,
    delayMessage,
    pendingApproval,
    approvalMenuIndex
  } = chatUI.currentData;

  const isTTY = !!(process.stdin && process.stdin.isTTY);

  // Context calculations
  const ratio = telemetry.ctxMax > 0 ? Math.min(telemetry.ctxUsed / telemetry.ctxMax, 1) : 0;
  const fill = Math.round(ratio * 7);
  const ctxBarFill = '■'.repeat(fill);
  const ctxBarEmpty = '■'.repeat(7 - fill);

  return (
    <Box flexDirection="column" height={process.stdout.rows - 1}>
      {/* Session Bar */}
      <Box marginBottom={1} borderStyle="single" borderTop={false} borderLeft={false} borderRight={false} borderColor="#1a1a1a" paddingBottom={1}>
        <Text color="#2d6a1a">● </Text>
        <Text color="#333333">active session   model: {model}   tokens: {telemetry.ctxUsed}</Text>
      </Box>

      {/* Messages Window (Scrollable area) */}
      <Box flexDirection="column" flexGrow={1} overflowY="hidden">
        {/* Because Ink handles scrolling natively poorly without ink-virtual-list, we just render a subset of messages or let it render. 
            For now, we map the last N messages to fit the screen roughly, or just render all and let Ink truncate (overflowY="hidden" natively clips). */}
        <Box flexDirection="column" marginTop={-chatUI.scrollOffset}>
          {messages.map((msg: any, i: number) => (
            <Box key={i} flexDirection="column">
              {msg.role === 'system' && <Text color="#555555">{msg.content}</Text>}
              {msg.role === 'tool' && msg.toolInfo && <ToolBlock tool={msg.toolInfo} />}
              {msg.toolCalls && msg.toolCalls.length > 0 && msg.state === 'tools' && (
                <Box flexDirection="column">
                  {msg.toolCalls.map((tc: any, j: number) => <ToolBlock key={j} tool={{ name: tc.name, args: tc.args, status: 'running' }} />)}
                </Box>
              )}
              {msg.role === 'user' && <UserMessage msg={msg.content} />}
              {msg.role === 'ai' && <AgentMessage msg={msg.content} isThinking={isThinking} diffsExpanded={diffsExpanded} />}
            </Box>
          ))}
          {isThinking && <AgentMessage msg="<think>Thinking...</think>" isThinking={true} diffsExpanded={diffsExpanded} />}
          {delayMessage && <AgentMessage msg={delayMessage + "..."} isThinking={isThinking} diffsExpanded={diffsExpanded} />}
        </Box>
      </Box>

      {/* Approval Blocks */}
      {pendingApproval && (
        <Box flexDirection="column" marginBottom={1} backgroundColor="#0a0a0a" padding={1}>
          <Text bold color="#444444">⚠ COMMAND APPROVAL</Text>
          <Text color="#c9a800"> ⚡ run bash command <Text color="#4a4020"> requires approval</Text></Text>
          <Box backgroundColor="#080800" paddingLeft={1} marginY={1}>
            <Text color="#3d3310">COMMAND: </Text><Text color="#e0c040">{pendingApproval.commandStr}</Text>
          </Box>
          <Box>
            {[{ label: 'allow for now', key: 'y' }, { label: 'allow always', key: 'a' }, { label: 'reject', key: 'n' }].map((item, idx) => (
               <Box key={item.key} marginRight={2} backgroundColor={idx === approvalMenuIndex ? '#1e1800' : undefined}>
                 <Text color={idx === approvalMenuIndex ? '#c9a800' : '#555555'}>
                   {idx === approvalMenuIndex ? '> ' : '  '}[{item.key}] {item.label}
                 </Text>
               </Box>
            ))}
          </Box>
        </Box>
      )}

      {/* Input Area */}
      <Box flexDirection="column">
        <Box>
          <Text backgroundColor="#111000" color="#c9a800"> › </Text>
          <Text backgroundColor="#111000" color="#d4d4d4">{currentInput}</Text>
          {(!isThinking && !pendingApproval && !pendingPlan && !delayMessage) && (
            <Text backgroundColor={(Math.floor(Date.now() / 1000) % 2 === 0) ? '#c9a800' : '#111000'}> </Text>
          )}
          {currentInput.length === 0 && (
            <Text backgroundColor="#111000" color={isThinking || telemetry.isStreaming ? '#ef4444' : '#444444'}>
              {isThinking || telemetry.isStreaming ? 'Press [Ctrl+X] to terminate' : 'Type your message...'}
            </Text>
          )}
        </Box>

        {/* Context Row */}
        <Box justifyContent="space-between" marginTop={1}>
          <Box>
            <Text color="#f5c542">{model.split('-')[0] || 'provider'} </Text>
            <Text color="#555555"> ctx </Text>
            <Text color={ratio > 0.75 ? '#ff6b6b' : '#f5c542'}>{ctxBarFill}</Text>
            <Text color="#333333">{ctxBarEmpty}</Text>
            <Text color="#555555">  sec </Text>
            <Text color="#f5c542">strict</Text>
          </Box>
          <Box>
            <Text color="#2a2a2a">ctrl+x: stop | ctrl+e: diff | esc: menu | @: context | /: cmd</Text>
          </Box>
        </Box>
      </Box>
      {isTTY && <ChatUIInput chatUI={chatUI} />}
    </Box>
  );
}
