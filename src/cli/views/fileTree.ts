import { PhoneView, PhoneOS } from '../nav.js';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { ui } from '../ui.js';
import { promptWithEscape } from '../prompt.js';

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

function createFilePreviewView(phone: PhoneOS, filePath: string): PhoneView {
  const fileName = path.basename(filePath);

  return {
    id: 'file_preview_' + filePath,
    title: 'File Preview',
    subtitle: filePath,
    renderBody: () => {
      try {
        if (!isLikelyTextFile(filePath)) {
          console.log('  ' + chalk.red('Cannot preview binary file.'));
          return;
        }

        const allLines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
        const previewLines = allLines.slice(0, 20);
        const lineNoWidth = String(Math.min(allLines.length, 20)).length;

        console.log(chalk.yellow(`  --- ${fileName} first 20 lines ---`));
        console.log('');
        previewLines.forEach((line, index) => {
          const lineNo = String(index + 1).padStart(lineNoWidth, ' ');
          console.log('  ' + chalk.dim(lineNo + ' | ') + chalk.white(line));
        });

        if (allLines.length > 20) {
          console.log('');
          console.log('  ' + chalk.dim(`... truncated, ${allLines.length - 20} more lines`));
        }
      } catch {
        console.log('  ' + chalk.red('Cannot read file.'));
      }
      console.log('');
    },
    options: [
      { label: 'Go Back', action: () => phone.goBack() }
    ]
  };
}

export function createFileTreeView(phone: PhoneOS, dir?: string): PhoneView {
  const currentDir = dir || process.cwd();
  
  let items: string[] = [];
  try {
    items = fs.readdirSync(currentDir).filter(n => !n.startsWith('.git') && n !== 'node_modules');
  } catch (e) {}
  
  items.sort((a, b) => {
    try {
      const aDir = fs.statSync(path.join(currentDir, a)).isDirectory();
      const bDir = fs.statSync(path.join(currentDir, b)).isDirectory();
      if (aDir && !bDir) return -1;
      if (!aDir && bDir) return 1;
    } catch(e) {}
    return a.localeCompare(b);
  });
  
  return {
    id: 'file_tree_' + currentDir,
    title: 'Project Explorer',
    subtitle: 'Visual Project File Management',
    renderBody: () => {
      console.log(chalk.hex('#64748b')('  Directory: ') + chalk.white.bold(currentDir));
      console.log('');
    },
    options: [
      ...items.map(item => {
        const p = path.join(currentDir, item);
        let isDir = false;
        try { isDir = fs.statSync(p).isDirectory(); } catch(e){}
        return {
          label: isDir ? chalk.blue.bold(`📁 ${item}/`) : chalk.white(`📄 ${item}`),
          action: async () => {
            if (isDir) {
              phone.pushView(createFileTreeView(phone, p));
            } else {
              phone.pushView({
                id: 'file_actions',
                title: 'File Actions',
                subtitle: p,
                options: [
                  {
                    label: 'View Content (first 20 lines)',
                    action: () => phone.pushView(createFilePreviewView(phone, p))
                  },
                  {
                    label: chalk.red('Delete File'),
                    action: async () => {
                       phone.active = false;
                       ui.clearScreen();
                       try { fs.unlinkSync(p); ui.success('Deleted.'); } catch(e) {}
                       await new Promise(r => setTimeout(r, 800));
                       phone.active = true;
                       phone.goBack();
                       phone.goBack();
                       phone.pushView(createFileTreeView(phone, currentDir));
                    }
                  },
                  { label: 'Cancel', action: () => phone.goBack() }
                ]
              });
            }
          }
        };
      }),
      {
        label: chalk.green('+ Create File'),
        action: async () => {
           phone.active = false;
           ui.clearScreen();
           const name = await promptWithEscape('New file name:');
           if (name && name.trim()) {
             try { fs.writeFileSync(path.join(currentDir, name.trim()), ''); ui.success('Created.'); } catch(e) {}
             await new Promise(r => setTimeout(r, 800));
           }
           phone.active = true;
           phone.goBack();
           phone.pushView(createFileTreeView(phone, currentDir));
        }
      },
      {
        label: chalk.green('+ Create Folder'),
        action: async () => {
           phone.active = false;
           ui.clearScreen();
           const name = await promptWithEscape('New folder name:');
           if (name && name.trim()) {
             try { fs.mkdirSync(path.join(currentDir, name.trim())); ui.success('Created.'); } catch(e) {}
             await new Promise(r => setTimeout(r, 800));
           }
           phone.active = true;
           phone.goBack();
           phone.pushView(createFileTreeView(phone, currentDir));
        }
      },
      { label: 'Go Back', action: () => phone.goBack() }
    ]
  };
}
