import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { executor } from '../../security/executor.js';
import { formatWorkspaceChanges } from '../../cli/workspaceDiff.js';

const EXCLUDED_DIRS = new Set(['node_modules', 'dist', 'dist-bundle', 'build', '.git', '.agents', '.codex']);
const MAX_SEARCH_RESULTS = 40;
const MAX_LINE_READ = 240;

function resolveWorkspacePath(filePath: string): string {
  const root = process.cwd();
  const resolved = path.resolve(root, filePath);
  
  const logDir = path.resolve(os.tmpdir(), 'otto-cli-logs');
  if (resolved.toLowerCase().startsWith(logDir.toLowerCase())) {
    return resolved;
  }
  
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path escapes workspace: ${filePath}`);
  }
  return resolved;
}

function isExcludedPath(filePath: string): boolean {
  return filePath
    .split(/[\\/]+/)
    .some(part => EXCLUDED_DIRS.has(part));
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

function formatPathForDisplay(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function diffForSingleFile(filePath: string, before: string | undefined, after: string | undefined): string {
  const normalized = filePath.replace(/\\/g, '/');
  const beforeMap = new Map<string, string>();
  const afterMap = new Map<string, string>();
  if (before !== undefined) beforeMap.set(normalized, before);
  if (after !== undefined) afterMap.set(normalized, after);
  return formatWorkspaceChanges(beforeMap, afterMap);
}

export const writeFile = tool(
  async ({ filePath, content }: { filePath: string; content: string }) => {
    try {
      const resolved = resolveWorkspacePath(filePath);
      const relative = path.relative(process.cwd(), resolved);
      const before = fs.existsSync(resolved) ? fs.readFileSync(resolved, 'utf8') : undefined;

      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, content, 'utf8');

      if (before !== content) {
        executor.clearAttempts();
      }

      const diff = diffForSingleFile(relative, before, content);
      return diff || `File written successfully. Content was already up to date (no changes needed) for ${relative.replace(/\\/g, '/')}.`;
    } catch (e: any) {
      return `Error writing file: ${e.message}`;
    }
  },
  {
    name: "write_file",
    description: "Creates or overwrites a workspace file with exact content. Use this for all code edits and file creation instead of terminal redirection, echo, Set-Content, heredocs, or shell metacharacters. Return concise results; the UI will show the diff.",
    schema: z.object({
      filePath: z.string().describe("Workspace-relative file path, for example print_primes.cpp."),
      content: z.union([z.string(), z.any()])
        .transform(v => typeof v === 'string' ? v : JSON.stringify(v, null, 2))
        .describe("The complete file content to write as a string."),
    }),
  }
);

export const searchCode = tool(
  async ({ query, dirPath = '.', caseSensitive = false }: { query: string; dirPath?: string; caseSensitive?: boolean }) => {
    try {
      const root = process.cwd();
      const startDir = resolveWorkspacePath(dirPath);
      if (!fs.statSync(startDir).isDirectory()) {
        return `Error searching code: ${formatPathForDisplay(path.relative(root, startDir))} is not a directory.`;
      }

      const results: string[] = [];
      const needle = caseSensitive ? query : query.toLowerCase();

      const walk = (dir: string) => {
        if (results.length >= MAX_SEARCH_RESULTS) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (results.length >= MAX_SEARCH_RESULTS) return;
          const fullPath = path.join(dir, entry.name);
          const relPath = formatPathForDisplay(path.relative(root, fullPath));
          if (isExcludedPath(relPath)) continue;

          if (entry.isDirectory()) {
            walk(fullPath);
            continue;
          }

          if (!entry.isFile() || !isLikelyTextFile(fullPath)) continue;
          const lines = fs.readFileSync(fullPath, 'utf8').split(/\r?\n/);
          lines.forEach((line, index) => {
            if (results.length >= MAX_SEARCH_RESULTS) return;
            const haystack = caseSensitive ? line : line.toLowerCase();
            if (haystack.includes(needle)) {
              results.push(`${relPath}:${index + 1}: ${line.trim()}`);
            }
          });
        }
      };

      walk(startDir);
      return results.length
        ? results.join('\n')
        : `No matches for "${query}" under ${formatPathForDisplay(path.relative(root, startDir)) || '.'}.`;
    } catch (e: any) {
      return `Error searching code: ${e.message}`;
    }
  },
  {
    name: "search_code",
    description: "Searches text/code inside the current workspace and returns file:line matches. Use this first to find the function, class, setting, or text to edit before reading files.",
    schema: z.object({
      query: z.string().describe("Plain text to search for, for example createSettingsView or function name."),
      dirPath: z.string().optional().describe("Workspace-relative directory to search, default is workspace root."),
      caseSensitive: z.boolean().optional().describe("Whether matching should be case-sensitive."),
    }),
  }
);

export const readFileLines = tool(
  async ({ filePath, startLine = 1, endLine }: { filePath: string; startLine?: number; endLine?: number }) => {
    try {
      const resolved = resolveWorkspacePath(filePath);
      const relative = formatPathForDisplay(path.relative(process.cwd(), resolved));
      if (!fs.existsSync(resolved)) return `Error reading lines: ${relative} does not exist.`;
      if (fs.statSync(resolved).isDirectory()) return `Error reading lines: ${relative} is a directory.`;

      const lines = fs.readFileSync(resolved, 'utf8').split(/\r?\n/);
      const safeStart = Math.max(1, startLine ?? 1);
      const safeEnd = Math.min(lines.length, endLine ?? safeStart + 80);
      const cappedEnd = Math.min(safeEnd, safeStart + MAX_LINE_READ - 1);

      const body = lines
        .slice(safeStart - 1, cappedEnd)
        .map((line, index) => `${String(safeStart + index).padStart(5, ' ')} | ${line}`)
        .join('\n');

      const suffix = safeEnd > cappedEnd ? `\n... truncated at ${MAX_LINE_READ} lines ...` : '';
      return `File: ${relative} (${safeStart}-${cappedEnd} of ${lines.length})\n\`\`\`text\n${body}${suffix}\n\`\`\``;
    } catch (e: any) {
      return `Error reading lines: ${e.message}`;
    }
  },
  {
    name: "read_file_lines",
    description: "Reads a numbered line range from a workspace file. Prefer this over read_file after search_code finds the relevant function or block.",
    schema: z.object({
      filePath: z.string().describe("Workspace-relative file path, for example src/index.ts."),
      startLine: z.number().int().min(1).optional().describe("1-based first line to read."),
      endLine: z.number().int().min(1).optional().describe("1-based last line to read. The tool caps output to keep context small."),
    }),
  }
);

export const readFile = tool(
  async ({ filePath }: { filePath: string }) => {
    try {
      const resolved = resolveWorkspacePath(filePath);
      const relative = formatPathForDisplay(path.relative(process.cwd(), resolved));
      if (!fs.existsSync(resolved)) {
        return `Error reading file: ${relative} does not exist.`;
      }
      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) {
        return `Error reading file: ${relative} is a directory.`;
      }
      const content = fs.readFileSync(resolved, 'utf8');
      return `File: ${relative}\n\`\`\`text\n${content}\n\`\`\``;
    } catch (e: any) {
      return `Error reading file: ${e.message}`;
    }
  },
  {
    name: "read_file",
    description: "Reads a text file from the current workspace only. Use this to inspect code, configs, and prompts without leaving the project root.",
    schema: z.object({
      filePath: z.string().describe("Workspace-relative file path, for example src/index.ts."),
    }),
  }
);

export const replaceFileLines = tool(
  async ({ filePath, startLine, endLine, content }: { filePath: string; startLine: number; endLine: number; content: string }) => {
    try {
      const resolved = resolveWorkspacePath(filePath);
      const relative = path.relative(process.cwd(), resolved);
      if (!fs.existsSync(resolved)) return `Error replacing lines: ${formatPathForDisplay(relative)} does not exist.`;
      if (fs.statSync(resolved).isDirectory()) return `Error replacing lines: ${formatPathForDisplay(relative)} is a directory.`;

      const before = fs.readFileSync(resolved, 'utf8');
      const lines = before.split(/\r?\n/);
      const safeStart = Math.max(1, startLine);
      const safeEnd = Math.min(lines.length, endLine);
      if (safeStart > safeEnd + 1) {
        return `Error replacing lines: invalid range ${startLine}-${endLine}.`;
      }

      const replacement = content.length ? content.split(/\r?\n/) : [];
      const nextLines = [
        ...lines.slice(0, safeStart - 1),
        ...replacement,
        ...lines.slice(safeEnd)
      ];
      const after = nextLines.join('\n');
      fs.writeFileSync(resolved, after, 'utf8');

      const diff = diffForSingleFile(relative, before, after);
      return diff || `File modified successfully. Content was already up to date (no changes needed) for ${formatPathForDisplay(relative)}.`;
    } catch (e: any) {
      return `Error replacing lines: ${e.message}`;
    }
  },
  {
    name: "replace_file_lines",
    description: "Replaces an exact 1-based inclusive line range in a workspace file. CRITICAL: NEVER guess line numbers. ALWAYS use read_file_lines or search_code first to find the exact start and end line numbers before using this tool. Make small targeted edits rather than rewriting the whole file.",
    schema: z.object({
      filePath: z.string().describe("Workspace-relative file path, for example src/index.ts."),
      startLine: z.number().int().min(1).describe("1-based first line to replace."),
      endLine: z.number().int().min(1).describe("1-based last line to replace, inclusive."),
      content: z.union([z.string(), z.any()])
        .transform(v => typeof v === 'string' ? v : JSON.stringify(v, null, 2))
        .describe("Replacement text for the range. Use an empty string to delete the range."),
    }),
  }
);

export const listDirectory = tool(
  async ({ dirPath = '.', depth = 1 }: { dirPath?: string; depth?: number }) => {
    try {
      const resolved = resolveWorkspacePath(dirPath);
      const stat = fs.statSync(resolved);
      if (!stat.isDirectory()) {
        return `Error listing directory: ${formatPathForDisplay(path.relative(process.cwd(), resolved))} is not a directory.`;
      }

      const maxDepth = Math.max(0, Math.min(depth ?? 1, 3));
      const lines: string[] = [];

      const walk = (current: string, prefix: string, remainingDepth: number) => {
        const entries = fs.readdirSync(current, { withFileTypes: true })
          .filter(entry => !entry.name.startsWith('.git') && entry.name !== 'node_modules')
          .sort((a, b) => {
            if (a.isDirectory() && !b.isDirectory()) return -1;
            if (!a.isDirectory() && b.isDirectory()) return 1;
            return a.name.localeCompare(b.name);
          });

        entries.forEach((entry) => {
          const full = path.join(current, entry.name);
          const rel = formatPathForDisplay(path.relative(process.cwd(), full));
          lines.push(`${prefix}${entry.isDirectory() ? '[D]' : '[F]'} ${rel}`);
          if (entry.isDirectory() && remainingDepth > 0) {
            walk(full, `${prefix}  `, remainingDepth - 1);
          }
        });
      };

      walk(resolved, '', maxDepth);
      return lines.length ? lines.join('\n') : 'Directory is empty.';
    } catch (e: any) {
      return `Error listing directory: ${e.message}`;
    }
  },
  {
    name: "list_files",
    description: "Lists files and folders inside the current workspace only. Use this to inspect project structure before editing.",
    schema: z.object({
      dirPath: z.string().optional().describe("Workspace-relative directory path, default is the current workspace root."),
      depth: z.number().int().min(0).max(3).optional().describe("Optional recursion depth, capped at 3."),
    }),
  }
);
