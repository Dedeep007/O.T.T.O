import { ChildProcess } from 'child_process';
// @ts-ignore
import treeKill from 'tree-kill';

export interface BackgroundProcessInfo {
  pid: number;
  command: string;
  startTime: number;
  process: ChildProcess;
}

class BackgroundManager {
  private processes = new Map<number, BackgroundProcessInfo>();

  public addProcess(command: string, child: ChildProcess) {
    if (child.pid) {
      this.processes.set(child.pid, {
        pid: child.pid,
        command,
        startTime: Date.now(),
        process: child
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
}

export const backgroundManager = new BackgroundManager();
