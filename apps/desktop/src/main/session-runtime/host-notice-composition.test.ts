/** Composition-only invariants: index.ts cannot be booted in a unit test. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/.*$/gm, "$1");

function before(first: string, second: string): void {
  const a = source.indexOf(first);
  const b = source.indexOf(second);
  expect(a, first).toBeGreaterThan(-1);
  expect(b, second).toBeGreaterThan(-1);
  expect(a).toBeLessThan(b);
}

describe("host notice composition", () => {
  it("consumes the host-core outbox, and recovers only after the executor ports and stale attachments", () => {
    // The shared writer is exercised in host-core's session-services.test.ts;
    // desktop consumes that service rather than constructing a second outbox.
    expect(source).toContain(
      "const { hostNoticeOutbox, sessionWakeBus, sessionReadWatch, sessionEngine } = hostCore",
    );
    expect(source).toContain("outbox: hostNoticeOutbox");
    before("browserTabsRef = browserTabs", "await shellHostNotices?.recover()");
    before("await closeStaleAttachments({", "await shellHostNotices?.recover()");
    expect(source).toContain("delivery: shellHostNotices");
    expect(source).toContain("sessionWakeBus.subscribe(({ event }) => listener(event))");
  });

  it("passes the live notice and Session owners to host-core shutdown", () => {
    // The notice-before-runtime order now lives in host-shutdown.test.ts.
    // Desktop still supplies the live owners when the accepted quit runs.
    expect(source).toMatch(
      /shutdownNativeSessions:\s*\(\) =>\s*hostCore\.maintenance\.shutdownNativeSessions\(\{\s*sessionWatchdog,\s*scheduledResumeHost,\s*shellHostNotices,\s*sessionRpc,\s*sessionRuntime,\s*agentObservability,\s*\}\)/,
    );
  });

  it("wires secret-safe fragment preview alongside ordinary shell output redaction", () => {
    expect(source).toContain("redactOutput: (text) => secrets.store.redact(text)");
    expect(source).toContain("redactNoticeOutput: (text) => secrets.store.redactPartial(text)");
  });
});
