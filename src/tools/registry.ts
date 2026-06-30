import { executeTerminalCommand, listBackgroundProcesses } from './builtin/terminal.js';
import { launchOsApp } from './builtin/os.js';
import { readBrowserAccessibility } from './builtin/browser.js';
import { searchCode, readFileLines, readFile, listDirectory, replaceFileLines, writeFile } from './builtin/fs.js';
import { readSkillTool } from './skill_tool.js';

export const tools = [
  searchCode,
  readFileLines,
  readFile,
  listDirectory,
  replaceFileLines,
  writeFile,
  executeTerminalCommand,
  launchOsApp,
  readBrowserAccessibility,
  listBackgroundProcesses,
  readSkillTool
];
