import React, { createContext, useContext, useState } from 'react';
import { Box, Text } from '../../ink-compat.js';
import { useTheme } from './ThemeContext.js';

export interface DialogProps {
  title: string;
  type: 'alert' | 'confirm' | 'prompt' | 'plan';
  content: React.ReactNode;
  onConfirm?: () => void;
  onCancel?: () => void;
}

interface DialogContextType {
  openDialog: (props: DialogProps) => void;
  closeDialog: () => void;
  activeDialog: DialogProps | null;
}

const DialogContext = createContext<DialogContextType | undefined>(undefined);

export function DialogProvider({ children }: { children: React.ReactNode }) {
  const [activeDialog, setActiveDialog] = useState<DialogProps | null>(null);

  const openDialog = (props: DialogProps) => setActiveDialog(props);
  const closeDialog = () => setActiveDialog(null);

  return (
    <DialogContext.Provider value={{ openDialog, closeDialog, activeDialog }}>
      {children}
    </DialogContext.Provider>
  );
}

export function useDialog() {
  const context = useContext(DialogContext);
  if (!context) {
    throw new Error('useDialog must be used within a DialogProvider');
  }
  return context;
}

export function DialogRenderer() {
  const { activeDialog } = useDialog();
  const theme = useTheme();

  if (!activeDialog) return null;

  return (
    <Box 
      flexDirection="column"
      padding={1}
      borderStyle="round"
      borderColor={theme.primary}
    >
      <Box marginBottom={1}>
        <Text bold color={theme.primary}>{activeDialog.title}</Text>
      </Box>
      <Box>
        {activeDialog.content}
      </Box>
    </Box>
  );
}
