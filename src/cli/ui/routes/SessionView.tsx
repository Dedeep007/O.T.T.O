import React from 'react';
import { Box, Text } from 'ink';
import { useSession } from '../contexts/SessionContext.js';
import { useTheme } from '../contexts/ThemeContext.js';
import { AgentMessage, ToolBlock, UserMessage } from '../components.js';
import { PromptInput } from '../PromptInput.js';

export function SessionView({ chatUI }: { chatUI: any }) {
  const { state } = useSession();
  const theme = useTheme();

  const winHeight = process.stdout.rows || 24;
  const winWidth = process.stdout.columns || 80;

  // Robust Line-Aware Pagination
  let estimatedLines = 0;
  let maxLines = Math.max(10, winHeight - 8);
  let renderMessages = [];
  let skippedMessages = 0;
  
  for (let i = state.messages.length - 1; i >= 0; i--) {
    if (skippedMessages < chatUI.scrollOffset) {
       skippedMessages++;
       continue;
    }
    
    const msg = state.messages[i];
    let lines = 2; // header overhead
    if (msg.content) {
       lines += msg.content.split('\n').map((l: string) => Math.ceil((l.length || 1) / (winWidth - 4))).reduce((a: number, b: number) => a + b, 0);
    }
    if (msg.toolCalls) lines += msg.toolCalls.length * 3;
    if (msg.toolInfo) lines += 3;
    if (msg.content.includes('<think>')) lines += 2; // think block overhead
    
    if (estimatedLines + lines > maxLines && renderMessages.length > 0) {
      break;
    }
    
    estimatedLines += lines;
    renderMessages.unshift(msg);
  }

  const ratio = state.telemetry.ctxMax > 0 ? Math.min(state.telemetry.ctxUsed / state.telemetry.ctxMax, 1) : 0;
  const fill = Math.round(ratio * 7);
  const ctxBarFill = '■'.repeat(fill);
  const ctxBarEmpty = '■'.repeat(7 - fill);

  return (
    <Box flexDirection="column" height={winHeight - 1}>
      <Box marginBottom={1} borderStyle="single" borderTop={false} borderLeft={false} borderRight={false} borderColor={theme.border} paddingBottom={1}>
        <Text color={theme.primary}>● </Text>
        <Text color={theme.text}>active session   model: {state.model}   tokens: {state.telemetry.ctxUsed}</Text>
      </Box>

      <Box flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
        <Box flexDirection="column" marginTop={0}>
          {renderMessages.map((msg: any, i: number) => (
            <Box key={msg.id || (i)} flexDirection="column">
              {msg.role === 'system' && <Text color={theme.dimText}>{msg.content}</Text>}
              {msg.role === 'tool' && msg.toolInfo && <ToolBlock tool={msg.toolInfo} />}
              {msg.toolCalls && msg.toolCalls.length > 0 && msg.state === 'tools' && (
                <Box flexDirection="column">
                  {msg.toolCalls.map((tc: any, j: number) => <ToolBlock key={j} tool={{ name: tc.name, args: tc.args, status: 'running' }} />)}
                </Box>
              )}
              {msg.role === 'user' && <UserMessage msg={msg.content} />}
              {msg.role === 'ai' && <AgentMessage msg={msg.content} isThinking={state.isThinking} isStreaming={state.telemetry.isStreaming || false} diffsExpanded={state.diffsExpanded} width={winWidth} />}
            </Box>
          ))}
          {state.isThinking && <AgentMessage msg="<think>Thinking...</think>" isThinking={true} isStreaming={true} diffsExpanded={state.diffsExpanded} width={winWidth} />}
          {state.delayMessage && <AgentMessage msg={state.delayMessage + "..."} isThinking={state.isThinking} isStreaming={true} diffsExpanded={state.diffsExpanded} width={winWidth} />}
        </Box>
      </Box>

      {/* Legacy inline approval dialogs - moved up so they don't block input */}
      {state.pendingApproval && (
        <Box flexDirection="column" marginBottom={1} padding={1} borderStyle="round" borderColor="#b83030">
          <Text bold color={theme.error}>⚠ COMMAND APPROVAL</Text>
          <Text color={theme.secondary}> ⚡ run bash command <Text color="#776633"> requires approval</Text></Text>
          <Box marginTop={1}>
            <Text color="#554422">COMMAND: </Text><Text color={theme.primary}>{state.pendingApproval.commandStr}</Text>
          </Box>
          <Box marginTop={1}>
            <Text color={state.approvalMenuIndex === 0 ? theme.text : theme.dimText}>{state.approvalMenuIndex === 0 ? '▶ ' : '  '}Approve </Text>
            <Text color={state.approvalMenuIndex === 1 ? theme.text : theme.dimText}>{state.approvalMenuIndex === 1 ? '▶ ' : '  '}Reject </Text>
          </Box>
        </Box>
      )}

      {state.pendingPlan && (
        <Box flexDirection="column" marginBottom={1} padding={1} borderStyle="round" borderColor="#30b8b8">
          <Text bold color="#55ffff">📋 PLAN APPROVAL</Text>
          <Text color={theme.secondary}> ◈ proposed plan <Text color="#776633"> review before executing</Text></Text>
          <Box marginTop={1}>
            <Text color={state.planMenuIndex === 0 ? theme.text : theme.dimText}>{state.planMenuIndex === 0 ? '▶ ' : '  '}Proceed </Text>
            <Text color={state.planMenuIndex === 1 ? theme.text : theme.dimText}>{state.planMenuIndex === 1 ? '▶ ' : '  '}Reject </Text>
          </Box>
        </Box>
      )}

      <PromptInput />

      {state.telemetry.showContextBar && (
        <Box marginTop={1}>
          <Text color={theme.dimText}>model: </Text><Text color={theme.primary}>{state.model.split('-')[0] || 'provider'} </Text>
          <Text color={theme.dimText}>  ctx: </Text>
          <Text color={ratio > 0.75 ? theme.error : theme.primary}>{ctxBarFill}</Text>
          <Text color={theme.border}>{ctxBarEmpty}</Text>
          <Text color={theme.dimText}>  sec: </Text>
          <Text color={theme.primary}>{state.securityMode}</Text>
          <Box flexGrow={1} justifyContent="flex-end">
            <Text color={theme.border}>ctrl+x: stop | esc: menu | @: context | /: cmd</Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}
