import { ChatOpenAI } from '@langchain/openai';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

const t1 = tool(async ({ x }) => `Result ${x}`, {
  name: 'test_tool',
  description: 'Test',
  schema: z.object({ x: z.string() })
});

const llm = new ChatOpenAI({ apiKey: 'dummy', modelName: 'gpt-3.5-turbo' }).bindTools([t1]);
const agent = createReactAgent({ llm, tools: [t1] });

async function run() {
  const stream = await agent.streamEvents({ messages: [{ role: 'user', content: 'hello' }] }, { version: 'v2' });
  for await (const event of stream) {
    console.log(event.event, event.name);
  }
}

run().catch(console.error);
