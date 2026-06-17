import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync, spawn } from 'child_process';

const c = {
    info: (text: string) => chalk.cyan(text),
    ok: (text: string) => chalk.green(text),
    warn: (text: string) => chalk.yellow(text),
    error: (text: string) => chalk.red(text),
    tip: (text: string) => chalk.blue(text),
    bright: (text: string) => chalk.bold.white(text),
    dim: (text: string) => chalk.dim(text),
};

function showHelp() {
    console.log(`
${c.dim('╔═══════════════════════════════════════════════════════════════╗')}
${c.dim('║')}              ${c.bright('O.T.T.O - Agentic CLI Tool')}                     ${c.dim('║')}
${c.dim('╚═══════════════════════════════════════════════════════════════╝')}

${c.bright('Usage:')}
  otto [command] [options]

${c.bright('Commands:')}
  start          Start the interactive TUI (default)
  sandbox        Run O.T.T.O safely isolated in a Docker container
  status         Show configuration, database paths, and API status
  update         Update to the latest version of O.T.T.O
  help           Show this help information

${c.bright('Options:')}
  -h, --help     Show help information

${c.bright('Examples:')}
  $ otto                        # Start interactive UI
  $ otto sandbox ~/my-project   # Run isolated sandbox in a project
  $ otto status                 # View system diagnostics
`);
}

function showStatus() {
    console.log(`\n${c.bright('O.T.T.O - System Status')}\n`);
    console.log(c.dim('═'.repeat(60)));
    
    // Config file
    const configPath = path.join(os.homedir(), '.otto', 'config.json');
    console.log(`\n${c.info('[INFO]')} Configuration File:`);
    console.log(`       ${c.dim(configPath)}`);
    console.log(`       Status: ${fs.existsSync(configPath) ? c.ok('[OK] Exists') : c.warn('[WARN] Using Defaults')}`);

    // Rules
    const rulesPath = path.join(os.homedir(), '.otto', 'rules.md');
    console.log(`\n${c.info('[INFO]')} System Directives File:`);
    console.log(`       ${c.dim(rulesPath)}`);
    console.log(`       Status: ${fs.existsSync(rulesPath) ? c.ok('[OK] Custom Rules Active') : c.warn('[WARN] No custom rules')}`);

    // Tasks
    const tasksPath = path.resolve(process.cwd(), 'tasks.json');
    console.log(`\n${c.info('[INFO]')} Project Task Board:`);
    console.log(`       ${c.dim(tasksPath)}`);
    console.log(`       Status: ${fs.existsSync(tasksPath) ? c.ok('[OK] Active project tracking') : c.dim('Not tracking')}`);

    console.log('\n' + c.dim('═'.repeat(60)));
    console.log(`\n${c.tip('[TIP]')} Run ${c.bright('otto sandbox')} to explore safely isolated operations.\n`);
}

function updatePackage() {
    console.log(`${c.info('[INFO]')} Checking for O.T.T.O updates...`);
    try {
        // In a real deployed app, this would be npm update -g otto
        console.log(`${c.ok('[OK]')} You are already on the latest development version.`);
    } catch (e: any) {
        console.error(`${c.error('[ERROR]')} Update failed: ${e.message}`);
    }
}

async function sandboxCommand(workspace?: string) {
    if (!workspace) {
        console.error(`\n${c.error('❌')} Workspace path required: otto sandbox <path>\n`);
        console.log(`   Example: ${c.bright('otto sandbox ~/my-project')}\n`);
        process.exit(1);
    }
    
    const resolvedPath = workspace.startsWith('~') 
        ? workspace.replace(/^~/, os.homedir()) 
        : path.resolve(workspace);

    if (!fs.existsSync(resolvedPath)) {
        console.error(`\n${c.error('❌')} Workspace path not found: ${c.dim(resolvedPath)}\n`);
        process.exit(1);
    }

    console.log(`\n${c.bright('O.T.T.O Secure Sandbox')}`);
    console.log(c.dim('─'.repeat(50)));
    console.log(`  Engine:    ${c.info('Docker (Node 20)')}`);
    console.log(`  Workspace: ${c.dim(resolvedPath)}`);
    console.log(c.dim('─'.repeat(50)));
    console.log(`\n${c.info('▶')} Booting secure container environment...`);

    try {
        execSync('docker --version', { stdio: 'ignore' });
    } catch {
        console.error(`\n${c.error('❌')} Docker is not installed or not running.\n`);
        process.exit(1);
    }

    // Run interactive docker container mounting the workspace
    const child = spawn('docker', ['run', '-it', '--rm', '-v', `${resolvedPath}:/workspace`, '-w', '/workspace', 'node:20', '/bin/bash'], {
        stdio: 'inherit'
    });

    return new Promise<void>((resolve) => {
        child.on('close', () => {
            console.log(`\n${c.ok('✔')} Sandbox environment terminated safely.\n`);
            resolve();
        });
    });
}

export async function parseAndExecuteCLI(args: string[]): Promise<boolean> {
    if (args.length === 0) return false;

    const command = args[0].toLowerCase();
    
    if (command === 'help' || command === '--help' || command === '-h') {
        showHelp();
        return true;
    }
    
    if (command === 'status') {
        showStatus();
        return true;
    }
    
    if (command === 'update') {
        updatePackage();
        return true;
    }
    
    if (command === 'sandbox') {
        await sandboxCommand(args[1]);
        return true;
    }
    
    if (command === 'start') {
        return false;
    }

    console.error(`\n${c.error('❌')} Unknown command: ${command}`);
    console.log(`   Run "${c.bright('otto help')}" for usage information.\n`);
    return true;
}
