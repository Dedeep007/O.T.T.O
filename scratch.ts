import { ChatOpenAI } from "@langchain/openai";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { AIMessageChunk } from "@langchain/core/messages";

async function main() {
  const dummyTool = tool(async ({ name }) => {
    return `Hello ${name}!`;
  }, {
    name: "dummy_tool",
    description: "A dummy tool",
    schema: z.object({ name: z.string() })
  });

  const modelWithTools = new FakeListChatModel({
    responses: [
      new AIMessageChunk({ tool_calls: [{ name: "dummy_tool", args: { name: "Alice" }, id: "call_123" }] }),
      new AIMessageChunk({ content: "Tool called!" })
    ],
    sleep: 100
  });

  // Try to use a fake model that supports tool calling properly.
  // FakeListChatModel doesn't bind tools perfectly, but we can try to intercept the ToolNode.
}
main();
