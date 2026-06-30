import React from 'react';
import { Box, Text } from '../ink-compat.js';
import chalk from 'chalk';
import { renderMarkdownWithOttoStyles } from '../chat.js';

export const ToolBlock = React.memo(({ tool }: { tool: any }) => {
  const isRunning = tool.status === 'running';
  const isError = tool.status === 'error';
  const icon = isError ? '✗' : isRunning ? '●' : '✓';
  const statusColor = isRunning ? '#d4b43f' : isError ? '#8a3a3a' : '#7a6a1a';
  const statusBg = isRunning ? '#1a1500' : isError ? '#1a0a0a' : '#161407';
  const statusText = isRunning ? ' ● running ' : isError ? ' ✗ error ' : ' ✓ done ';

  return (
    <Box flexDirection="column" borderStyle="single" borderLeft={true} borderRight={false} borderTop={false} borderBottom={false} borderColor={statusColor} paddingLeft={1} marginBottom={1} marginLeft={2}>
      <Box justifyContent="space-between">
        <Text>
          <Text backgroundColor={statusBg} color={statusColor} bold> {icon} {tool.name} </Text>
        </Text>
        <Text backgroundColor={statusBg} color={statusColor} dimColor>{statusText}</Text>
      </Box>
      {tool.args && Object.keys(tool.args).length > 0 && (
        <Box marginTop={0} flexDirection="column">
          {Object.entries(tool.args).map(([k, v]) => {
            const valStr = typeof v === 'object' ? JSON.stringify(v) : String(v);
            return (
              <Box key={k} marginLeft={2}>
                <Text color="#6a6040">{k}: </Text>
                <Text color="#c9a800">"{valStr.replace(/\r/g, '')}"</Text>
              </Box>
            );
          })}
        </Box>
      )}
      {tool.status !== 'running' && tool.rawOutput && (
        <Box marginTop={1} flexDirection="column">
          <Text color="#2a2000">{'─'.repeat(50)}</Text>
          <Text color="#7a6a3a" dimColor>{tool.rawOutput.replace(/\r/g, '').substring(0, 500)}{tool.rawOutput.length > 500 ? '...' : ''}</Text>
        </Box>
      )}
    </Box>
  );
}, (prev, next) => {
  if (!prev.tool || !next.tool) return false;
  return prev.tool.name === next.tool.name &&
         prev.tool.status === next.tool.status &&
         prev.tool.rawOutput === next.tool.rawOutput &&
         JSON.stringify(prev.tool.args || {}) === JSON.stringify(next.tool.args || {});
});

export const AgentMessage = React.memo(({ msg, isThinking, isStreaming, diffsExpanded, width }: { msg: string, isThinking: boolean, isStreaming: boolean, diffsExpanded: boolean, width: number }) => {
  let rawContent = msg;
  let thinkBlock = null;
  const thinkMatch = rawContent.match(/<(?:think|thought)>([\s\S]*?)(?:<\/(?:think|thought)>|$)/);
  if (thinkMatch) {
    rawContent = rawContent.replace(/<(?:think|thought)>[\s\S]*?(?:<\/(?:think|thought)>|$)/, '').trim();
    const thinkLines = thinkMatch[1].trim().split('\n');
    thinkBlock = diffsExpanded ? (
      <Box flexDirection="column" marginBottom={1}>
        {thinkLines.map((l, i) => <Text key={i} color="#f5c542" backgroundColor="#161407">{l}</Text>)}
      </Box>
    ) : (
      <Box marginBottom={1}><Text color="#f5c542" backgroundColor="#161407">[ Reasoning Process ({thinkLines.length} lines) - Press Ctrl+E to Expand ]</Text></Box>
    );
  }

  // Robustly strip JSON tool calls (both complete and incomplete during streaming)
  rawContent = rawContent.replace(/```(?:json)?[\s\S]*?```/g, (m) => m.includes('"name"') && m.includes('arguments') ? '' : m);
  if (isStreaming) {
    // Aggressively hide unclosed tool payloads that are actively streaming
    rawContent = rawContent.replace(/```(?:json)?\s*\{\s*"name"[\s\S]*$/, '');
    rawContent = rawContent.replace(/\{\s*"name"\s*:\s*"[^"]*"[\s\S]*$/, '');
  } else {
    rawContent = rawContent.replace(/\{[^{}]*"name"[\s\S]*?(?:"arguments"[\s\S]*?\}|$)/g, '');
  }
  
  rawContent = rawContent.replace(/^[\s}]+$/gm, '');
  rawContent = rawContent.replace(/\n{3,}/g, '\n\n');
  rawContent = rawContent.trim();

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box marginBottom={0}>
        <Text backgroundColor="#161407" color="#d4b43f" bold> O.T.T.O </Text>
      </Box>
      {thinkBlock}
      {msg.includes('<think>') && !msg.includes('</think>') && (
        <Box paddingLeft={1} marginTop={1}>
          <Text color="#f5c542" backgroundColor="#161407"> [ Thinking... ] </Text>
        </Box>
      )}
      {rawContent && (
        <Box marginTop={thinkBlock ? 1 : 0} paddingLeft={0}>
          {isStreaming ? (
            <Text color="#d4d4d4">{rawContent}</Text>
          ) : (
            <Text color="#d4d4d4">{renderMarkdownWithOttoStyles(rawContent.replace(/`([^`]+)`/g, (_m: any, p1: string) => chalk.hex('#f5c542')(p1)), Math.max(10, width - 4), diffsExpanded).trim()}</Text>
          )}
        </Box>
      )}
    </Box>
  );
}, (prev, next) => {
  return prev.msg === next.msg && 
         prev.isThinking === next.isThinking &&
         prev.isStreaming === next.isStreaming &&
         prev.diffsExpanded === next.diffsExpanded &&
         prev.width === next.width;
});

export const UserMessage = React.memo(({ msg }: { msg: string }) => {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box marginBottom={0}>
        <Text backgroundColor="#1c1c1c" color="#888888"> you </Text>
      </Box>
      <Box paddingLeft={1} borderStyle="single" borderLeft={true} borderRight={false} borderTop={false} borderBottom={false} borderColor="#333">
        <Text color="#f0f0f0">{msg.trim()}</Text>
      </Box>
    </Box>
  );
});
