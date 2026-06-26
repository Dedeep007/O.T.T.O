import { PhoneView, PhoneOS } from '../nav.js';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { select } from '@inquirer/prompts';
import { ui } from '../ui.js';
import { promptWithEscape } from '../prompt.js';

interface Task {
  id: string;
  title: string;
  status: 'TODO' | 'IN PROGRESS' | 'DONE';
}

function getTasks(): Task[] {
  const p = path.resolve(process.cwd(), 'tasks.json');
  if (fs.existsSync(p)) {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {}
  }
  return [];
}

function saveTasks(tasks: Task[]) {
  const p = path.resolve(process.cwd(), 'tasks.json');
  fs.writeFileSync(p, JSON.stringify(tasks, null, 2));
}

export function createTaskBoardView(phone: PhoneOS): PhoneView {
  return {
    id: 'task_board',
    title: 'Task Master (Kanban)',
    subtitle: 'Visual Project Management',
    renderBody: () => {
      const tasks = getTasks();
      const todo = tasks.filter(t => t.status === 'TODO');
      const inprog = tasks.filter(t => t.status === 'IN PROGRESS');
      const done = tasks.filter(t => t.status === 'DONE');

      const W = 24; // Column width
      const formatCol = (title: string, color: any, items: Task[]) => {
        let str = color(`┌─ ${title.padEnd(W - 4, ' ')} ┐\n`);
        if (items.length === 0) {
          const paddedEmpty = 'Empty'.padEnd(W - 4, ' ');
          str += color(`│ `) + chalk.dim(paddedEmpty) + color(` │\n`);
        }
        items.forEach(t => {
          let truncTitle = t.title.length > W - 6 ? t.title.substring(0, W - 9) + '...' : t.title;
          const paddedText = ('● ' + truncTitle).padEnd(W - 4, ' ');
          str += color(`│ `) + chalk.white(paddedText) + color(` │\n`);
        });
        str += color(`└${'─'.repeat(W - 2)}┘`);
        return str.split('\n');
      };

      const c1 = formatCol('TODO', chalk.hex('#94a3b8'), todo);
      const c2 = formatCol('IN PROGRESS', chalk.hex('#F5C400'), inprog);
      const c3 = formatCol('DONE', chalk.hex('#4ade80'), done);

      const lines = Math.max(c1.length, c2.length, c3.length);
      for (let i = 0; i < lines; i++) {
        const l1 = c1[i] || ' '.repeat(W + 1);
        const l2 = c2[i] || ' '.repeat(W + 1);
        const l3 = c3[i] || ' '.repeat(W + 1);
        console.log(`  ${l1}  ${l2}  ${l3}`);
      }
    },
    options: [
      {
        label: 'Add New Task',
        action: async () => {
          phone.active = false;
          ui.clearScreen();
          const title = await promptWithEscape('Task Title:');
          if (title && title.trim()) {
            const tasks = getTasks();
            tasks.push({ id: Date.now().toString(), title: title.trim(), status: 'TODO' });
            saveTasks(tasks);
            ui.success('Task added.');
            await new Promise(r => setTimeout(r, 800));
          }
          phone.active = true;
          phone.render();
        }
      },
      {
        label: 'Manage Tasks',
        action: () => {
          const tasks = getTasks();
          if (tasks.length === 0) return;
          phone.pushView({
            id: 'task_manage',
            title: 'Manage Tasks',
            options: [
              ...tasks.map(t => ({
                label: `[${t.status}] ${t.title}`,
                action: async () => {
                  phone.active = false;
                  ui.clearScreen();
                  const act = await select({
                    message: `Action for "${t.title}":`,
                    choices: [
                      { name: 'Move to TODO', value: 'TODO' },
                      { name: 'Move to IN PROGRESS', value: 'IN PROGRESS' },
                      { name: 'Move to DONE', value: 'DONE' },
                      { name: 'Delete Task', value: 'DELETE' },
                      { name: 'Cancel', value: 'CANCEL' }
                    ]
                  });
                  if (act !== 'CANCEL') {
                    const latest = getTasks();
                    const idx = latest.findIndex(x => x.id === t.id);
                    if (idx >= 0) {
                      if (act === 'DELETE') {
                        latest.splice(idx, 1);
                        ui.success('Task deleted.');
                      } else {
                        latest[idx].status = act as any;
                        ui.success(`Moved to ${act}.`);
                      }
                      saveTasks(latest);
                      await new Promise(r => setTimeout(r, 800));
                    }
                  }
                  phone.active = true;
                  phone.goBack();
                }
              })),
              { label: 'Go Back', action: () => phone.goBack() }
            ]
          });
        }
      },
      { label: 'Go Back', action: () => phone.goBack() }
    ]
  };
}
