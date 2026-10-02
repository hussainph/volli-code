/** VC-497: deliberately small, frozen read/write surface, not the production tools. */
import { readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { defineExtension, defineTool, hook, ToolTask } from "@earendil-works/pi-durable";
import { Type } from "pi-durable-ai";
import type { SessionRuntimeSpec } from "@volli/shared";
import { authorityVerdict } from "../../src/authority/gate.ts";

export interface SpikeToolProbe {
  beforeEffect?(name: string): Promise<void>;
  afterEffect?(name: string, publish: () => Promise<void>): Promise<void>;
}

export function spikeTools(spec: SessionRuntimeSpec, probe?: SpikeToolProbe) {
  const names = [...spec.tools.tools];
  const authority = spec.authority ? structuredClone(spec.authority) : undefined;
  if (
    names.some((name) => name !== "read" && name !== "write") ||
    spec.tools.verbs?.length ||
    spec.tools.todoWrite ||
    spec.tools.codeMode ||
    spec.mcp ||
    spec.browser ||
    spec.shell ||
    spec.webFetch ||
    spec.webSearch ||
    spec.askUser ||
    spec.secret ||
    spec.classify ||
    spec.ask ||
    spec.approvals ||
    spec.decisions ||
    spec.credentialRedaction ||
    authority?.protection ||
    authority?.enforcement === "observe"
  ) {
    throw new Error("Pi Durable spike supports only the frozen read/write surface");
  }
  const check = async (name: string, args: { path: string; content?: string }) => {
    if (!names.includes(name as "read" | "write"))
      throw new Error("Tool not granted at Session birth");
    const root = await realpath(spec.workspacePath);
    const target = resolve(root, args.path);
    // This stricter spike scope intentionally omits task-anchored external reads.
    const canonical =
      name === "read"
        ? await realpath(target)
        : resolve(await realpath(dirname(target)), target.slice(dirname(target).length + 1));
    const held = relative(root, canonical);
    if (held === ".." || held.startsWith("../") || isAbsolute(held))
      throw new Error("Outside spike workspace");
    // A pre-existing write target may itself be a symlink.
    if (name === "write") {
      let existing: string | undefined;
      try {
        existing = await realpath(target);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      if (existing && existing !== canonical)
        throw new Error("Symlink write is outside spike scope");
    }
    if (authority?.enforcement === "enforce") {
      const verdict = authorityVerdict({ tool: name, args, authority, workspacePath: root });
      if (verdict.outcome === "deny") throw new Error(verdict.reason);
    }
    return canonical;
  };
  const read = defineTool({
    name: "read",
    description: "Read a workspace text file (spike only)",
    parameters: Type.Object({ path: Type.String() }),
    replay: "safe",
    execute: async (args, api, context) => {
      // Recovery goes straight to execute, bypassing beforeTool: recheck live paths here.
      const path = await check("read", args);
      await probe?.beforeEffect?.("read");
      const text = await readFile(path, "utf8");
      api.output("read started\n");
      await probe?.afterEffect?.("read", () => api.details({ checkpoint: true }, context));
      return { content: [{ type: "text", text }] };
    },
  });
  const write = defineTool({
    name: "write",
    description: "Write a workspace text file (spike only)",
    parameters: Type.Object({ path: Type.String(), content: Type.String() }),
    execute: async (args, api, context) => {
      const path = await check("write", args);
      await probe?.beforeEffect?.("write");
      await writeFile(path, args.content);
      api.output("write effect committed externally\n");
      await probe?.afterEffect?.("write", () => api.details({ checkpoint: true }, context));
      return { content: [{ type: "text", text: "written" }] };
    },
  });
  const tools = [read, write].filter((tool) => names.includes(tool.name as "read" | "write"));
  return defineExtension({
    name: "volli-spike-frozen-tools",
    tools,
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call) => {
          try {
            await check(call.name, call.arguments as { path: string; content?: string });
            return undefined;
          } catch (error) {
            return { block: error instanceof Error ? error.message : String(error) };
          }
        },
      }),
    ],
  });
}
