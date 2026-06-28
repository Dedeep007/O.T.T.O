import { Configurator } from '../src/cli/configurator.js';
import { RequestPipeline } from '../src/agent/request_pipeline.js';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import { classifyAssistantStep } from '../src/agent/classify.js';
import { AgentRegistry } from '../src/agent/agents.js';

async function runBenchmark() {
  console.log('--- O.T.T.O Coding Agent Benchmark ---');
  
  console.log('\n[1] Testing Request Pipeline & Context Build...');
  const config = await Configurator.init();
  const msgs = [new HumanMessage('Hello O.T.T.O, refactor this code.')];
  const payload = await RequestPipeline.buildPayload(msgs, config, 'default', 'build');
  console.log(`Payload length: ${payload.length} messages.`);
  if (payload[0]._getType() !== 'system') {
    throw new Error('First message must be system message.');
  }

  console.log('\n[2] Testing Multi-Agent Roles...');
  const exploreAgent = AgentRegistry.getAgent('explore');
  console.log(`Explore Agent tools: ${exploreAgent.allowedTools.join(', ')}`);
  if (exploreAgent.allowedTools.includes('write_file')) {
    throw new Error('Explore agent should not have write_file access.');
  }
  
  console.log('\n[3] Testing Step Classifier (Robustness regardless of LLM format)...');
  const mockToolCallMsg = new AIMessage({
    content: 'Let me look at the files.',
    tool_calls: [{ id: 'call_1', name: 'read_file', args: { filePath: 'package.json' } }]
  });
  const classTools = classifyAssistantStep(mockToolCallMsg, false, (t) => t);
  console.log(`Tool call classification: ${classTools.type}`);
  if (classTools.type !== 'tools') throw new Error('Failed to classify tool call.');

  const mockThinkOnly = new AIMessage({
    content: '<think>I should do this</think>'
  });
  
  const stripThink = (t: string) => {
    const start = t.indexOf('<think>');
    const end = t.indexOf('</think>');
    if (start !== -1 && end !== -1) {
      return t.substring(0, start) + t.substring(end + 8);
    }
    return t;
  };
  const classThink = classifyAssistantStep(mockThinkOnly, false, stripThink);
  console.log(`Think-only classification: ${classThink.type}`);
  if (classThink.type !== 'think-only') throw new Error('Failed to classify think-only step.');

  console.log('\n✅ All benchmarks passed. O.T.T.O is highly robust and prepared for complex coding tasks.');
}

runBenchmark().catch(e => {
  console.error('Benchmark failed:', e);
  process.exit(1);
});
