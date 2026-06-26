const fs = require('fs');
let code = fs.readFileSync('src/cli/chat.tsx', 'utf-8');

const drawToStringStart = code.indexOf('drawToString(): string {');
const endMarker = 'export function translateInkKey';
const drawToStringEnd = code.indexOf(endMarker);

const newDrawToString = `drawToString(): string {
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
    const push = (line: string = '') => {
      lines.push(line);
    };

    push('');

    messages.forEach((msg: any) => {
      if (msg.role === 'system') {
        push('  ' + chalk.bgHex('#2a2a2a').hex('#888888')(' SYSTEM ') + ' ' + chalk.hex('#555555')(msg.content));
        push('');
        return;
      }

      if (msg.role === 'tool') {
        const rendered = renderMarkdownWithOttoStyles(msg.content, this.W, diffsExpanded);
        rendered.trim().split('\\n').forEach(line => push(line));
        push('');
        return;
      }

      if (msg.role === 'user') {
        push('  ' + chalk.bgHex('#2a2a2a').hex('#888888')(' YOU '));
        push(''); 
        const rawContent = msg.content;
        const wrappedLines = wrapText(rawContent, this.W - 4, 2);
        wrappedLines.forEach(line => push('  ' + chalk.hex('#dddddd')(line.trim())));
      } else {
        push('  ' + chalk.hex('#f5c542').bold('O.T.T.O'));
        push('');
        
        let rawContent = msg.content;
        const thinkMatch = rawContent.match(/<(?:think|thought)>([\\s\\S]*?)(?:<\\/(?:think|thought)>|$)/);
        if (thinkMatch) {
          rawContent = rawContent.replace(/<(?:think|thought)>[\\s\\S]*?(?:<\\/(?:think|thought)>|$)/, '').trim();
          const thinkLines = thinkMatch[1].trim().split('\\n');
          if (!diffsExpanded) {
            push('  ' + chalk.hex('#555555')(\`[ Reasoning Process (\${thinkLines.length} lines) - Press Ctrl+E to Expand ]\`));
          } else {
            thinkLines.forEach((l: string) => push('  ' + chalk.hex('#555555')(l)));
          }
          push('');
        }

        if (msg.content.includes('<think>') && !msg.content.includes('</think>')) {
          push('  ' + chalk.hex('#555555')('Thinking...'));
          push('');
        }

        if (rawContent.trim()) {
          const processedContent = rawContent.replace(/\`([^`]+)\`/g, (_m: any, p1: string) => chalk.hex('#f5c542')(p1));
          const rendered = renderMarkdownWithOttoStyles(processedContent, this.W, diffsExpanded);
          rendered.trim().split('\\n').forEach(line => {
             if (line.includes('\\x1B[48;2;13;25;41m') || line.includes('\\x1B[48;5;17m')) { 
               push(line);
             } else {
               push('  ' + line);
             }
          });
        }
      }

      push('');
    });

    if (delayMessage) {
      push('  ' + chalk.hex('#f5c542').bold('O.T.T.O'));
      push('');
      push('  ' + chalk.hex('#555555')(\`\${delayMessage}...\`));
      push('');
    } else if (isThinking) {
      push('  ' + chalk.hex('#f5c542').bold('O.T.T.O'));
      push('');
      push('  ' + chalk.hex('#555555')('Thinking...'));
      push('');
    }

    if (pendingApproval) {
      push('  ' + chalk.bgHex('#2a2a2a').hex('#888888')(' SYSTEM ') + chalk.hex('#f5c542')(' SECURITY APPROVAL REQUIRED'));
      push('');
      push('  ' + chalk.hex('#bbbbbb')(\`The agent wants to \${pendingApproval.type === 'app' ? 'launch application' : 'execute command'}:\`));
      push('  ' + chalk.hex('#f5c542').bold(pendingApproval.commandStr));
      push('');
      const menuItems = [
        { label: 'Approve for now', color: chalk.hex('#4ecc8a') },
        { label: \`Approve always (whitelist '\${pendingApproval.cmd}')\`, color: chalk.hex('#4eccc8') },
        { label: 'Don\\'t approve', color: chalk.hex('#ff6b6b') },
      ];
      menuItems.forEach((item, idx) => {
        const isSelected = idx === approvalMenuIndex;
        const prefix = isSelected ? chalk.hex('#f5c542').bold(' > ') : '   ';
        const label = isSelected ? chalk.bgHex('#141414').hex('#f5c542').bold(item.label) : chalk.hex('#aaaaaa')(item.label);
        push('  ' + prefix + label);
      });
      push('');
    }

    if (pendingPlan) {
      push('  ' + chalk.bgHex('#2a2a2a').hex('#888888')(' SYSTEM ') + chalk.hex('#f5c542')(' PENDING PLAN'));
      push('');
      const menuItems = [
        { label: 'Approve - execute the plan', color: chalk.hex('#4ecc8a') },
        { label: 'Edit - request changes first', color: chalk.hex('#f5c542') },
        { label: 'Cancel - do not proceed', color: chalk.hex('#ff6b6b') },
      ];
      menuItems.forEach((item, idx) => {
        const isSelected = idx === planMenuIndex;
        const prefix = isSelected ? chalk.hex('#f5c542').bold(' > ') : '   ';
        const label = isSelected ? chalk.bgHex('#141414').hex('#f5c542').bold(item.label) : chalk.hex('#aaaaaa')(item.label);
        push('  ' + prefix + label);
      });
      push('');
    }

    if (this.totalContentLines > 0 && this.scrollOffset > 0) {
      const deltaLines = lines.length - this.totalContentLines;
      this.scrollOffset += deltaLines;
    }
    this.totalContentLines = lines.length;

    const viewH = Math.max(1, (process.stdout.rows || 24) - 2);
    const maxOffset = Math.max(0, lines.length - viewH);
    this.scrollOffset = Math.min(this.scrollOffset, maxOffset);

    const viewStart = maxOffset - this.scrollOffset;
    const visible = lines.slice(viewStart, viewStart + viewH);

    const linesAbove = viewStart;
    const linesBelow = this.scrollOffset;

    if (linesAbove > 0 && visible.length > 0) {
      visible[0] = chalk.hex('#555555')(\`↑ \${linesAbove} lines above \`) + chalk.hex('#666666')('(↑/↓ scroll  PgUp/PgDn page  End to snap)');
      visible.splice(1, 0, chalk.hex('#1a1a1a')('─'.repeat(this.W)));
    }
    if (linesBelow > 0 && visible.length > 1) {
      visible[visible.length - 1] = chalk.hex('#444444')(\`↓ \${linesBelow} lines below\`);
    }

    let outStr = '';
    for (const line of visible) {
      outStr += line + '\\x1B[K\\n';
    }

    const promptPrefix = chalk.bgHex('#0a0a0a').hex('#f5c542').bold(' > ');
    const isEditing = !isThinking && !pendingApproval && !pendingPlan && !delayMessage;
    const cursor = isEditing && (Math.floor(Date.now() / 1000) % 2 === 0) ? chalk.bgHex('#0a0a0a').hex('#f5c542')('█') : chalk.bgHex('#0a0a0a')(' ');
    
    let placeholder = '';
    if (currentInput.length === 0) {
      if (pendingApproval || pendingPlan) {
        placeholder = chalk.bgHex('#0a0a0a').hex('#444444')('↑↓ choose  ↵ confirm');
      } else {
        placeholder = chalk.bgHex('#0a0a0a').hex('#444444')('Type your message... (esc to menu)');
      }
    }
    
    const scrollHint = linesBelow > 0 ? chalk.bgHex('#0a0a0a').hex('#333333')('  [scrolled — End to return]') : '';

    outStr += chalk.bgHex('#0a0a0a')(padVisible(promptPrefix + chalk.white(currentInput) + cursor + placeholder + scrollHint, this.W));
    return outStr;
  }

`;

code = code.substring(0, drawToStringStart) + newDrawToString + code.substring(drawToStringEnd);

fs.writeFileSync('src/cli/chat.tsx', code);
