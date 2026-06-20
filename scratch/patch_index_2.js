import fs from 'fs';
import path from 'path';

const file = path.resolve('src/index.ts');
let content = fs.readFileSync(file, 'utf8');

const hasCrlf = content.includes('\r\n');
content = content.replace(/\r\n/g, '\n');

// 1. Add Mistral to Model Edit View options
const modelEditOld = `      {
        label: \`Ollama  \${Configurator.getActiveModel(config, 'ollama') ? '-> ' + Configurator.getActiveModel(config, 'ollama') : '(default: llama3)'}\`,
        description: 'e.g. llama3, mistral, phi3',
        action: async () => phone.pushView(createProviderModelView('ollama', 'Ollama', 'llama3', 'e.g. llama3, mistral, phi3'))
      },
    ]`;

const modelEditNew = `      {
        label: \`Ollama  \${Configurator.getActiveModel(config, 'ollama') ? '-> ' + Configurator.getActiveModel(config, 'ollama') : '(default: llama3)'}\`,
        description: 'e.g. llama3, mistral, phi3',
        action: async () => phone.pushView(createProviderModelView('ollama', 'Ollama', 'llama3', 'e.g. llama3, mistral, phi3'))
      },
      {
        label: \`Mistral  \${Configurator.getActiveModel(config, 'mistral') ? '-> ' + Configurator.getActiveModel(config, 'mistral') : '(default: mistral-large-latest)'}\`,
        description: 'e.g. mistral-large-latest, open-mixtral-8x22b, codestral-latest',
        action: async () => phone.pushView(createProviderModelView('mistral', 'Mistral', 'mistral-large-latest', 'e.g. mistral-large-latest, open-mixtral-8x22b, codestral-latest'))
      },
    ]`;

content = content.replace(modelEditOld, modelEditNew);

// 2. Add Mistral to API Keys Edit View options
const apiEditOld = `      {
        label: \`Gemini  \${Configurator.getApiKeys(config, 'gemini').length} key(s)\`,
        description: Configurator.getActiveApiKey(config, 'gemini') ? \`active: \${maskApiKey(Configurator.getActiveApiKey(config, 'gemini')!)}\` : 'no key',
        action: async () => phone.pushView(createProviderApiKeyView('gemini', 'Gemini'))
      },
      { label: 'Go Back', action: () => phone.goBack() }`;

const apiEditNew = `      {
        label: \`Gemini  \${Configurator.getApiKeys(config, 'gemini').length} key(s)\`,
        description: Configurator.getActiveApiKey(config, 'gemini') ? \`active: \${maskApiKey(Configurator.getActiveApiKey(config, 'gemini')!)}\` : 'no key',
        action: async () => phone.pushView(createProviderApiKeyView('gemini', 'Gemini'))
      },
      {
        label: \`Mistral  \${Configurator.getApiKeys(config, 'mistral').length} key(s)\`,
        description: Configurator.getActiveApiKey(config, 'mistral') ? \`active: \${maskApiKey(Configurator.getActiveApiKey(config, 'mistral')!)}\` : 'no key',
        action: async () => phone.pushView(createProviderApiKeyView('mistral', 'Mistral'))
      },
      { label: 'Go Back', action: () => phone.goBack() }`;

content = content.replace(apiEditOld, apiEditNew);

// 3. Add Mistral to Switch Provider View options
const providerEditOld = `      {
        label: \`Ollama (Local)  \${config.defaults.primaryProvider === 'ollama' ? '[active]' : ''}\`,
        description: Configurator.getActiveModel(config, 'ollama') ? \`model: \${Configurator.getActiveModel(config, 'ollama')}\` : 'model: llama3 (default)',
        action: async () => {
          config = Configurator.updatePrimaryProvider('ollama') || config;
          provider.setConfig(config);
          phone.updateConfig(config);
          ui.success('Switched to Ollama.');
          await new Promise(r => setTimeout(r, 1000));
          phone.goBack(); phone.pushView(createProviderView());
        }
      },
      { label: 'Go Back', action: () => phone.goBack() }`;

const providerEditNew = `      {
        label: \`Ollama (Local)  \${config.defaults.primaryProvider === 'ollama' ? '[active]' : ''}\`,
        description: Configurator.getActiveModel(config, 'ollama') ? \`model: \${Configurator.getActiveModel(config, 'ollama')}\` : 'model: llama3 (default)',
        action: async () => {
          config = Configurator.updatePrimaryProvider('ollama') || config;
          provider.setConfig(config);
          phone.updateConfig(config);
          ui.success('Switched to Ollama.');
          await new Promise(r => setTimeout(r, 1000));
          phone.goBack(); phone.pushView(createProviderView());
        }
      },
      {
        label: \`Mistral AI  \${config.defaults.primaryProvider === 'mistral' ? '[active]' : ''}  \${Configurator.getActiveApiKey(config, 'mistral') ? '' : '-- no key'}\`,
        description: Configurator.getActiveModel(config, 'mistral') ? \`model: \${Configurator.getActiveModel(config, 'mistral')}\` : 'model: mistral-large-latest (default)',
        action: async () => {
          if (!Configurator.getActiveApiKey(config, 'mistral')) {
            phone.active = false;
            ui.clearScreen();
            const key = await promptWithEscape('Enter API Key for Mistral:');
            if (key === null) {
              phone.active = true;
              phone.goBack();
              phone.pushView(createProviderView());
              return;
            }
            config = Configurator.updateApiKey('mistral', key) || config;
            phone.active = true;
          }
          config = Configurator.updatePrimaryProvider('mistral') || config;
          provider.setConfig(config);
          phone.updateConfig(config);
          ui.success('Switched to Mistral.');
          await new Promise(r => setTimeout(r, 1000));
          phone.goBack(); phone.pushView(createProviderView());
        }
      },
      { label: 'Go Back', action: () => phone.goBack() }`;

content = content.replace(providerEditOld, providerEditNew);

// 4. Update Edit Model Variant settings list selection menu in createProviderModelView
const editModelOptionOld = `        {
          label: 'Edit Model Variant',
          description: 'Rename a saved model without losing the active selection',
          action: () => phone.pushView({
            id: \`\${providerName}_model_edit_variant\`,
            title: \`Edit \${providerLabel} Model\`,
            options: [
              ...currentModels.map(model => ({
                label: model,
                action: async () => {
                  phone.active = false;
                  ui.clearScreen();
                  const nextName = await promptWithEscape(\`Rename \${model} to:\`, model);
                  if (nextName && nextName.trim() && nextName.trim() !== model) {
                    config = Configurator.renameModelVariant(providerName, model, nextName.trim()) || config;
                    provider.setConfig(config);
                    phone.updateConfig(config);
                    ui.success(\`Renamed \${model} to \${nextName.trim()}\`);
                    await new Promise(r => setTimeout(r, 800));
                  }
                  phone.active = true;
                  phone.goBack();
                  phone.goBack();
                  phone.pushView(createProviderModelView(providerName, providerLabel, defaultModel, examples));
                }
              })),
              { label: 'Go Back', action: () => phone.goBack() }
            ]
          })
        },`;

const editModelOptionNew = `        {
          label: 'Edit Model Variant Settings',
          description: 'Configure name and rate limits (RPM, RPD, TPM, TPD, etc.)',
          action: () => phone.pushView({
            id: \`\${providerName}_model_edit_variants_list\`,
            title: \`Edit \${providerLabel} Settings\`,
            options: [
              ...currentModels.map(model => ({
                label: model,
                action: () => phone.pushView(createModelVariantLimitsView(providerName, model, providerLabel, defaultModel, examples))
              })),
              { label: 'Go Back', action: () => phone.goBack() }
            ]
          })
        },`;

content = content.replace(editModelOptionOld, editModelOptionNew);

// 5. Add createModelVariantLimitsView right below createProviderModelView
const createProviderModelViewEnd = `        { label: 'Go Back', action: () => phone.goBack() }
      ]
    };
  };`;

const createModelVariantLimitsViewDef = `        { label: 'Go Back', action: () => phone.goBack() }
      ]
    };
  };

  const createModelVariantLimitsView = (
    providerName: ProviderName,
    model: string,
    providerLabel: string,
    defaultModel: string,
    examples: string
  ): PhoneView => {
    const limits = config.modelLimits?.[model] || {};
    return {
      id: \`model_limit_settings_\${model}\`,
      title: \`\${model} Settings\`,
      subtitle: \`Configure limits for \${model}\`,
      renderBody: () => {
        console.log(chalk.white.bold('  Current Limits (empty means unlimited)'));
        console.log(\`    RPM (Requests / min):  \\x1b[36m\${limits.rpm ?? 'unlimited'}\\x1b[0m\`);
        console.log(\`    RPD (Requests / day):  \\x1b[36m\${limits.rpd ?? 'unlimited'}\\x1b[0m\`);
        console.log(\`    TPM (Tokens / min):    \\x1b[36m\${limits.tpm ?? 'unlimited'}\\x1b[0m\`);
        console.log(\`    TPD (Tokens / day):    \\x1b[36m\${limits.tpd ?? 'unlimited'}\\x1b[0m\`);
        console.log(\`    ITPM (Input tk / min): \\x1b[36m\${limits.itpm ?? 'unlimited'}\\x1b[0m\`);
        console.log(\`    OTPM (Output tk / min):\\x1b[36m\${limits.otpm ?? 'unlimited'}\\x1b[0m\`);
        console.log('');
      },
      options: [
        {
          label: 'Rename Model Variant',
          description: 'Rename this model name',
          action: async () => {
            phone.active = false;
            ui.clearScreen();
            const nextName = await promptWithEscape(\`Rename \${model} to:\`, model);
            if (nextName && nextName.trim() && nextName.trim() !== model) {
              config = Configurator.renameModelVariant(providerName, model, nextName.trim()) || config;
              provider.setConfig(config);
              phone.updateConfig(config);
              ui.success(\`Renamed \${model} to \${nextName.trim()}\`);
              await new Promise(r => setTimeout(r, 800));
            }
            phone.active = true;
            phone.goBack();
            phone.goBack();
            phone.pushView(createModelVariantLimitsView(providerName, nextName && nextName.trim() ? nextName.trim() : model, providerLabel, defaultModel, examples));
          }
        },
        ...([
          { name: 'rpm', label: 'RPM (Requests per minute)' },
          { name: 'rpd', label: 'RPD (Requests per day)' },
          { name: 'tpm', label: 'TPM (Tokens per minute)' },
          { name: 'tpd', label: 'TPD (Tokens per day)' },
          { name: 'itpm', label: 'ITPM (Input tokens per minute)' },
          { name: 'otpm', label: 'OTPM (Output tokens per minute)' }
        ] as const).map(limitOpt => ({
          label: \`Edit \${limitOpt.label}  [\${limits[limitOpt.name] ?? 'none'}]\`,
          action: async () => {
            phone.active = false;
            ui.clearScreen();
            const entered = await promptWithEscape(
              \`Enter \${limitOpt.label} for \${model} (leave empty to disable):\`,
              limits[limitOpt.name] !== undefined ? String(limits[limitOpt.name]) : ''
            );
            if (entered !== null) {
              const val = entered.trim() ? parseInt(entered.trim(), 10) : undefined;
              config = Configurator.updateModelLimit(model, limitOpt.name, val) || config;
              provider.setConfig(config);
              phone.updateConfig(config);
              ui.success(\`Updated \${limitOpt.name} limit.\`);
              await new Promise(r => setTimeout(r, 800));
            }
            phone.active = true;
            phone.goBack();
            phone.pushView(createModelVariantLimitsView(providerName, model, providerLabel, defaultModel, examples));
          }
        })),
        {
          label: 'Go Back',
          action: () => {
            phone.goBack();
            phone.goBack();
            phone.pushView(createProviderModelView(providerName, providerLabel, defaultModel, examples));
          }
        }
      ]
    };
  };`;

content = content.replace(createProviderModelViewEnd, createModelVariantLimitsViewDef);

// 6. Update Delete Thread action to terminate background processes and filter pending approvals
content = content.replace(
  `                  {
                    label: chalk.red('Delete Thread'),
                    action: async () => {
                      phone.active = false;
                      ui.clearScreen();
                      dbManager.deleteThread(t.id);
                      chatSession.clearThreadMessages(t.id);
                      if (chatSession.threadId === t.id) {
                        chatSession.createFreshThread();
                        ui.success(\`Deleted \${t.displayName}. Started a fresh chat.\`);
                      } else {
                        ui.success(\`Deleted \${t.displayName}\`);
                      }
                      await new Promise(r => setTimeout(r, 600));
                      phone.active = true;
                      phone.goBack();
                      phone.goBack();
                      phone.pushView(createThreadsView());
                    }
                  },`,
  `                  {
                    label: chalk.red('Delete Thread'),
                    action: async () => {
                      phone.active = false;
                      ui.clearScreen();
                      await backgroundManager.killAllForThread(t.id);
                      chatSession.pendingApprovals = chatSession.pendingApprovals.filter(p => p.threadId !== t.id);
                      dbManager.deleteThread(t.id);
                      chatSession.clearThreadMessages(t.id);
                      if (chatSession.threadId === t.id) {
                        chatSession.createFreshThread();
                        ui.success(\`Deleted \${t.displayName}. Started a fresh chat.\`);
                      } else {
                        ui.success(\`Deleted \${t.displayName}\`);
                      }
                      await new Promise(r => setTimeout(r, 600));
                      phone.active = true;
                      phone.goBack();
                      phone.goBack();
                      phone.pushView(createThreadsView());
                    }
                  },`
);

// 7. Add Ctrl+K handler in chat view keypress loop
content = content.replace(
  `        } else if (key.name === 'escape') {
          cleanup();
          resolve();`,
  `        } else if (key.ctrl && key.name === 'k') {
          cleanup();
          phone.startListening();
          phone.pushView(createCommandPaletteView(phone, actions));
          return;
        } else if (key.name === 'escape') {
          cleanup();
          resolve();`
);

// 8. Update command palette action initialization and global ctrl+k handler setup
const commandPaletteActionInst = `      {
        label: 'Command Palette',
        description: 'Fuzzy search actions and files (Ctrl+K style)',
        action: () => phone.pushView(createCommandPaletteView(
           phone,
           () => phone.pushView(createSettingsView()),
           () => phone.pushView(createTaskBoardView(phone)),
           () => phone.pushView(createGitPanelView(phone)),
           () => phone.pushView(createFileTreeView(phone)),
           () => phone.pushView(createAnalyticsView())
        ))
      },`;

const commandPaletteActionNew = `      {
        label: 'Command Palette',
        description: 'Fuzzy search actions and files (Ctrl+K style)',
        action: () => phone.pushView(createCommandPaletteView(phone, actions))
      },`;

content = content.replace(commandPaletteActionInst, commandPaletteActionNew);

// Define global actions list and phone.registerCtrlKHandler right before phone.pushView(createHomeView())
const launchOSOld = `  // Launch OS
  phone.pushView(createHomeView());`;

const launchOSNew = `  const actions: any[] = [
    { label: 'Actions: Settings', action: () => phone.pushView(createSettingsView()) },
    { label: 'Actions: Task Master (Kanban)', action: () => phone.pushView(createTaskBoardView(phone)) },
    { label: 'Actions: Git Panel', action: () => phone.pushView(createGitPanelView(phone)) },
    { label: 'Navigate: File Tree', action: () => phone.pushView(createFileTreeView(phone)) },
    { label: 'Navigate: Analytics', action: () => phone.pushView(createAnalyticsView()) },
    { label: 'Settings: Profile (Username)', action: () => phone.pushView(createProfileView()) },
    { label: 'Settings: Max Threads Limit', action: () => phone.pushView(createMaxThreadsView()) },
    { label: 'Settings: Max Context Size', action: () => phone.pushView(createMaxCtxView()) },
    { label: 'Settings: API Keys Configuration', action: () => phone.pushView(createApiEditView()) },
    { label: 'Settings: Edit Models', action: () => phone.pushView(createModelEditView()) },
    { label: 'Settings: Allowed Tools & Commands', action: () => phone.pushView(createSecurityEditView()) },
    {
      label: 'Settings: Toggle Context Bar',
      action: async () => {
        const current = config.defaults.showContextBar !== false;
        config = Configurator.updateContextBar(!current) || config;
        phone.updateConfig(config);
        ui.success(\`Context Bar turned \${!current ? 'ON' : 'OFF'}\`);
        await new Promise(r => setTimeout(r, 800));
        phone.render();
      }
    },
    {
      label: 'Settings: Edit Ollama Base URL',
      action: async () => {
        phone.active = false;
        ui.clearScreen();
        const currentUrl = config.providers.ollama?.baseUrl || 'http://localhost:11434';
        const entered = await promptWithEscape(\`Enter new Ollama Base URL (current: \${currentUrl}):\`);
        if (entered !== null && entered.trim()) {
          config = Configurator.updateOllamaUrl(entered.trim()) || config;
          phone.updateConfig(config);
          ui.success(\`Ollama URL updated to \${entered.trim()}\`);
          await new Promise(r => setTimeout(r, 900));
        }
        phone.active = true;
        phone.render();
      }
    },
    { label: 'API Keys: Groq Keys', action: () => phone.pushView(createProviderApiKeyView('groq', 'Groq')) },
    { label: 'API Keys: OpenAI Keys', action: () => phone.pushView(createProviderApiKeyView('openai', 'OpenAI')) },
    { label: 'API Keys: Anthropic Keys', action: () => phone.pushView(createProviderApiKeyView('anthropic', 'Anthropic')) },
    { label: 'API Keys: Gemini Keys', action: () => phone.pushView(createProviderApiKeyView('gemini', 'Gemini')) },
    { label: 'API Keys: Mistral Keys', action: () => phone.pushView(createProviderApiKeyView('mistral', 'Mistral')) },
    { label: 'Models: Groq Model Variants', action: () => phone.pushView(createProviderModelView('groq', 'Groq', 'qwen-qwq-32b', 'e.g. qwen-qwq-32b')) },
    { label: 'Models: OpenAI Model Variants', action: () => phone.pushView(createProviderModelView('openai', 'OpenAI', 'gpt-4o', 'e.g. gpt-4o')) },
    { label: 'Models: Anthropic Model Variants', action: () => phone.pushView(createProviderModelView('anthropic', 'Anthropic', 'claude-3-5-sonnet-20241022', 'e.g. claude-3-5-sonnet-20241022')) },
    { label: 'Models: Gemini Model Variants', action: () => phone.pushView(createProviderModelView('gemini', 'Gemini', 'gemini-1.5-pro', 'e.g. gemini-1.5-pro')) },
    { label: 'Models: Ollama Model Variants', action: () => phone.pushView(createProviderModelView('ollama', 'Ollama', 'llama3', 'e.g. llama3')) },
    { label: 'Models: Mistral Model Variants', action: () => phone.pushView(createProviderModelView('mistral', 'Mistral', 'mistral-large-latest', 'e.g. mistral-large-latest')) }
  ];

  phone.registerCtrlKHandler(() => {
    const currentView = phone.history[phone.history.length - 1];
    if (currentView?.id === 'command_palette') return;
    phone.pushView(createCommandPaletteView(phone, actions));
  });

  // Launch OS
  phone.pushView(createHomeView());`;

content = content.replace(launchOSOld, launchOSNew);

fs.writeFileSync(file, hasCrlf ? content.replace(/\n/g, '\r\n') : content, 'utf8');
console.log('Successfully patched index.ts (part 2)');
