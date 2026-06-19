import { ChildProcess } from 'child_process';
// @ts-ignore
import treeKill from 'tree-kill';

export interface BackgroundProcessInfo {
  pid: number;
  command: string;
  startTime: number;
  process: ChildProcess;
  threadId: string;
}

class BackgroundManager {
  private processes = new Map<number, BackgroundProcessInfo>();

  public addProcess(command: string, child: ChildProcess, threadId: string) {
    if (child.pid) {
      this.processes.set(child.pid, {
        pid: child.pid,
        command,
        startTime: Date.now(),
        process: child,
        threadId
      });

      child.on('exit', () => {
        this.removeProcess(child.pid!);
      });
      child.on('error', () => {
        this.removeProcess(child.pid!);
      });
    }
  }

  public removeProcess(pid: number) {
    this.processes.delete(pid);
  }

  public getProcesses(): BackgroundProcessInfo[] {
    return Array.from(this.processes.values()).sort((a, b) => b.startTime - a.startTime);
  }

  public killProcess(pid: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const procInfo = this.processes.get(pid);
      if (!procInfo) {
        resolve();
        return;
      }

      treeKill(pid, 'SIGKILL', (err) => {
        if (err) {
          reject(err);
        } else {
          this.removeProcess(pid);
          resolve();
        }
      });
    });
  }

  public async killAllForThread(threadId: string): Promise<void> {
    const threadProcs = Array.from(this.processes.values()).filter(p => p.threadId === threadId);
    for (const p of threadProcs) {
      try {
        await this.killProcess(p.pid);
      } catch (e) {
        // ignore errors on teardown
      }
    }
  }
}

export const backgroundManager = new BackgroundManager();
