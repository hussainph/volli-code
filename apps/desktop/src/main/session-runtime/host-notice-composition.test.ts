/**
 * Temporary desktop-edge guard: shell construction is still desktop-owned.
 * The recovery/close ordering cases now record ports in host-core's lifecycle
 * test. Keep this redactor pairing until shell construction joins that lift.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("desktop shell notice secret wiring", () => {
  it("wires secret-safe fragment preview alongside ordinary shell output redaction", () => {
    expect(source).toContain("redactOutput: (text) => secrets.store.redact(text)");
    expect(source).toContain("redactNoticeOutput: (text) => secrets.store.redactPartial(text)");
  });
});
