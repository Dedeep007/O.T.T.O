import React, { createContext, useContext } from 'react';

export interface ThemeColors {
  primary: string;
  primaryBg: string;
  secondary: string;
  secondaryBg: string;
  error: string;
  success: string;
  text: string;
  dimText: string;
  border: string;
}

export const defaultTheme: ThemeColors = {
  primary: '#f5c542',       // O.T.T.O Yellow
  primaryBg: '#161407',
  secondary: '#d4b43f',     // Darker Yellow
  secondaryBg: '#1a1500',
  error: '#ff5555',
  success: '#3d8a2a',       // Unused mostly, maybe keep for pure success
  text: '#ffffff',
  dimText: '#888888',
  border: '#2a2a2a',
};

const ThemeContext = createContext<ThemeColors>(defaultTheme);

export function ThemeProvider({ children, theme = defaultTheme }: { children: React.ReactNode, theme?: ThemeColors }) {
  return (
    <ThemeContext.Provider value={theme}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
