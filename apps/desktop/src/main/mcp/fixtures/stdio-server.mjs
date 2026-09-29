import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

const server = new McpServer({ name: "volli-stdio-fixture", version: "1.0.0" });
server.registerTool(
  "fixture_echo",
  { description: "Echo from a real stdio fixture" },
  async () => ({
    content: [{ type: "text", text: "stdio fixture response" }],
    structuredContent: { transport: "stdio" },
  }),
);

await server.connect(new StdioServerTransport());
