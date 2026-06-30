import React from 'react';
import { Box, Text } from '../ink-compat.js';
import { useSession } from './contexts/SessionContext.js';
import { useTheme } from './contexts/ThemeContext.js';

export function PromptInput() {
  const { state } = useSession();
  const theme = useTheme();

  return (
    <Box borderStyle="single" borderTop={true} borderLeft={false} borderRight={false} borderBottom={false} borderColor={theme.primary} paddingTop={1} flexDirection="column" flexShrink={0}>
      <Box>
        <Text color={theme.primary} bold> › </Text>
        <Text color={theme.text}>{state.currentInput}</Text>
        {(!state.isThinking && !state.pendingApproval && !state.pendingPlan && !state.delayMessage) && (
          <Text backgroundColor={(Math.floor(Date.now() / 1000) % 2 === 0) ? theme.primary : 'transparent'}> </Text>
        )}
        {state.currentInput.length === 0 && (
          <Text color={state.isThinking || state.telemetry.isStreaming ? theme.error : theme.dimText} dimColor>
            {state.isThinking || state.telemetry.isStreaming ? 'Press [Ctrl+X] to terminate' : 'Type your message...'}
          </Text>
        )}
      </Box>
      {(state.autocompleteState?.show && state.autocompleteState?.options?.length > 0) && (
        <Box flexDirection="column" marginTop={1} paddingLeft={2} borderStyle="single" borderLeft={true} borderRight={false} borderTop={false} borderBottom={false} borderColor={theme.border}>
          {state.autocompleteState.options.map((opt: any, i: number) => {
            const isSelected = i === state.autocompleteState.selectedIndex;
            return (
              <Box key={i}>
                <Text color={isSelected ? theme.primary : theme.dimText}>{isSelected ? '▶ ' : '  '}</Text>
                <Text color={isSelected ? theme.text : theme.dimText}>{opt.name} </Text>
                {opt.description && <Text color={theme.border} dimColor> - {opt.description}</Text>}
              </Box>
            );
          })}
        </Box>
      )}
    </Box>
  );
}
