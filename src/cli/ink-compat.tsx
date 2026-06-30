import React from 'react';
import { Box as InkBox, Text as InkText, useInput as useInkInput, useApp as useInkApp } from 'ink';

export function Box(props: any) {
  return <InkBox {...props} />;
}

export function Text(props: any) {
  const { dimColor, ...rest } = props;
  if (dimColor) {
    return <InkText color="gray" {...rest} />;
  }
  return <InkText {...rest} />;
}

export function useInput(handler: (input: string, key: any) => void) {
  useInkInput(handler);
}

export function useApp() {
  return useInkApp();
}
