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
  it("shares the Session transaction queue, and recovers only after the executor ports and stale attachments", () => {
    expect(source).toContain("createSqliteHostNoticeOutbox(watchedDb, sessionLedger)");
    expect(source).toContain("ledger: sessionLedger");
    before("browserTabsRef = browserTabs", "await shellHostNotices?.recover()");
    before("await closeStaleAttachments({", "await shellHostNotices?.recover()");
    expect(source).toContain("delivery: shellHostNotices");
    expect(source).toContain("sessionWakeBus.subscribe(({ event }) => listener(event))");
  });

  it("releases host notice subscriptions before closing the runtime", () => {
    before("shellHostNotices?.close()", "sessionRuntime?.close()");
  });

  it("wires secret-safe fragment preview alongside ordinary shell output redaction", () => {
    expect(source).toContain("redactOutput: (text) => secrets.store.redact(text)");
    expect(source).toContain("redactNoticeOutput: (text) => secrets.store.redactPartial(text)");
  });
});
