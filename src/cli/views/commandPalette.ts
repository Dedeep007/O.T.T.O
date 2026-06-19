import { PhoneView, PhoneOS } from '../nav.js';
import chalk from 'chalk';
import { ui } from '../ui.js';
import { promptWithEscape } from '../prompt.js';

export function createCommandPaletteView(
  phone: PhoneOS,
  actions: { label: string; action: () => void }[]
): PhoneView {

  return {
    id: 'command_palette',
    title: 'Command Palette',
    subtitle: 'Search and execute actions globally',
    options: [
      {
        label: chalk.green('🔍 Search Commands...'),
        action: async () => {
          phone.active = false;
          ui.clearScreen();
          const q = await promptWithEscape('Search:');
          if (q === null) {
            phone.active = true;
            phone.render();
            return;
          }
          const filtered = actions.filter(a => a.label.toLowerCase().includes(q.toLowerCase()));
          phone.active = true;
          phone.pushView({
            id: 'cmd_results',
            title: `Results for "${q}"`,
            options: [
              ...filtered,
              { label: 'Go Back', action: () => phone.goBack() }
            ]
          });
        }
      },
      ...actions,
      { label: 'Go Back', action: () => phone.goBack() }
    ]
  };
}
