import React, { createContext, useContext, useState, useEffect } from 'react';

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
  id?: string;
}

export interface ChatTelemetry {
  ctxMax: number;
  ctxUsed: number;
  ramMB: number;
  showContextBar: boolean;
  isStreaming?: boolean;
}

export interface SessionState {
  messages: ChatMessage[];
  currentInput: string;
  telemetry: ChatTelemetry;
  model: string;
  isThinking: boolean;
  pendingPlan: boolean;
  planMenuIndex: number;
  diffsExpanded: boolean;
  delayMessage: string | null;
  pendingApproval: any | null;
  approvalMenuIndex: number;
  securityMode: string;
  autocompleteState: any | null;
}

interface SessionContextType {
  state: SessionState;
  updateState: (updates: Partial<SessionState>) => void;
}

const SessionContext = createContext<SessionContextType | undefined>(undefined);

export function SessionProvider({ children, externalState }: { children: React.ReactNode, externalState: SessionState }) {
  const [localState, setLocalState] = useState<SessionState>(externalState);

  // Sync with external state (e.g. ChatUI)
  useEffect(() => {
    setLocalState(externalState);
  }, [externalState]);

  const updateState = (updates: Partial<SessionState>) => {
    setLocalState(prev => ({ ...prev, ...updates }));
  };

  return (
    <SessionContext.Provider value={{ state: localState, updateState }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession() {
  const context = useContext(SessionContext);
  if (!context) {
    throw new Error('useSession must be used within a SessionProvider');
  }
  return context;
}
