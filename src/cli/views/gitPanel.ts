import { PhoneView, PhoneOS } from '../nav.js';
import chalk from 'chalk';
import { execSync } from 'child_process';
import { ui } from '../ui.js';
import { promptWithEscape } from '../prompt.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function git(cmd: string): string {
  return execSync(`git ${cmd}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function isRepo(): boolean {
  try { git('rev-parse --git-dir'); return true; } catch { return false; }
}

function headHash(): string {
  try { return git('rev-parse --short HEAD'); } catch { return ''; }
}

// ── Git Graph renderer ────────────────────────────────────────────────────────

const BRANCH_COLORS = [
  '#56CFE1', // cyan
  '#9D4EDD', // purple
  '#22C55E', // green
  '#F59E0B', // amber
  '#EF4444', // red
  '#EC4899', // pink
  '#3B82F6', // blue
  '#F97316', // orange
  '#84CC16', // lime
  '#06B6D4', // teal
];

function colorizeGraph(raw: string): string[] {
  const lines = raw.split('\n');

  // Map: x-position of `*` → stable color index
  const posToColor = new Map<number, number>();
  let nextColor = 0;

  return lines.map(line => {
    if (!line) return '';

    // Split into graph portion (up to and including `*` or all of it if no `*`) and info
    const starIdx = line.indexOf('*');
    const graphRaw = starIdx >= 0 ? line.slice(0, starIdx + 1) : line;
    const infoRaw  = starIdx >= 0 ? line.slice(starIdx + 1)    : '';

    // Resolve (or assign) a color for the `*` at this x position
    let nodeColor = BRANCH_COLORS[0];
    if (starIdx >= 0) {
      if (!posToColor.has(starIdx)) {
        posToColor.set(starIdx, nextColor++ % BRANCH_COLORS.length);
      }
      nodeColor = BRANCH_COLORS[posToColor.get(starIdx)!];
    }

    // ── Colorize the graph portion ──────────────────────────────────────
    let coloredGraph = '';
    for (let i = 0; i < graphRaw.length; i++) {
      const ch = graphRaw[i];
      switch (ch) {
        case '*': {
          coloredGraph += chalk.hex(nodeColor).bold('●');
          break;
        }
        case '|': {
          // Use the color of the branch that owns this column, fall back to dim
          const col = posToColor.get(i);
          const c   = col !== undefined ? BRANCH_COLORS[col] : '#4B5563';
          coloredGraph += chalk.hex(c)('│');
          break;
        }
        case '/':
          coloredGraph += chalk.hex('#6B7280')('╱');
          break;
        case '\\':
          coloredGraph += chalk.hex('#6B7280')('╲');
          break;
        case '-':
          coloredGraph += chalk.hex('#374151')('─');
          break;
        case '_':
          coloredGraph += chalk.hex('#374151')('╌');
          break;
        default:
          coloredGraph += ch;
      }
    }

    // ── Colorize the info portion (hash  refs  message) ────────────────
    let coloredInfo = '';
    if (infoRaw) {
      const trimmed = infoRaw.replace(/^\s+/, '');
      // hash is always 7-10 hex chars at the start
      const m = trimmed.match(/^([0-9a-f]{5,12})\s+(.*)?$/s);
      if (m) {
        const hash    = m[1];
        const payload = m[2] ?? '';

        // Colorize everything inside (...) — branch refs / tags
        const coloredPayload = payload.replace(/\(([^)]*)\)/g, (_, inner) => {
          const parts = inner.split(', ').map((ref: string) => {
            if (ref.startsWith('HEAD ->')) {
              const b = ref.slice('HEAD -> '.length);
              return chalk.bold.white('HEAD') + chalk.dim(' → ') + chalk.hex('#22C55E').bold(b);
            }
            if (ref === 'HEAD') return chalk.bold.white('HEAD');
            if (ref.startsWith('tag:'))       return chalk.hex('#EC4899')(ref);
            if (ref.includes('/'))            return chalk.hex('#F59E0B')(ref); // remote refs
            return chalk.hex('#56CFE1')(ref); // local branches
          });
          return chalk.dim('(') + parts.join(chalk.dim(', ')) + chalk.dim(')');
        });

        // Remaining text after refs is the commit message
        // (payload may or may not have refs)
        const hasRefs = payload.includes('(');
        const msgPart = hasRefs
          ? coloredPayload.replace(/\(.*?\)\s*/g, m2 => m2) // keep already-colored refs
          : chalk.hex('#D1D5DB')(coloredPayload);

        coloredInfo = ' ' + chalk.hex('#F5C400')(hash) + ' ' +
          (hasRefs ? coloredPayload.replace(/^(\(.*?\))\s*/, (_, refs) =>
            refs + ' ' + chalk.hex('#D1D5DB')(payload.replace(/^\(.*?\)\s*/, ''))
          ) : chalk.hex('#D1D5DB')(payload));
      } else {
        coloredInfo = ' ' + chalk.hex('#4B5563')(infoRaw.trim());
      }
    }

    return coloredGraph + coloredInfo;
  });
}

// ── Graph view (paginated) ────────────────────────────────────────────────────

function createGitGraphView(phone: PhoneOS, page = 0): PhoneView {
  if (!isRepo()) {
    return {
      id: 'git_graph',
      title: 'Commit Graph',
      renderBody: () => { console.log('  ' + chalk.red('Not a git repository.')); },
      options: [{ label: 'Go Back', action: () => phone.goBack() }]
    };
  }

  // Fetch structured graph: each line has position-aware graph chars + hash + refs + subject
  let rawLines: string[] = [];
  try {
    const raw = git('log --graph --oneline --all --decorate 2>&1');
    rawLines = colorizeGraph(raw);
  } catch (e: any) {
    return {
      id: 'git_graph',
      title: 'Commit Graph',
      renderBody: () => { console.log('  ' + chalk.red('Error: ' + e.message)); },
      options: [{ label: 'Go Back', action: () => phone.goBack() }]
    };
  }

  const rows        = (process.stdout.rows || 30);
  const perPage     = Math.max(5, rows - 14); // header + options + padding
  const totalPages  = Math.max(1, Math.ceil(rawLines.length / perPage));
  const clampedPage = Math.max(0, Math.min(page, totalPages - 1));
  const start       = clampedPage * perPage;
  const slice       = rawLines.slice(start, start + perPage);

  const navOptions: PhoneView['options'] = [];

  if (clampedPage > 0) {
    navOptions.push({
      label: chalk.hex('#56CFE1')('↑ Older commits'),
      action: () => { phone.goBack(); phone.pushView(createGitGraphView(phone, clampedPage - 1)); }
    });
  }
  if (clampedPage < totalPages - 1) {
    navOptions.push({
      label: chalk.hex('#56CFE1')('↓ Newer commits'),
      action: () => { phone.goBack(); phone.pushView(createGitGraphView(phone, clampedPage + 1)); }
    });
  }
  navOptions.push({ label: 'Go Back', action: () => phone.goBack() });

  return {
    id: 'git_graph',
    title: 'Commit Graph',
    subtitle: `Page ${clampedPage + 1}/${totalPages}   ● = commit   ─── = branch   ╱╲ = merge/split`,
    renderBody: () => {
      // Legend bar
      console.log(
        '  ' +
        chalk.hex('#F5C400')('■') + chalk.hex('#6B7280')(' hash  ') +
        chalk.hex('#22C55E')('■') + chalk.hex('#6B7280')(' local-branch  ') +
        chalk.hex('#F59E0B')('■') + chalk.hex('#6B7280')(' remote  ') +
        chalk.hex('#EC4899')('■') + chalk.hex('#6B7280')(' tag')
      );
      console.log('  ' + chalk.hex('#374151')('─'.repeat(Math.min((process.stdout.columns || 80) - 4, 90))));
      console.log('');

      slice.forEach(line => {
        process.stdout.write('  ' + line + '\n');
      });

      if (rawLines.length === 0) {
        console.log('  ' + chalk.dim('No commits found.'));
      }
      console.log('');
    },
    options: navOptions
  };
}

// ── main export ───────────────────────────────────────────────────────────────

export function createGitPanelView(phone: PhoneOS): PhoneView {
  return {
    id: 'git_panel',
    title: 'Git Dashboard',
    subtitle: 'Version Control & Branches',
    renderBody: () => {
      if (!isRepo()) {
        console.log('  ' + chalk.red('Not a git repository or git is not installed.'));
        return;
      }
      try {
        const branch = git('branch --show-current') || git('rev-parse --abbrev-ref HEAD');
        const hash   = headHash();
        const ahead  = (() => { try { return git('rev-list --count @{u}..HEAD'); } catch { return '—'; } })();
        const behind = (() => { try { return git('rev-list --count HEAD..@{u}'); } catch { return '—'; } })();

        console.log(
          chalk.hex('#64748b')('  Branch: ') +
          chalk.green.bold(branch) +
          (hash ? chalk.hex('#64748b')(`  (${hash})`) : '')
        );
        console.log(
          chalk.hex('#64748b')('  Ahead: ') + chalk.yellow(ahead) +
          chalk.hex('#64748b')('   Behind: ') + chalk.cyan(behind)
        );
        console.log('');

        const status = git('status -s');
        if (!status) {
          console.log('  ' + chalk.dim('✔ Working tree clean.'));
        } else {
          console.log('  ' + chalk.white.bold('Changed Files'));
          status.split('\n').forEach(line => {
            const xy   = line.substring(0, 2);
            const file = line.substring(3);
            const index = xy[0];
            const work  = xy[1];

            const stageColor = (index === 'A' || index === 'M' || index === 'R' || index === 'C')
              ? chalk.green : index === 'D' ? chalk.red : chalk.hex('#6B7280');
            const workColor  = (work === 'M')
              ? chalk.yellow : work === 'D' ? chalk.red : work === '?' ? chalk.hex('#F59E0B') : chalk.hex('#6B7280');

            console.log(
              '    ' + stageColor(index) + workColor(work) +
              ' ' + chalk.white(file)
            );
          });
        }
        console.log('');
      } catch (e: any) {
        console.log('  ' + chalk.red('git error: ' + e.message));
      }
    },
    options: [
      // ── Commit Graph ───────────────────────────────────────────────────────
      {
        label: chalk.hex('#9D4EDD')('◈') + '  Commit Graph',
        description: 'Visual branch/commit history with colour-coded nodes',
        action: () => phone.pushView(createGitGraphView(phone, 0))
      },

      // ── Stage / Unstage ────────────────────────────────────────────────────
      {
        label: 'Stage / Unstage Files',
        description: 'Toggle staging for individual files',
        action: () => {
          if (!isRepo()) return;
          let statusStr = '';
          try { statusStr = git('status -s'); } catch { return; }
          if (!statusStr) { ui.success('Nothing to stage — working tree is clean.'); return; }

          const files = statusStr.split('\n').map(l => ({
            xy:   l.substring(0, 2),
            file: l.substring(3)
          }));

          phone.pushView({
            id: 'git_stage',
            title: 'Stage / Unstage',
            subtitle: 'Select a file to toggle its staged state',
            options: [
              ...files.map(f => {
                const index    = f.xy[0];
                const isStaged = index !== ' ' && index !== '?';
                const tag      = isStaged ? chalk.green('[staged]  ') : chalk.yellow('[unstaged]');
                return {
                  label: `${tag} ${f.file}`,
                  action: async () => {
                    phone.active = false;
                    ui.clearScreen();
                    try {
                      if (isStaged) {
                        git(`restore --staged -- "${f.file}"`);
                        ui.success(`Unstaged: ${f.file}`);
                      } else {
                        git(`add -- "${f.file}"`);
                        ui.success(`Staged: ${f.file}`);
                      }
                    } catch (e: any) {
                      ui.error(`Failed: ${e.message}`);
                    }
                    await new Promise(r => setTimeout(r, 700));
                    phone.active = true;
                    phone.goBack();
                    phone.pushView(createGitPanelView(phone));
                  }
                };
              }),
              {
                label: 'Stage All',
                action: async () => {
                  phone.active = false;
                  ui.clearScreen();
                  try { git('add -A'); ui.success('All files staged.'); } catch (e: any) { ui.error(e.message); }
                  await new Promise(r => setTimeout(r, 700));
                  phone.active = true;
                  phone.goBack();
                  phone.pushView(createGitPanelView(phone));
                }
              },
              { label: 'Go Back', action: () => phone.goBack() }
            ]
          });
        }
      },

      // ── Commit ────────────────────────────────────────────────────────────
      {
        label: 'Commit Staged Changes',
        description: 'Write a commit message and commit',
        action: async () => {
          if (!isRepo()) return;
          phone.active = false;
          ui.clearScreen();

          let staged = '';
          try { staged = git('diff --name-only --cached'); } catch { /* nothing staged */ }
          if (!staged) {
            ui.error('No staged changes. Stage files first.');
            await new Promise(r => setTimeout(r, 1200));
            phone.active = true;
            phone.render();
            return;
          }

          console.log(chalk.hex('#56CFE1')('Staged files:'));
          staged.split('\n').forEach(f => console.log('  ' + chalk.green('+') + ' ' + f));
          console.log('');

          const msg = await promptWithEscape('Commit message:');
          if (msg && msg.trim()) {
            try {
              git(`commit -m "${msg.trim().replace(/"/g, '\\"')}"`);
              ui.success(`Committed: "${msg.trim()}"`);
            } catch (e: any) {
              ui.error('Commit failed: ' + e.message);
            }
            await new Promise(r => setTimeout(r, 1200));
          }
          phone.active = true;
          phone.render();
        }
      },

      // ── Push ──────────────────────────────────────────────────────────────
      {
        label: 'Push to Remote',
        description: 'Push the current branch upstream',
        action: async () => {
          if (!isRepo()) return;
          phone.active = false;
          ui.clearScreen();
          try {
            const branch = git('branch --show-current');
            console.log(chalk.hex('#6B7280')(`Pushing ${branch} to origin…`));
            const out = execSync(`git push origin "${branch}"`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
            ui.success('Pushed successfully.\n' + out.trim());
          } catch (e: any) {
            ui.error('Push failed:\n' + e.message);
          }
          await new Promise(r => setTimeout(r, 1400));
          phone.active = true;
          phone.render();
        }
      },

      // ── Pull ──────────────────────────────────────────────────────────────
      {
        label: 'Pull from Remote',
        description: 'Fetch and merge upstream changes',
        action: async () => {
          if (!isRepo()) return;
          phone.active = false;
          ui.clearScreen();
          try {
            console.log(chalk.hex('#6B7280')('Pulling…'));
            const out = execSync('git pull', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
            ui.success('Pulled.\n' + out.trim());
          } catch (e: any) {
            ui.error('Pull failed:\n' + e.message);
          }
          await new Promise(r => setTimeout(r, 1400));
          phone.active = true;
          phone.render();
        }
      },

      // ── Branch ────────────────────────────────────────────────────────────
      {
        label: 'Switch / Create Branch',
        description: 'Checkout an existing branch or create a new one',
        action: async () => {
          if (!isRepo()) return;
          let branchList: string[] = [];
          try {
            branchList = git('branch --format=%(refname:short)').split('\n').filter(Boolean);
          } catch { return; }

          phone.pushView({
            id: 'git_branch',
            title: 'Switch Branch',
            subtitle: 'Select a branch or create a new one',
            options: [
              ...branchList.map(b => {
                let current = false;
                try { current = git('branch --show-current') === b; } catch {}
                return {
                  label: (current ? chalk.green('* ') : '  ') + b,
                  action: async () => {
                    if (current) return;
                    phone.active = false;
                    ui.clearScreen();
                    try {
                      git(`checkout "${b}"`);
                      ui.success(`Switched to ${b}`);
                    } catch (e: any) {
                      ui.error('Checkout failed: ' + e.message);
                    }
                    await new Promise(r => setTimeout(r, 800));
                    phone.active = true;
                    phone.goBack();
                    phone.pushView(createGitPanelView(phone));
                  }
                };
              }),
              {
                label: '+ Create New Branch',
                description: 'Create and immediately switch to a new branch',
                action: async () => {
                  phone.active = false;
                  ui.clearScreen();
                  const nb = await promptWithEscape('New branch name:');
                  if (nb && nb.trim()) {
                    try {
                      git(`checkout -b "${nb.trim()}"`);
                      ui.success(`Created and switched to ${nb.trim()}`);
                    } catch (e: any) {
                      ui.error('Failed: ' + e.message);
                    }
                    await new Promise(r => setTimeout(r, 900));
                  }
                  phone.active = true;
                  phone.goBack();
                  phone.pushView(createGitPanelView(phone));
                }
              },
              { label: 'Go Back', action: () => phone.goBack() }
            ]
          });
        }
      },

      // ── Stash ─────────────────────────────────────────────────────────────
      {
        label: 'Stash',
        description: 'Stash or pop changes',
        action: () => {
          if (!isRepo()) return;
          phone.pushView({
            id: 'git_stash',
            title: 'Stash',
            options: [
              {
                label: 'Stash Changes',
                description: 'git stash push',
                action: async () => {
                  phone.active = false;
                  ui.clearScreen();
                  const msg = await promptWithEscape('Stash message (optional):');
                  try {
                    if (msg && msg.trim()) {
                      git(`stash push -m "${msg.trim().replace(/"/g, '\\"')}"`);
                    } else {
                      git('stash push');
                    }
                    ui.success('Changes stashed.');
                  } catch (e: any) { ui.error(e.message); }
                  await new Promise(r => setTimeout(r, 900));
                  phone.active = true;
                  phone.goBack();
                  phone.pushView(createGitPanelView(phone));
                }
              },
              {
                label: 'Pop Latest Stash',
                description: 'git stash pop',
                action: async () => {
                  phone.active = false;
                  ui.clearScreen();
                  try { git('stash pop'); ui.success('Stash popped.'); }
                  catch (e: any) { ui.error(e.message); }
                  await new Promise(r => setTimeout(r, 900));
                  phone.active = true;
                  phone.goBack();
                  phone.pushView(createGitPanelView(phone));
                }
              },
              { label: 'Go Back', action: () => phone.goBack() }
            ]
          });
        }
      },

      { label: 'Go Back', action: () => phone.goBack() }
    ]
  };
}
