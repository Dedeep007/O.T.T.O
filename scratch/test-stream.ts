import { Configurator } from '../src/cli/configurator.js';
import { ProviderEngine } from '../src/llm/provider.js';
import { HumanMessage } from '@langchain/core/messages';

async function test() {
  const config = await Configurator.init();
  console.log('Provider:', config.defaults.primaryProvider);
  const provider = new ProviderEngine(config);
  
  const messages = [new HumanMessage('Hi! Write a short 3 word sentence.')];
  try {
    const stream = await provider.stream(messages);
    console.log('Starting stream...');
    for await (const chunk of stream) {
      process.stdout.write(JSON.stringify(chunk) + '\n---\n');
    }
    console.log('Stream finished.');
  } catch (err: any) {
    console.error('Error during streaming:', err);
  }
}

test();
