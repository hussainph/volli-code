import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import { BackgroundShellHost } from "../shell/background-shell-host";

it("redacts combined pipe chunks for start, incremental/tail tools and renderer, failing closed", async () => {
  const root = mkdtempSync(join(process.cwd(), ".secret-shell-test-"));
  const value = "credential-output-sentinel";
  let broken = false;
  const host = new BackgroundShellHost({
    publishState: () => {},
    publishRemoved: () => {},
    settleMs: 1000,
    redactOutput: (text) => {
      if (broken) throw new Error(value);
      return text.replaceAll(value, "‹secret:TOKEN›");
    },
  });
  const owner = { sessionId: "s", attachmentId: "a", projectId: "p", ticketId: null };
  try {
    const started = await host.start(owner, {
      command: 'printf "%s" "${TOKEN%sentinel}"; sleep 0.03; printf "%s\\n" "sentinel"',
      cwd: root,
      title: null,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", TOKEN: value },
    });
    expect(started.output).toBe("‹secret:TOKEN›\n");
    const tail = host.read(owner, started.shell.shellId, 1024);
    expect(tail.output).toBe("‹secret:TOKEN›\n");
    expect(host.read(owner, started.shell.shellId).output).not.toContain(value);
    expect(host.tailOf(started.shell.shellId)?.output).toBe("‹secret:TOKEN›\n");
    broken = true;
    expect(host.read(owner, started.shell.shellId, 1024).output).toBe(
      "[Output withheld: credential redaction failed.]",
    );
    expect(host.tailOf(started.shell.shellId)?.output).not.toContain(value);
  } finally {
    host.disposeSession(owner.sessionId);
    rmSync(root, { recursive: true, force: true });
  }
});
