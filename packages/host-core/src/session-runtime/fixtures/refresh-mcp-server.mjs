import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

const server = new McpServer({ name: "refresh-fixture", version: "1.0.0" });
for (const name of ["install", "lookup"]) {
  server.registerTool(name, { description: name }, async () => ({
    content: [{ type: "text", text: `${name} worked` }],
  }));
}
await server.connect(new StdioServerTransport());
