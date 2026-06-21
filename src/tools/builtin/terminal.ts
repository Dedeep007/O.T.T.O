import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { executor } from '../../security/executor.js';
import { backgroundManager } from '../../security/background.js';
import { captureWorkspaceSnapshot, formatWorkspaceChanges } from '../../cli/workspaceDiff.js';

export const executeTerminalCommand = tool(
  async ({ command, background }: { command: string, background?: boolean }) => {
    try {
      const beforeSnapshot = background ? null : captureWorkspaceSnapshot();
      const res = await executor.executeCommand(command, background);
      const afterSnapshot = background ? null : captureWorkspaceSnapshot();
      const diffSummary = beforeSnapshot && afterSnapshot ? formatWorkspaceChanges(beforeSnapshot, afterSnapshot) : '';
      return diffSummary ? `${res}\n\n${diffSummary}` : res;
    } catch (e: any) {
      return `Error executing command: ${e.message}`;
    }
  },
  {
    name: "execute_terminal_command",
    description: "Executes a shell/terminal command natively on the user's OS from the current workspace directory. Use this for running build/test/compile commands. CRITICAL: Always check the exit code and stderr of the command to verify it succeeded. If starting a long-running server or watcher, set background: true. Do not use this to create or edit files; use write_file instead.",
    schema: z.object({
      command: z.string().describe("The exact shell command string to execute."),
      background: z.boolean().optional().describe("If true, starts the process in the background and returns a task ID immediately, without waiting for completion. The process will be tracked and visible to the user under 'Manage Terminal Sessions' on the Home screen."),
    }),
  }
);

export const listBackgroundProcesses = tool(
  async () => {
    try {
      const procs = backgroundManager.getProcesses();
      if (procs.length === 0) {
        return "No active background terminal processes running under O.T.T.O.";
      }
      return procs
        .map(p => `- PID ${p.pid}: ${p.command} (running for ${Math.round((Date.now() - p.startTime) / 1000)}s)`)
        .join('\n');
    } catch (e: any) {
      return `Error listing background processes: ${e.message}`;
    }
  },
  {
    name: "list_background_processes",
    description: "Lists all active background terminal sessions running under O.T.T.O, including their PIDs and start times.",
    schema: z.object({}),
  }
);
