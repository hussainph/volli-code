import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import {
  mcpProviderToolName,
  type RuntimeObservation,
  type SessionRuntimeSpec,
} from "@volli/shared";
import { createPiAgentRuntime } from "./runtime";
import { piExecutionEnv } from "./execution-env";
import { secretFixtureProvider } from "./fixtures/secret-provider";

function scan(dir: string): { name: string; text: string }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? scan(join(dir, entry.name))
      : [{ name: join(dir, entry.name), text: readFileSync(join(dir, entry.name), "utf8") }],
  );
}

it("redacts real Pi activity and sidecars, including long saved MCP output; prevents plaintext shell spills", async () => {
  const root = mkdtempSync(join(process.cwd(), ".secret-runtime-test-"));
  const workspace = join(root, "worktree");
  mkdirSync(workspace);
  const sessions = join(root, "sessions");
  const value = "runtime-credential-sentinel-481";
  const marker = "‹secret:API_TOKEN›";
  const seen: Parameters<typeof secretFixtureProvider>[1] = [];
  const observations: RuntimeObservation[] = [];
  const definition = {
    serverId: "fixture",
    toolName: "echo",
    providerName: mcpProviderToolName("fixture", "Fixture", "echo"),
    description: "test output",
    inputSchema: { type: "object" as const },
  };
  const runtime = createPiAgentRuntime({
    sessionDataDir: sessions,
    models: secretFixtureProvider(
      [
        { name: "request_secret", args: { name: "API_TOKEN" } },
        {
          name: "execute",
          args: { command: `for i in $(seq 1 2100); do printf '%s\\n' "$API_TOKEN"; done` },
        },
        { name: definition.providerName, args: {} },
      ],
      seen,
    ),
    executionEnvFactory: (cwd) =>
      piExecutionEnv(cwd, { secretEnvironment: () => ({ API_TOKEN: value }) }),
  });
  const spec: SessionRuntimeSpec = {
    identity: {
      sessionId: "s",
      projectId: "p",
      ticketId: null,
      role: "project",
      attachmentId: "a",
      rootThreadId: "t",
    },
    workspacePath: workspace,
    venue: "local",
    model: { providerId: "anthropic", modelId: "claude-haiku-4-5", reasoningLevel: "off" },
    brief: { text: "Credential test" },
    tools: { tools: ["execute"], mcp: [definition] },
    observer: async (observation) => {
      observations.push(observation);
    },
    secret: { request: async () => "signed in", redact: (text) => text.replaceAll(value, marker) },
    mcp: {
      call: async () => ({
        content: [{ type: "text", text: `${value}\n`.repeat(1200) }],
        isError: false,
      }),
    },
  };
  const handle = await runtime.startSession(spec);
  try {
    await handle.submitUserMessage("Run fixture");
    const text = JSON.stringify({ seen, observations });
    expect(text).not.toContain(value);
    expect(text).toContain(marker);
    expect(text).toContain("signed in");
    const files = scan(sessions);
    expect(files.some((file) => file.name.endsWith(".jsonl"))).toBe(true);
    expect(files.some((file) => file.name.endsWith(".txt"))).toBe(true);
    expect(files.map((file) => file.text).join("\n")).not.toContain(value);
    const output = seen.flat().filter((message) => message.role === "toolResult");
    expect(JSON.stringify(output.find((message) => message.toolName === "execute"))).not.toContain(
      "Full output saved",
    );
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});
