import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

// `--pid-file <path>` makes this server start a long-lived child of its own —
// the shape of a server that leaves helpers running after stdin closes — and
// write both pids, so a test can check the whole process group is gone after
// the client detaches (VC-470).
const pidFileIndex = process.argv.indexOf("--pid-file");
if (pidFileIndex >= 0) {
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  writeFileSync(
    process.argv[pidFileIndex + 1],
    JSON.stringify({ server: process.pid, sleeper: sleeper.pid }),
  );
}

const server = new McpServer({ name: "volli-stdio-fixture", version: "1.0.0" });
server.registerTool(
  "fixture_echo",
  { description: "Echo from a real stdio fixture" },
  async () => ({
    content: [{ type: "text", text: "stdio fixture response" }],
    structuredContent: { transport: "stdio" },
  }),
);
// What the server was launched with, without repeating any value: a digest of
// the one variable a test configured, and whether a parent-only variable
// leaked past the launch allowlist.
server.registerTool(
  "fixture_env",
  { description: "Reports on the launch environment" },
  async () => ({
    content: [{ type: "text", text: "env report" }],
    structuredContent: {
      secretSha256:
        process.env.FIXTURE_SECRET === undefined
          ? null
          : createHash("sha256").update(process.env.FIXTURE_SECRET).digest("hex"),
      parentOnlyLeaked: process.env.VOLLI_TEST_PARENT_ONLY !== undefined,
      cwd: process.cwd(),
    },
  }),
);

await server.connect(new StdioServerTransport());
