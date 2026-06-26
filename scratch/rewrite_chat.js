const fs = require('fs');
let code = fs.readFileSync('src/cli/chat.tsx', 'utf-8');

// Replace renderDiffBlock
code = code.replace(/function renderDiffBlock[\s\S]*?return output \+ '\\n';\n}/, `function renderDiffBlock(codeStr: string, diffWidth: number, isExpanded: boolean): string {
  let output = '\\n';

  const row = (bg: string, fg: string, text: string) =>
    chalk.bgHex(bg).hex(fg)(padVisible(text, diffWidth));

  const allLines = codeStr.split('\\n');
  const total = allLines.length;

  let toRender = allLines;
  if (!isExpanded && total > 15) {
    const top = allLines.slice(0, 7);
    const bottom = allLines.slice(total - 3);
    toRender = [...top, \`... (\${total - 10} hidden lines) [Press Ctrl+E to Expand] ...\`, ...bottom];
  }

  toRender.forEach(line => {
    const maxLen = diffWidth;
    const subLines: string[] = [];
    let current = line;
    while (current.length > maxLen) {
      subLines.push(current.substring(0, maxLen));
      current = current.substring(maxLen);
    }
    subLines.push(current);

    subLines.forEach((sl, idx) => {
      let displayLine = sl;
      
      if (line.startsWith('+++') || line.startsWith('---')) {
        output += chalk.bgHex('#0d1929').hex('#888888')(padVisible(displayLine, diffWidth)) + '\\n';
      } else if (line.startsWith('@@')) {
        output += chalk.bgHex('#1a3a5c').hex('#4a9eff')(padVisible(displayLine, diffWidth)) + '\\n';
      } else if (line.startsWith('+')) {
        const textPart = padVisible(' ' + displayLine, diffWidth - 1);
        output += chalk.bgHex('#4ecc8a')(' ') + chalk.bgHex('#1a3d1a').hex('#4ecc8a')(textPart) + '\\n';
      } else if (line.startsWith('-')) {
        const textPart = padVisible(' ' + displayLine, diffWidth - 1);
        output += chalk.bgHex('#cc4e4e')(' ') + chalk.bgHex('#3d1515').hex('#ff6b6b')(textPart) + '\\n';
      } else if (line.startsWith('... (')) {
        output += chalk.bgHex('#0d1929').hex('#FBBF24')(padVisible(' ' + displayLine, diffWidth)) + '\\n';
      } else {
        output += chalk.bgHex('#0d1929').hex('#6a8a6a')(padVisible(' ' + displayLine, diffWidth)) + '\\n';
      }
    });
  });
  return output + '\\n';
}`);

// Replace renderMarkdownWithOttoStyles colors
code = code.replace(/#0F172A/g, '#0d1929');
code = code.replace(/#CBD5E1/g, '#888888');

// Replace drawToString implementation
const drawToStringReplacement = `drawToString(): string {
    if (!this.currentData) return '';
    this.W = process.stdout.columns || 80;
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

    messages.forEach((msg: any) => {
      if (msg.role === 'system') {
        push('  ' + chalk.bgHex('#2a2a2a').hex('#888888')(' SYSTEM ') + ' ' + chalk.hex('#555555')(msg.content));
        push('');
        push('');
        return;
      }

      if (msg.role === 'tool') {
        const rendered = renderMarkdownWithOttoStyles(msg.content, this.W, diffsExpanded);
        rendered.trim().split('\\n').forEach(line => push(line));
        push('');
        push('');
        return;
      }

      if (msg.role === 'user') {
        push('  ' + chalk.bgHex('#2a2a2a').hex('#888888')(' YOU '));
        push(''); 
        const rawContent = msg.content;
        const wrappedLines = wrapText(rawContent, this.W - 2, 2);
        wrappedLines.forEach(line => push(chalk.hex('#dddddd')(line)));
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
          let processedContent = rawContent.replace(/\`([^`]+)\`/g, (_m: any, p1: string) => chalk.hex('#f5c542')(p1));
          const rendered = renderMarkdownWithOttoStyles(processedContent, this.W, diffsExpanded);
          rendered.trim().split('\\n').forEach(line => {
             if (line.includes('\\x1B[48;2;13;25;41m')) { 
               push(line);
             } else {
               push('  ' + line);
             }
          });
        }
      }

      push('');
      push(''); 
    });

    if (delayMessage) {
      push('  ' + chalk.hex('#f5c542').bold('O.T.T.O'));
      push('');
      push('  ' + chalk.hex('#555555')(\`\${delayMessage}...\`));
      push('');
      push('');
    } else if (isThinking) {
      push('  ' + chalk.hex('#f5c542').bold('O.T.T.O'));
      push('');
      push('  ' + chalk.hex('#555555')('Thinking...'));
      push('');
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
  }`;

code = code.replace(/drawToString\(\): string \{[\s\S]*\}\s*export function translateInkKey/, drawToStringReplacement + '\n\nexport function translateInkKey');

fs.writeFileSync('src/cli/chat.tsx', code);
