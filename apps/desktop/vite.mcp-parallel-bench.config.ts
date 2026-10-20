import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

// The MCP parallel-dispatch bench (VC-444, run through the real Session path
// since VC-454) sleeps for real time against local Streamable HTTP fixture
// servers, so it stays out of the default unit and coverage lanes. It reaches
// no provider, no configured MCP server and no remote endpoint. One worker, no
// file parallelism: timing cells must not run beside each other.
export default defineConfig({
  test: {
    include: ["e2e/bench/mcp-parallel/*.bench.test.ts"],
    environment: "node",
    testTimeout: 600_000,
    fileParallelism: false,
    maxWorkers: 1,
  },
});
