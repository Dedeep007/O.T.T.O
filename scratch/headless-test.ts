import { Configurator } from '../src/cli/configurator.js';
import { ProviderEngine } from '../src/llm/provider.js';
import { memoryManager } from '../src/memory/budget.js';
import { ruleGuardrail } from '../src/security/rules.js';
import { HumanMessage, AIMessage, SystemMessage, ToolMessage, BaseMessage } from '@langchain/core/messages';
import { tools } from '../src/llm/tools.js';
import chalk from 'chalk';

function sanitizeJsonString(jsonStr: string): string {
  let result = '';
  let inString = false;
  for (let i = 0; i < jsonStr.length; i++) {
    const char = jsonStr[i];
    if (char === '"') {
      inString = !inString;
      result += char;
      continue;
    }
    if (inString && char === '\\') {
      const nextChar = jsonStr[i + 1];
      if (nextChar === "'" || nextChar === undefined) {
        continue;
      }
      result += '\\' + nextChar;
      i++;
      continue;
    }
    if (inString && (char === '\n' || char === '\r')) {
      if (char === '\n') result += '\\n';
      continue;
    }
    result += char;
  }
  return result;
}

function parseFallbackToolCalls(content: string): any[] | null {
  const trimmed = content.trim();
  const blockRegex = /^```json\s*([\s\S]*?)\s*```$/i;
  const match = trimmed.match(blockRegex);
  if (match) {
    try {
      const parsed = JSON.parse(sanitizeJsonString(match[1].trim()));
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {}
  }
  try {
     const parsed = JSON.parse(sanitizeJsonString(trimmed));
     return Array.isArray(parsed) ? parsed : [parsed];
  } catch {}
  return null;
}

async function runHeadless() {
  console.log(chalk.cyan("Initializing headless agent test..."));
  let config = await Configurator.init();
  config.provider = 'ollama';
  config.model = 'llama3.1'; // Ensure a fallback model is set if none was selected
  memoryManager.setConfig(config);
  const provider = new ProviderEngine(config);
  const rules = ruleGuardrail.getRules(64000);

  const testPrompt = "Create a new file called math_utils.ts with a function that adds two numbers, and write a simple test for it using node.js assert. Run the test file to prove it works.";
  
  const messages: BaseMessage[] = [
    new SystemMessage(rules),
    new HumanMessage(testPrompt)
  ];
  
  console.log(chalk.green("Test Prompt:"), testPrompt);

  let isDone = false;
  let loops = 0;
  
  while (!isDone && loops < 10) {
    loops++;
    console.log(chalk.blue(`\n--- Agent Loop ${loops} ---`));
    
    const finalMsgs = await memoryManager.optimizeContext(messages, rules, messages);
    
    console.log(chalk.gray("Agent is thinking..."));
    const stream = await provider.stream(finalMsgs);
    let fullResponse = '';
    let toolCalls: any[] = [];
    
    for await (const chunk of stream) {
      if (chunk.content) {
        fullResponse += chunk.content;
      }
      if (chunk.tool_calls && chunk.tool_calls.length > 0) {
        toolCalls = chunk.tool_calls;
      }
    }
    
    if (toolCalls.length === 0 && fullResponse) {
      const fallback = parseFallbackToolCalls(fullResponse);
      if (fallback) toolCalls = fallback;
    }

    console.log(chalk.yellow("Agent response:"));
    console.log(fullResponse.trim());
    
    const aiMessage = new AIMessage({ content: fullResponse, tool_calls: toolCalls });
    messages.push(aiMessage);
    
    if (toolCalls.length > 0) {
      console.log(chalk.magenta(`\nExecuting ${toolCalls.length} tool(s)...`));
      for (const call of toolCalls) {
        const callName = call.name || call.function?.name;
        const callArgs = call.args || (typeof call.function?.arguments === 'string' ? JSON.parse(call.function.arguments) : call.function?.arguments);
        console.log(chalk.dim(`[Tool] ${callName}(${JSON.stringify(callArgs).substring(0, 80)}...)`));
        
        const toolDef = tools.find(t => t.name === callName);
        let result = '';
        if (toolDef) {
          try {
            result = await toolDef.invoke(callArgs);
          } catch(e: any) {
            result = `Error: ${e.message}`;
          }
        } else {
          result = `Unknown tool: ${callName}`;
        }
        
        console.log(chalk.dim(`[Result] ${result.substring(0, 150).trim()}...`));
        messages.push(new ToolMessage({ tool_call_id: call.id || ('fallback_id_' + Math.random().toString()), name: callName, content: result }));
      }
    } else {
      console.log(chalk.green("\nNo tools called. Agent has finished the task."));
      isDone = true;
    }
  }

  if (loops >= 10) {
    console.log(chalk.red("\nHit loop limit (10). Agent got stuck or didn't finish."));
  }
}

runHeadless().catch(console.error);
