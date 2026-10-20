// A host process that opens a stdio MCP server through pi-mcp exactly the way
// `client.ts` does, then exits WITHOUT closing it — Electron quitting with a
// Session still attached. pi-mcp's exit hook must take the server's whole
// process group with it (VC-470).
import { McpClient, StdioTransport } from "@earendil-works/pi-mcp";

const [wrapper, server, pidFile] = process.argv.slice(2);
const client = new McpClient({ name: "volli-quit-test", version: "1" });
await client.connect(
  new StdioTransport({
    command: process.execPath,
    args: [wrapper, server, "--pid-file", pidFile],
    inheritEnv: false,
    env: { PATH: process.env.PATH ?? "" },
    stderr: "pipe",
  }),
);
process.stdout.write("connected\n");
process.exit(0);
