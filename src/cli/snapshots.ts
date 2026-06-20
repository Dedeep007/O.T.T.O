import fs from 'fs';
import path from 'path';
import os from 'os';
import { captureWorkspaceSnapshot, restoreWorkspaceSnapshot } from './workspaceDiff.js';

const SNAPSHOTS_DIR = path.join(os.homedir(), '.otto', 'snapshots');

export const snapshotManager = {
  saveCheckpoint: (threadId: string, messageIndex: number) => {
    try {
      const snapshot = captureWorkspaceSnapshot();
      const dir = path.join(SNAPSHOTS_DIR, threadId, String(messageIndex));
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      const data: Record<string, string> = {};
      for (const [relPath, content] of snapshot.entries()) {
        data[relPath] = content;
      }
      fs.writeFileSync(path.join(dir, 'snapshot.json'), JSON.stringify(data), 'utf8');
    } catch (e: any) {
      // Ignore or log error
    }
  },

  restoreCheckpoint: (threadId: string, messageIndex: number) => {
    try {
      const dir = path.join(SNAPSHOTS_DIR, threadId, String(messageIndex));
      const snapFile = path.join(dir, 'snapshot.json');
      if (!fs.existsSync(snapFile)) return false;
      
      const raw = fs.readFileSync(snapFile, 'utf8');
      const data = JSON.parse(raw) as Record<string, string>;
      const snapshot = new Map<string, string>();
      for (const [relPath, content] of Object.entries(data)) {
        snapshot.set(relPath, content);
      }
      
      restoreWorkspaceSnapshot(snapshot);
      return true;
    } catch (e: any) {
      return false;
    }
  },

  deleteThreadSnapshots: (threadId: string) => {
    try {
      const dir = path.join(SNAPSHOTS_DIR, threadId);
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch (e) {}
  },

  deleteCheckpoint: (threadId: string, messageIndex: number) => {
    try {
      const dir = path.join(SNAPSHOTS_DIR, threadId, String(messageIndex));
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch (e) {}
  },

  clearAllSnapshots: () => {
    try {
      if (fs.existsSync(SNAPSHOTS_DIR)) {
        fs.rmSync(SNAPSHOTS_DIR, { recursive: true, force: true });
      }
    } catch (e) {}
  }
};
