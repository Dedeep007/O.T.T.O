import { AsyncLocalStorage } from 'async_hooks';

export const threadLocalStorage = new AsyncLocalStorage<string>();

export function getExecutingThreadId(): string | undefined {
  return threadLocalStorage.getStore();
}
