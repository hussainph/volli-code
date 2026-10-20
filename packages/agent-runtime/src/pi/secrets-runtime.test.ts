import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vite-plus/test";
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

function redactPrimitives(text: string): string {
  return text.replaceAll("1202", "[number]").replaceAll("true", "[boolean]");
}

const definition = {
  serverId: "fixture",
  toolName: "echo",
  providerName: mcpProviderToolName("fixture", "Fixture", "echo"),
  description: "test output",
  inputSchema: { type: "object" as const },
};
const identity: SessionRuntimeSpec["identity"] = {
  sessionId: "s",
  projectId: "p",
  ticketId: null,
  role: "project",
  attachmentId: "a",
  rootThreadId: "t",
};
const model: SessionRuntimeSpec["model"] = {
  providerId: "anthropic",
  modelId: "claude-haiku-4-5",
  reasoningLevel: "off",
};

it("redacts successful real bash/read activity and sidecars, including long saved MCP output; prevents plaintext shell spills", async () => {
  const root = mkdtempSync(join(process.cwd(), ".secret-runtime-test-"));
  const workspace = join(root, "worktree");
  mkdirSync(workspace);
  const spills = join(root, "tmp");
  mkdirSync(spills);
  // NodeExecutionEnv.createTempFile uses os.tmpdir(), not the session/worktree.
  vi.stubEnv("TMPDIR", spills);
  expect(tmpdir()).toBe(spills);
  const sessions = join(root, "sessions");
  const value = "runtime-credential-sentinel-481";
  const marker = "‹secret:API_TOKEN›";
  let supplied = false;
  const seen: Parameters<typeof secretFixtureProvider>[1] = [];
  const observations: RuntimeObservation[] = [];
  const lengthCheck = `set -e; test "\${#API_TOKEN}" -eq ${value.length};`;
  const runtime = createPiAgentRuntime({
    sessionDataDir: sessions,
    models: secretFixtureProvider(
      [
        { name: "request_secret", args: { name: "API_TOKEN" } },
        {
          name: "bash",
          args: {
            command: `${lengthCheck} printf '%s' "$API_TOKEN" > output.txt; printf 'credential-length-ok\\n'`,
          },
        },
        { name: "read", args: { path: "output.txt" } },
        {
          name: "bash",
          args: {
            command: `${lengthCheck} for ((i=0; i<2100; i++)); do printf '%s\\n' "$API_TOKEN"; done`,
          },
        },
        { name: definition.providerName, args: {} },
      ],
      seen,
    ),
    executionEnvFactory: (cwd) =>
      piExecutionEnv(cwd, {
        secretEnvironment: (): Readonly<Record<string, string>> =>
          supplied ? { API_TOKEN: value } : {},
      }),
  });
  const spec: SessionRuntimeSpec = {
    identity,
    workspacePath: workspace,
    venue: "local",
    model,
    brief: { text: "Credential test" },
    tools: { tools: ["execute", "read"], mcp: [definition] },
    observer: async (observation) => {
      observations.push(observation);
    },
    secret: {
      request: async () => {
        supplied = true;
        return "signed in";
      },
      hasValues: () => supplied,
      redact: (text) => text.replaceAll(value, marker),
    },
    mcp: {
      call: async () => ({
        content: [{ type: "text", text: `${value}\n`.repeat(1200) }],
        isError: false,
      }),
    },
  };
  let handle: Awaited<ReturnType<typeof runtime.startSession>> | undefined;
  try {
    handle = await runtime.startSession(spec);
    await handle.submitUserMessage("Run fixture");
    const output = seen.at(-1)!.filter((message) => message.role === "toolResult");
    expect(output.map((message) => message.toolName)).toEqual([
      "request_secret",
      "bash",
      "read",
      "bash",
      definition.providerName,
    ]);
    expect(output.every((message) => !message.isError)).toBe(true);
    expect(output[0]?.content).toEqual([{ type: "text", text: "signed in" }]);
    expect(output[1]?.content).toEqual([{ type: "text", text: "credential-length-ok\n" }]);
    // An intentional command write is not a shell spill. Prove injection and read-back really ran.
    expect(readFileSync(join(workspace, "output.txt"), "utf8")).toBe(value);
    expect(JSON.stringify(output[2]?.content)).toContain(marker);
    const truncated = output[3]!;
    expect(truncated.details).toMatchObject({ truncation: { truncated: true, totalLines: 2100 } });
    expect((truncated.details as { fullOutputPath?: unknown }).fullOutputPath).toBeUndefined();
    expect(JSON.stringify(truncated.content)).toContain(marker);
    expect(JSON.stringify(truncated)).not.toContain("pi-output-");
    expect(scan(spills)).toEqual([]);
    const completed = observations.filter(
      (observation) => observation.kind === "activity" && observation.state === "completed",
    );
    expect(completed).toHaveLength(5);
    expect(
      observations.filter(
        (observation) => observation.kind === "activity" && observation.state === "failed",
      ),
    ).toEqual([]);
    const text = JSON.stringify({ seen, observations });
    expect(text).not.toContain(value);
    expect(text).toContain(marker);
    const files = scan(sessions);
    expect(files.some((file) => file.name.endsWith(".jsonl"))).toBe(true);
    expect(files.some((file) => file.name.endsWith(".txt"))).toBe(true);
    expect(files.map((file) => file.text).join("\n")).not.toContain(value);
  } finally {
    await handle?.close();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});

it("scrubs numeric/boolean MCP structured data and result details before activity, replay and sidecar persistence", async () => {
  const root = mkdtempSync(join(process.cwd(), ".secret-primitives-test-"));
  const workspace = join(root, "worktree");
  mkdirSync(workspace);
  const sessions = join(root, "sessions");
  const data = {
    number: 1202,
    boolean: true,
    nested: [312024, true],
    untouched: [17, false, null],
  };
  const expected = {
    number: "[number]",
    boolean: "[boolean]",
    nested: ["3[number]4", "[boolean]"],
    untouched: [17, false, null],
  };
  const detailData = {
    number: 1202,
    boolean: true,
    safeNumber: 17,
    safeBoolean: false,
    empty: null,
  };
  const expectedDetails = { ...detailData, number: "[number]", boolean: "[boolean]" };
  const seen: Parameters<typeof secretFixtureProvider>[1] = [];
  const observations: RuntimeObservation[] = [];
  const runtime = createPiAgentRuntime({
    sessionDataDir: sessions,
    models: secretFixtureProvider(
      [
        { name: definition.providerName, args: {} },
        { name: "session_stop", args: { session: "fixture-session" } },
      ],
      seen,
    ),
  });
  const handle = await runtime.startSession({
    identity,
    workspacePath: workspace,
    venue: "local",
    model,
    brief: { text: "Primitive credential test" },
    tools: { tools: [], mcp: [definition], verbs: ["session.stop"] },
    secret: { request: async () => "signed in", hasValues: () => true, redact: redactPrimitives },
    observer: async (observation) => {
      observations.push(observation);
    },
    mcp: {
      call: async () => ({
        // 1200 newlines, the join newline and structured JSON = 1202 lines.
        content: [{ type: "text", text: "fixture-line-padding\n".repeat(1200) }],
        structuredContent: data,
        isError: false,
      }),
    },
    callVerb: async () => ({ text: "fixture result", details: { result: detailData } }),
  });
  try {
    await handle.submitUserMessage("Run primitive fixtures");
    const output = seen.at(-1)!.filter((message) => message.role === "toolResult");
    expect(output.map((message) => message.toolName)).toEqual([
      definition.providerName,
      "session_stop",
    ]);
    expect(output.every((message) => !message.isError)).toBe(true);
    expect(output[0]?.details).toMatchObject({ output: { totalLines: "[number]" } });
    expect(output[1]?.details).toEqual({ result: expectedDetails });
    const completed = observations.filter(
      (observation): observation is Extract<RuntimeObservation, { kind: "activity" }> =>
        observation.kind === "activity" && observation.state === "completed",
    );
    expect(completed).toHaveLength(2);
    expect(completed[0]?.output).toMatchObject({
      structuredContent: expected,
      details: { output: { totalLines: "[number]" } },
    });
    expect(completed[1]?.output).toMatchObject({ details: { result: expectedDetails } });
    const replay = await handle.reconcile(null);
    expect(replay.observations.filter((observation) => observation.kind === "activity")).toEqual(
      completed,
    );
    const sidecarMessages = scan(sessions)
      .filter((file) => file.name.endsWith(".jsonl"))
      .flatMap((file) =>
        file.text
          .trim()
          .split("\n")
          .flatMap((line) => {
            type Record = { type?: string; message?: Message };
            const parsed = JSON.parse(line) as Record | Record[];
            return Array.isArray(parsed) ? parsed : [parsed];
          }),
      )
      .flatMap((entry) =>
        entry.type === "message" && entry.message?.role === "toolResult" ? [entry.message] : [],
      );
    expect(sidecarMessages).toHaveLength(2);
    expect(sidecarMessages[0]?.details).toMatchObject({ output: { totalLines: "[number]" } });
    expect(sidecarMessages[1]?.details).toEqual({ result: expectedDetails });
    expect(JSON.stringify(sidecarMessages[0]?.content)).toContain("[boolean]");
    const saved = scan(sessions).filter((file) => file.name.endsWith(".txt"));
    expect(saved).toHaveLength(1);
    expect(saved[0]?.text).toContain('"boolean":[boolean]');
    expect(saved[0]?.text).not.toContain('"number":1202');
    expect(data.boolean).toBe(true); // Do not mutate host/MCP data.
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});
