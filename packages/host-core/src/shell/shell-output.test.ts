import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import { BackgroundShellHost } from "./background-shell-host";

it("redacts combined pipe chunks for start, incremental/tail tools and renderer, failing closed", async () => {
  const root = mkdtempSync(join(process.cwd(), ".secret-shell-test-"));
  const value = "credential-output-sentinel";
  let broken = false;
  const host = new BackgroundShellHost({
    publishState: () => {},
    publishRemoved: () => {},
    settleMs: 100,
    redactOutput: (text) => {
      if (broken) throw new Error(value);
      return text.replaceAll(value, "‹secret:TOKEN›");
    },
  });
  const owner = { sessionId: "s", attachmentId: "a", projectId: "p", ticketId: null };
  try {
    const started = await host.start(owner, {
      command:
        'printf "%s" "${TOKEN%sentinel}"; sleep 0.03; printf "%s\\n" "sentinel"; while ! test -f release-output; do sleep 0.01; done; printf "%s" "${TOKEN%sentinel}"; sleep 0.03; printf "%s\\n" "sentinel"',
      cwd: root,
      title: null,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", TOKEN: value },
    });
    expect(started.output).toBe("‹secret:TOKEN›\n");
    const tail = host.read(owner, started.shell.shellId, 1024);
    expect(tail.output).toBe("‹secret:TOKEN›\n");
    expect(started.shell.state).toBe("running");
    expect(host.read(owner, started.shell.shellId).output).toBe("");
    // Release a second split-chunk emission only after start and tail consumed
    // the first. An empty incremental read must not count as redaction coverage.
    writeFileSync(join(root, "release-output"), "ready");
    await expect.poll(() => host.listAll()[0]?.state).toBe("exited");
    expect(host.read(owner, started.shell.shellId).output).toBe("‹secret:TOKEN›\n");
    expect(host.read(owner, started.shell.shellId).output).toBe("");
    expect(host.tailOf(started.shell.shellId)?.output).toBe("‹secret:TOKEN›\n‹secret:TOKEN›\n");
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
