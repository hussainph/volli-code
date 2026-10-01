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

// About 1.1 MB of text in one result: past the 1 MiB stdio read buffer Volli
// used to set, so the transport bound cannot quietly shrink back (VC-469).
server.registerTool(
  "fixture_large",
  { description: "A result over a megabyte from a real stdio fixture" },
  async () => ({
    content: [
      {
        type: "text",
        text: Array.from({ length: 20_000 }, (_, index) => `row ${index} ${"-".repeat(45)}`).join(
          "\n",
        ),
      },
    ],
  }),
);

await server.connect(new StdioServerTransport());
