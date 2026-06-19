import fs from 'fs';
import path from 'path';

type Snapshot = Map<string, string>;

const EXCLUDED_DIRS = new Set([
  'node_modules',
  'dist',
  'dist-bundle',
  'build',
  '.git',
  '.agents',
  '.codex'
]);

const MAX_FILE_SIZE = 200_000;
const MAX_PREVIEW_FILES = 4;
const CONTEXT_LINES = 2;

function shouldSkipDir(dirName: string): boolean {
  return EXCLUDED_DIRS.has(dirName);
}

function isLikelyTextFile(filePath: string): boolean {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(512);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    fs.closeSync(fd);
    for (let i = 0; i < bytesRead; i++) {
      if (buffer[i] === 0) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function walk(dir: string, root: string, snapshot: Snapshot) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (shouldSkipDir(entry.name)) continue;
      walk(path.join(dir, entry.name), root, snapshot);
      continue;
    }

    const fullPath = path.join(dir, entry.name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }

    if (stat.size > MAX_FILE_SIZE || !isLikelyTextFile(fullPath)) continue;

    try {
      const relPath = path.relative(root, fullPath).replace(/\\/g, '/');
      snapshot.set(relPath, fs.readFileSync(fullPath, 'utf8'));
    } catch {
      continue;
    }
  }
}

export function captureWorkspaceSnapshot(root: string = process.cwd()): Snapshot {
  const snapshot: Snapshot = new Map();
  walk(root, root, snapshot);
  return snapshot;
}

function createModifiedDiff(relPath: string, beforeContent: string, afterContent: string): string {
  const beforeLines = beforeContent.split('\n');
  const afterLines = afterContent.split('\n');

  let firstDiff = 0;
  while (
    firstDiff < beforeLines.length &&
    firstDiff < afterLines.length &&
    beforeLines[firstDiff] === afterLines[firstDiff]
  ) {
    firstDiff++;
  }

  let beforeEnd = beforeLines.length - 1;
  let afterEnd = afterLines.length - 1;
  while (
    beforeEnd >= firstDiff &&
    afterEnd >= firstDiff &&
    beforeLines[beforeEnd] === afterLines[afterEnd]
  ) {
    beforeEnd--;
    afterEnd--;
  }

  const start = Math.max(0, firstDiff - CONTEXT_LINES);
  const beforeStop = Math.min(beforeLines.length, beforeEnd + CONTEXT_LINES + 1);
  const afterStop = Math.min(afterLines.length, afterEnd + CONTEXT_LINES + 1);

  const diffLines: string[] = [
    `--- ${relPath}`,
    `+++ ${relPath}`,
    '@@'
  ];

  for (let i = start; i < firstDiff; i++) diffLines.push(` ${beforeLines[i]}`);
  for (let i = firstDiff; i < beforeEnd + 1; i++) diffLines.push(`-${beforeLines[i]}`);
  for (let i = firstDiff; i < afterEnd + 1; i++) diffLines.push(`+${afterLines[i]}`);

  const suffixStart = Math.max(firstDiff, Math.max(beforeEnd + 1, afterEnd + 1));
  const suffixEnd = Math.max(beforeStop, afterStop);
  for (let i = suffixStart; i < suffixEnd; i++) {
    const line = afterLines[i] ?? beforeLines[i];
    if (line !== undefined) diffLines.push(` ${line}`);
  }

  return diffLines.join('\n');
}

function createNewFileDiff(relPath: string, content: string): string {
  const lines = content.split('\n').slice(0, 500);
  return [
    `--- /dev/null`,
    `+++ ${relPath}`,
    '@@',
    ...lines.map(line => `+${line}`)
  ].join('\n');
}

function createDeletedFileDiff(relPath: string, content: string): string {
  const lines = content.split('\n').slice(0, 500);
  return [
    `--- ${relPath}`,
    `+++ /dev/null`,
    '@@',
    ...lines.map(line => `-${line}`)
  ].join('\n');
}

export function formatWorkspaceChanges(before: Snapshot, after: Snapshot): string {
  const changes: string[] = [];
  const seen = new Set<string>([...before.keys(), ...after.keys()]);

  for (const relPath of Array.from(seen).sort()) {
    const prev = before.get(relPath);
    const next = after.get(relPath);
    if (prev === next) continue;

    if (changes.length >= MAX_PREVIEW_FILES) break;

    if (prev !== undefined && next !== undefined) {
      changes.push(`Edited file: ${relPath}\n\`\`\`diff\n${createModifiedDiff(relPath, prev, next)}\n\`\`\``);
    } else if (next !== undefined) {
      changes.push(`Created file: ${relPath}\n\`\`\`diff\n${createNewFileDiff(relPath, next)}\n\`\`\``);
    } else if (prev !== undefined) {
      changes.push(`Deleted file: ${relPath}\n\`\`\`diff\n${createDeletedFileDiff(relPath, prev)}\n\`\`\``);
    }
  }

  return changes.join('\n\n');
}
