/**
 * Temporary desktop-edge guards: shell construction and the live RPC/exporter
 * pairing are still desktop-owned. Recovery/close ordering now records ports in
 * host-core's lifecycle test; keep these pairings until they join that lift.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("desktop runtime edge wiring", () => {
  it("hands the live runtime, RPC and exporter to the one lifecycle owner", () => {
    expect(source).toMatch(
      /createSessionRuntimeLifecycle\(\{\s*host: hostCore,\s*ports: hostPorts,\s*runtime: sessionRuntime,\s*rpc: \(\) => sessionRpc,\s*observability: agentObservability,/,
    );
  });

  it("wires secret-safe fragment preview alongside ordinary shell output redaction", () => {
    expect(source).toContain("redactOutput: (text) => secrets.store.redact(text)");
    expect(source).toContain("redactNoticeOutput: (text) => secrets.store.redactPartial(text)");
  });
});
