const fs = require('fs');

const file = 'src/cli/chat.tsx';
let content = fs.readFileSync(file, 'utf8');

const newDraw = `  // ── HELPER METHODS FOR CHAT UI ── //

  private renderUserMessage(msg: string): string[] {
    const lines: string[] = [];
    const wrapped = wrapText(msg.trim(), this.W - 10, 2);
    lines.push('  ' + chalk.bgHex('#1c1c1c').hex('#484848')(padVisible('you ', this.W - 4, true)));
    wrapped.forEach(line => {
      lines.push('  ' + chalk.bgHex('#1c1c1c').hex('#d4d4d4')(padVisible(line, this.W - 4, true)));
    });
    lines.push('  ' + chalk.bgHex('#1c1c1c')(' '.repeat(this.W - 4)));
    return lines;
  }

  private renderAgentMessage(msg: string, isThinking: boolean): string[] {
    const lines: string[] = [];
    const header = chalk.hex('#c9a800')('◆') + ' ' + chalk.hex('#7a6a1a')('otto');
    lines.push('  ' + chalk.bgHex('#161407')(padVisible(header, this.W - 4)));
    
    let rawContent = msg;
    const thinkMatch = rawContent.match(/<(?:think|thought)>([\\s\\S]*?)(?:<\\/(?:think|thought)>|$)/);
    if (thinkMatch) {
      rawContent = rawContent.replace(/<(?:think|thought)>[\\s\\S]*?(?:<\\/(?:think|thought)>|$)/, '').trim();
      const thinkLines = thinkMatch[1].trim().split('\\n');
      if (!this.currentData.diffsExpanded) {
        lines.push('  ' + chalk.bgHex('#161407').hex('#5a5040')(padVisible(\`[ Reasoning Process (\${thinkLines.length} lines) - Press Ctrl+E to Expand ]\`, this.W - 4)));
      } else {
        thinkLines.forEach((l: string) => lines.push('  ' + chalk.bgHex('#161407').hex('#5a5040')(padVisible(l, this.W - 4))));
      }
      lines.push('  ' + chalk.bgHex('#161407')(' '.repeat(this.W - 4)));
    }

    if (msg.includes('<think>') && !msg.includes('</think>')) {
      lines.push('  ' + chalk.bgHex('#161407').hex('#5a5040')(padVisible('Thinking...', this.W - 4)));
      lines.push('  ' + chalk.bgHex('#161407')(' '.repeat(this.W - 4)));
    }

    if (rawContent.trim()) {
      const processedContent = rawContent.replace(/\`([^\`]+)\`/g, (_m: any, p1: string) => chalk.hex('#c9a800')(p1));
      const rendered = renderMarkdownWithOttoStyles(processedContent, this.W - 8, this.currentData.diffsExpanded);
      rendered.trim().split('\\n').forEach(line => {
         if (line.includes('\\x1B[48;2;13;25;41m') || line.includes('\\x1B[48;5;17m')) { 
           lines.push(line);
         } else {
           lines.push('  ' + chalk.bgHex('#161407')(padVisible(line, this.W - 4)));
         }
      });
    }
    
    lines.push('  ' + chalk.bgHex('#161407')(' '.repeat(this.W - 4)));
    return lines;
  }

  private renderToolBlock(toolInfo: any): string[] {
    const lines: string[] = [];
    const statusLabel = toolInfo.status === 'running' ? chalk.bgHex('#1a1500').hex('#7a6a1a')(' ● running ') 
      : toolInfo.status === 'done' ? chalk.bgHex('#0a1a00').hex('#3d8a2a')(' ✓ done ') 
      : chalk.bgHex('#1a0a0a').hex('#8a3a3a')(' ✗ error ');
      
    const icon = toolInfo.status === 'error' ? '✗' : '⌕';
    const headerStr = chalk.bgHex('#1a1500').hex('#c9a800')(\` \${icon} \`) + ' ' + chalk.hex('#c9a800').bold(toolInfo.name);
    
    // Left border uses ▌ with gold color
    const lb = chalk.hex('#c9a800')('▌');
    
    // Calculate right padding for status
    const strippedHeader = stripAnsi(headerStr);
    const strippedStatus = stripAnsi(statusLabel);
    const headerPad = Math.max(0, this.W - 10 - strippedHeader.length - strippedStatus.length);
    
    lines.push('  ' + lb + chalk.bgHex('#0a0a0a')(headerStr + ' '.repeat(headerPad) + statusLabel + ' '));
    lines.push('  ' + lb + chalk.bgHex('#0a0a0a')(' '.repeat(this.W - 6)));

    if (toolInfo.args) {
      let argsStr = '';
      for (const [k, v] of Object.entries(toolInfo.args)) {
        let valStr = typeof v === 'object' ? JSON.stringify(v) : String(v);
        if (valStr.length > 50) valStr = valStr.slice(0, 50) + '...';
        argsStr += chalk.hex('#6a6040')(k + ': ') + chalk.hex('#c9a800')(\`"\${valStr}"  \`);
      }
      lines.push('  ' + lb + chalk.bgHex('#0a0a0a')(padVisible(argsStr, this.W - 7)));
    }
    
    if (toolInfo.status !== 'running' && toolInfo.rawOutput) {
      lines.push('  ' + lb + chalk.bgHex('#0a0a0a')(padVisible(chalk.hex('#2a2000')('─'.repeat(this.W - 10)), this.W - 7)));
      const label = toolInfo.status === 'error' ? chalk.hex('#8a3a3a')('ERROR') : chalk.hex('#3d3310')('OUTPUT');
      lines.push('  ' + lb + chalk.bgHex('#0a0a0a')(padVisible(label, this.W - 7)));
      
      const outLines = toolInfo.rawOutput.trim().split('\\n').slice(0, 10);
      outLines.forEach((l: string) => {
        let maxL = l.length > this.W - 10 ? l.slice(0, this.W - 10) + '...' : l;
        lines.push('  ' + lb + chalk.bgHex('#0a0a0a').hex('#7a6a3a')(padVisible(maxL, this.W - 7)));
      });
      if (toolInfo.rawOutput.trim().split('\\n').length > 10) {
        lines.push('  ' + lb + chalk.bgHex('#0a0a0a').hex('#5a5040')(padVisible('... (output truncated)', this.W - 7)));
      }
    }
    lines.push('  ' + lb + chalk.bgHex('#0a0a0a')(' '.repeat(this.W - 6)));
    return lines;
  }

  drawToString(): string {
    if (!this.currentData) return '';
    this.W = process.stdout.columns ? Math.max(Math.min(process.stdout.columns, 120), 60) : 72;
    const {
      messages,
      currentInput,
      telemetry,
      model,
      isThinking,
      pendingPlan,
      planMenuIndex,
      diffsExpanded,
      delayMessage,
      pendingApproval,
      approvalMenuIndex
    } = this.currentData;

    const lines: string[] = [];
    const push = (line: string = '') => lines.push(line);

    // ── Session Bar ──
    const sessionStr = chalk.hex('#2d6a1a')('●') + chalk.hex('#333333')(' active session  ') + 
                       chalk.hex('#333333')(\`model: \${model}  tokens: \${telemetry.ctxUsed}\`);
    push('  ' + sessionStr);
    push('  ' + chalk.hex('#1a1a1a')('─'.repeat(this.W - 4)));
    push('');

    let inChatSection = false;

    messages.forEach((msg: any) => {
      if (msg.role === 'system') {
        push('  ' + chalk.hex('#444444')('SYSTEM'));
        push('  ' + chalk.hex('#555555')(msg.content));
        push('');
        return;
      }

      if (msg.role === 'tool') {
        if (!inChatSection) {
          push('  ' + chalk.hex('#444444').bold('⚙ TOOL CALLS'));
          inChatSection = true;
        }
        if (msg.toolInfo) {
          this.renderToolBlock(msg.toolInfo).forEach(l => push(l));
        } else {
          push('  ' + chalk.hex('#555555')('Tool: ' + msg.content.substring(0, 50)));
        }
        push('');
        return;
      }
      
      if (msg.toolCalls && msg.toolCalls.length > 0 && msg.state === 'tools') {
        // Pending running tools
        if (!inChatSection) {
          push('  ' + chalk.hex('#444444').bold('⚙ TOOL CALLS'));
          inChatSection = true;
        }
        msg.toolCalls.forEach((tc: any) => {
          this.renderToolBlock({ name: tc.name, args: tc.args, status: 'running' }).forEach(l => push(l));
          push('');
        });
      }

      if (msg.role === 'user') {
        if (!inChatSection) {
          push('  ' + chalk.hex('#444444').bold('💬 CHAT'));
          inChatSection = true;
        }
        this.renderUserMessage(msg.content).forEach(l => push(l));
      } else if (msg.role === 'ai') {
        if (!inChatSection) {
          push('  ' + chalk.hex('#444444').bold('💬 CHAT'));
          inChatSection = true;
        }
        this.renderAgentMessage(msg.content, isThinking).forEach(l => push(l));
      }

      push('');
    });

    if (delayMessage) {
      this.renderAgentMessage(delayMessage + '...', isThinking).forEach(l => push(l));
      push('');
    } else if (isThinking) {
      this.renderAgentMessage('<think>Thinking...</think>', true).forEach(l => push(l));
      push('');
    }

    if (pendingApproval) {
      push('  ' + chalk.hex('#444444').bold('⚠ COMMAND APPROVAL'));
      push('  ' + chalk.bgHex('#0a0a0a')(padVisible(chalk.hex('#c9a800')(' ⚡ run bash command') + chalk.hex('#4a4020')('  requires approval'), this.W - 4)));
      push('  ' + chalk.bgHex('#080800')(padVisible(chalk.hex('#3d3310')(' COMMAND: ') + chalk.hex('#e0c040')(pendingApproval.commandStr), this.W - 4)));
      push('  ' + chalk.bgHex('#0a0a0a')(padVisible(chalk.hex('#5a5040')(' Ensure this command is safe to run.'), this.W - 4)));
      push('  ' + chalk.bgHex('#0a0a0a')(' '.repeat(this.W - 4)));
      const menuItems = [
        { label: 'allow for now', key: 'y' },
        { label: 'allow always', key: 'a' },
        { label: 'reject', key: 'n' },
      ];
      let actions = '   ';
      menuItems.forEach((item, idx) => {
        const isSelected = idx === approvalMenuIndex;
        if (isSelected) {
          actions += chalk.bgHex('#1e1800').hex('#c9a800')(\` > [\${item.key}] \${item.label} \`) + '  ';
        } else {
          actions += chalk.hex('#555555')(\` [\${item.key}] \${item.label} \`) + '  ';
        }
      });
      push('  ' + chalk.bgHex('#0a0a0a')(padVisible(actions, this.W - 4)));
      push('  ' + chalk.bgHex('#0a0a0a')(' '.repeat(this.W - 4)));
      push('');
    }

    if (pendingPlan) {
      push('  ' + chalk.hex('#444444').bold('📋 PLAN APPROVAL'));
      push('  ' + chalk.bgHex('#0a0a0a')(padVisible(chalk.hex('#c9a800')(' ◈ proposed plan ') + chalk.hex('#4a4020')(' review before executing'), this.W - 4)));
      push('  ' + chalk.bgHex('#0a0a0a')(' '.repeat(this.W - 4)));
      const menuItems = [
        { label: 'approve plan', key: '↵' },
        { label: 'edit plan', key: 'e' },
        { label: 'cancel', key: 'n' },
      ];
      let actions = '   ';
      menuItems.forEach((item, idx) => {
        const isSelected = idx === planMenuIndex;
        if (isSelected) {
          actions += chalk.bgHex('#1e1800').hex('#c9a800')(\` > [\${item.key}] \${item.label} \`) + '  ';
        } else {
          actions += chalk.hex('#555555')(\` [\${item.key}] \${item.label} \`) + '  ';
        }
      });
      push('  ' + chalk.bgHex('#0a0a0a')(padVisible(actions, this.W - 4)));
      push('  ' + chalk.bgHex('#0a0a0a')(' '.repeat(this.W - 4)));
      push('');
    }

    if (this.totalContentLines > 0 && this.scrollOffset > 0) {
      const deltaLines = lines.length - this.totalContentLines;
      this.scrollOffset += deltaLines;
    }
    this.totalContentLines = lines.length;

    const inputAreaHeight = 3; // input row + hints + ctx bar
    const viewH = Math.max(1, (process.stdout.rows || 24) - inputAreaHeight);
    const maxOffset = Math.max(0, lines.length - viewH);
    this.scrollOffset = Math.min(this.scrollOffset, maxOffset);

    const viewStart = maxOffset - this.scrollOffset;
    const visible = lines.slice(viewStart, viewStart + viewH);

    const linesAbove = viewStart;
    const linesBelow = this.scrollOffset;

    let outStr = '';
    for (const line of visible) {
      outStr += line + '\\x1B[K\\n';
    }

    // ── Message Input Box ──
    const promptPrefix = chalk.bgHex('#111000').hex('#c9a800')(' › ');
    const isEditing = !isThinking && !pendingApproval && !pendingPlan && !delayMessage;
    const cursor = isEditing && (Math.floor(Date.now() / 1000) % 2 === 0) ? chalk.bgHex('#c9a800').black(' ') : chalk.bgHex('#111000').black(' ');
    
    let placeholder = '';
    if (currentInput.length === 0) {
      if (pendingApproval || pendingPlan) {
        placeholder = chalk.bgHex('#111000').hex('#444444')('↑↓ choose  ↵ confirm');
      } else if (telemetry.isStreaming || isThinking) {
        placeholder = chalk.bgHex('#111000').hex('#ef4444')('Press [Ctrl+X] to terminate execution');
      } else {
        placeholder = chalk.bgHex('#111000').hex('#444444')('Type your message...');
      }
    } else if (currentInput.startsWith('/')) {
      const cmds = ['/plan', '/rewind', '/goal', '/grill-me', '/learn', '/schedule'];
      const match = cmds.find(c => c.startsWith(currentInput.toLowerCase()));
      if (match && match !== currentInput) {
        placeholder = chalk.bgHex('#111000').hex('#444444')(match.substring(currentInput.length) + '  [Tab to complete]');
      }
    } else if (/[@][^\\s]*$/.test(currentInput)) {
      try {
        const match = currentInput.match(/@([^\\s]*)$/);
        const prefix = match ? match[1] : '';
        let dir = '.';
        let filePrefix = prefix;
        if (prefix.includes('/') || prefix.includes('\\\\')) {
          const normalized = prefix.replace(/\\\\/g, '/');
          const lastSlash = normalized.lastIndexOf('/');
          dir = prefix.slice(0, lastSlash);
          filePrefix = prefix.slice(lastSlash + 1);
        }
        const fullDir = path.resolve(process.cwd(), dir);
        if (fs.existsSync(fullDir) && fs.statSync(fullDir).isDirectory()) {
          const entries = fs.readdirSync(fullDir, { withFileTypes: true })
            .filter((e: any) => {
              if (e.name.startsWith('.') && !filePrefix.startsWith('.')) return false;
              if (e.name === 'node_modules') return false;
              return e.name.toLowerCase().startsWith(filePrefix.toLowerCase());
            })
            .map((e: any) => e.isDirectory() ? e.name + '/' : e.name);
          if (entries.length > 0) {
            placeholder = chalk.bgHex('#111000').hex('#444444')('  [Tab to cycle: ' + entries.slice(0, 5).join(', ') + (entries.length > 5 ? '...' : '') + ']');
          }
        }
      } catch (e) {}
    }

    const scrollHint = linesBelow > 0 ? chalk.bgHex('#111000').hex('#444444')(' [scrolled - End to return]') : chalk.bgHex('#111000').hex('#2a2a2a')(' enter to send ');
    
    const inputTextStr = chalk.bgHex('#111000').hex('#d4d4d4')(currentInput);
    const boxContent = promptPrefix + inputTextStr + cursor + placeholder;
    const boxPad = Math.max(0, this.W - 4 - stripAnsi(boxContent).length - stripAnsi(scrollHint).length);
    const inputBox = '  ' + boxContent + chalk.bgHex('#111000')(' '.repeat(boxPad)) + scrollHint;
    
    outStr += '\\n' + inputBox + '\\x1B[K\\n';
    
    // ── Context Bar & Shortcuts ──
    const GOLD  = chalk.hex('#f5c542');
    const MUTED = chalk.hex('#555555');
    const DIM   = chalk.hex('#333333');
    
    const provStr = GOLD(model.split('-')[0] || 'provider');
    const ratio = telemetry.ctxMax > 0 ? Math.min(telemetry.ctxUsed / telemetry.ctxMax, 1) : 0;
    const fill = Math.round(ratio * 7);
    const ctxBar = (ratio > 0.75 ? chalk.hex('#ff6b6b') : GOLD)('■'.repeat(fill)) + DIM('■'.repeat(7 - fill));
    const ctxStr = MUTED('ctx ') + ctxBar;
    const secStr = MUTED('sec ') + GOLD('strict'); // Generic placeholder
    
    const ctxRow = \`  \${provStr}   \${ctxStr}   \${secStr}\`;
    
    const shortcuts = chalk.hex('#2a2a2a')(' ctrl+x: stop | ctrl+e: diff | esc: menu | @: context | /: cmd');
    const bottomPad = Math.max(0, this.W - stripAnsi(ctxRow).length - stripAnsi(shortcuts).length);
    
    outStr += ctxRow + ' '.repeat(bottomPad) + shortcuts + '\\x1B[K\\n';

    return outStr;
  }
`;

const regex = /drawToString\(\): string \{[\s\S]*?\}\n\}/;
if (regex.test(content)) {
  content = content.replace(regex, newDraw + '\n}');
  fs.writeFileSync(file, content, 'utf8');
  console.log('Successfully updated drawToString and added helpers!');
} else {
  console.log('Regex failed to match drawToString in chat.tsx');
}
