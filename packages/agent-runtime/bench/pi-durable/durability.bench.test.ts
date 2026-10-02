import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";
import { describe, expect, it } from "vite-plus/test";
import {
  BUILTIN_RULE_PACK_HASH,
  BUILTIN_RULE_PACK_ID,
  type RuntimeObservation,
} from "@volli/shared";
import { fauxAssistantMessage, fauxToolCall } from "pi-durable-ai/providers/faux";
import { createDurableSpikeRuntime } from "./runtime.ts";
import type { TranslatedObservation } from "../../../session-engine/src/observation-translation.ts";
import { proveEngineProjection } from "./engine-proof.ts";
import { fallback, fixtureModels, fixtureSpec } from "./fixture.ts";

function checkpoint(child: ChildProcess) {
  return new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.on("message", (message) => {
      if (
        typeof message === "object" &&
        message &&
        "type" in message &&
        message.type === "checkpoint"
      )
        resolve();
    });
    child.once("exit", (code, signal) =>
      reject(new Error(`Exited before checkpoint: ${code}/${signal}`)),
    );
  });
}
function exited(child: ChildProcess) {
  return new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

describe("VC-497 real process death with SQLite", () => {
  for (const scenario of ["safe", "unsafe", "stream", "safe-revoked"])
    it(`SIGKILL ${scenario}, reopen, reconcile and retry Command`, async () => {
      const directory = await mkdtemp(join(process.cwd(), ".pi-durable-crash-"));
      let active: ChildProcess | undefined;
      let outside: string | undefined;
      try {
        await writeFile(join(directory, "input.txt"), "safe read result");
        const script = join(directory, "child.mjs");
        await build({
          entryPoints: ["bench/pi-durable/crash-child.ts"],
          outfile: script,
          bundle: true,
          platform: "node",
          format: "esm",
          external: ["@earendil-works/*", "pi-durable-ai", "pi-durable-ai/*"],
        });
        let stderr = "";
        const spawn = (phase: string) => {
          const child = fork(script, [directory, scenario, phase], {
            stdio: ["ignore", "ignore", "pipe", "ipc"],
          });
          child.stderr?.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
          });
          active = child;
          return child;
        };
        const first = spawn("first");
        const killed = exited(first);
        try {
          await checkpoint(first);
        } catch (error) {
          throw new Error(`${String(error)}\n${stderr}`, { cause: error });
        }
        first.kill("SIGKILL");
        expect((await killed).signal).toBe("SIGKILL");
        if (scenario === "safe-revoked") {
          outside = await mkdtemp(join(process.cwd(), ".pi-durable-outside-"));
          await writeFile(join(outside, "secret.txt"), "not authorized to read");
          await unlink(join(directory, "input.txt"));
          await symlink(join(outside, "secret.txt"), join(directory, "input.txt"));
        }
        const second = spawn("reopen");
        const outcome = await exited(second);
        expect(outcome, stderr).toEqual({ code: 0, signal: null });
        const result = JSON.parse(await readFile(join(directory, "result.json"), "utf8")) as {
          invocations: string;
          retriedModelCalls: number;
          eventTypes: string[];
          once: {
            cursor: string;
            observations: RuntimeObservation[];
            receipts: { commandId: string; acceptedAt: number }[];
          };
          again: { observations: RuntimeObservation[] };
          facts: TranslatedObservation[];
        };
        expect(result.retriedModelCalls).toBe(0);
        expect(result.once.receipts.map((r) => r.commandId)).toEqual(["command-497"]);
        expect(result.again.observations).toEqual([]);
        expect(result.facts.some((f) => f.kind === "turn.completed")).toBe(true);
        const messages = result.once.observations
          .filter((o) => o.kind === "message-settled")
          .map((o) => o.message.text);
        if (scenario === "safe") {
          expect(result.invocations.trim().split("\n")).toEqual(["read", "read"]);
          expect(messages.join("\n")).toContain("safe read result");
        } else if (scenario === "unsafe") {
          expect(result.invocations.trim().split("\n")).toEqual(["write"]);
          expect(await readFile(join(directory, "effect.txt"), "utf8")).toBe("one external effect");
          expect(messages.join("\n")).toContain("interrupted");
          expect(messages.join("\n")).toContain("write effect committed externally");
          expect(
            result.once.observations.some((o) => o.kind === "activity" && o.state === "failed"),
          ).toBe(true);
        } else if (scenario === "safe-revoked") {
          expect(result.invocations.trim().split("\n")).toEqual(["read"]);
          expect(messages.join("\n")).toContain("Outside spike workspace");
          expect(messages.join("\n")).not.toContain("not authorized to read");
        } else {
          expect(messages.length).toBe(2);
          expect(messages[0]).toContain("partial");
          expect(messages[1]).toBe("resumed stream answer");
        }
        // Fresh translator replay offers the SAME settled fact identities, not another transcript row.
        const priorFacts = (await readFile(join(directory, "product-first.jsonl"), "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as TranslatedObservation);
        const engine = await proveEngineProjection(
          [...priorFacts, ...result.facts],
          result.once.receipts[0].acceptedAt,
        );
        expect(engine.lastTurnOutcome).toBe("completed");
        expect(engine.before).toBe(engine.after);
        expect(engine.acceptedReceipts).toBe(1);
        expect(engine.userCommands).toBe(1);
        const ids = result.facts.filter((f) => f.id).map((f) => f.id);
        expect(new Set(ids).size).toBe(ids.length);
        console.log(
          JSON.stringify({
            scenario,
            death: "SIGKILL",
            invocations: result.invocations.trim().split("\n").filter(Boolean),
            settledMessages: messages,
            translatedKinds: result.facts.map((f) => f.kind),
            retryModelCalls: result.retriedModelCalls,
            engine,
          }),
        );
      } finally {
        if (active && active.exitCode === null && active.signalCode === null) {
          const exit = exited(active);
          active.kill("SIGKILL");
          await exit;
        }
        await rm(directory, { recursive: true, force: true });
        if (outside) await rm(outside, { recursive: true, force: true });
      }
    }, 30_000);

  it("flag off is the current runtime; authority fails closed; one store owner", async () => {
    const directory = await mkdtemp(join(process.cwd(), ".pi-durable-gate-"));
    let handle: Awaited<ReturnType<typeof fallback.startSession>> | undefined;
    try {
      const { models } = fixtureModels("unsafe");
      const options = {
        enabled: false,
        fallback,
        models,
        checkpointPath: () => join(directory, "checkpoint.sqlite"),
      };
      expect(createDurableSpikeRuntime(options)).toBe(fallback);
      const runtime = createDurableSpikeRuntime({ ...options, enabled: true });
      const observations: RuntimeObservation[] = [];
      const spec = fixtureSpec(directory, async (o) => {
        observations.push(o);
      });
      spec.tools = { tools: ["read", "write", "execute"] };
      await expect(runtime.startSession(spec)).rejects.toThrow("only the frozen read/write");
      spec.tools = { tools: ["read", "write"] };
      spec.authority = {
        mode: "auto",
        location: "worktree",
        enforcement: "enforce",
        judgmentMode: "ask",
        tools: ["read", "write"],
        rulePackId: BUILTIN_RULE_PACK_ID,
        rulePackHash: BUILTIN_RULE_PACK_HASH,
        classifierModel: null,
        fallback: { consecutiveDenials: 3, sessionDenials: 20 },
      };
      handle = await runtime.startSession(spec);
      await expect(runtime.startSession(spec)).rejects.toThrow("already owned");
      await expect(handle.submitUserMessage("hello")).rejects.toThrow("Command ID");
      await handle.submitUserMessage("hello", "queue", "command-gate");
      expect(observations.some((o) => o.kind === "activity" && o.state === "completed")).toBe(true);
      // A fresh provider script tests pre-intent denial; the regular script above exercised the pinned gate.
      const blockedModels = fixtureModels("unsafe");
      blockedModels.faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall("write", { path: "../not-in-workspace.txt", content: "forbidden" }),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("blocked call observed"),
      ]);
      await handle.close();
      handle = undefined;
      let executions = 0;
      const blocked = createDurableSpikeRuntime({
        ...options,
        enabled: true,
        models: blockedModels.models,
        checkpointPath: () => join(directory, "blocked.sqlite"),
        probe: {
          beforeEffect: async () => {
            executions++;
          },
        },
      });
      handle = await blocked.startSession(spec);
      await handle.submitUserMessage("blocked", "queue", "command-blocked");
      expect(executions).toBe(0);
      expect(
        observations.some(
          (o) =>
            o.kind === "activity" &&
            o.state === "failed" &&
            String(o.output).includes("Outside spike workspace"),
        ),
      ).toBe(true);
    } finally {
      await handle?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
