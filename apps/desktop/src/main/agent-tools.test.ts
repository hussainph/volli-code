import { chmod, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  detectInstalledHarnesses,
  globalCliLinkShellCommand,
  runAgentToolsConsent,
} from "./agent-tools";

let root: string | undefined;

afterEach(async () => {
  if (!root) return;
  const { rm } = await import("node:fs/promises");
  await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("detectInstalledHarnesses", () => {
  it("returns only executable harnesses present on PATH", async () => {
    root = await mkdtemp(join(tmpdir(), "volli-detect-test-"));
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "codex"), "#!/bin/sh\n");
    await writeFile(join(bin, "opencode"), "#!/bin/sh\n");
    await chmod(join(bin, "codex"), 0o755);
    await chmod(join(bin, "opencode"), 0o755);

    expect(await detectInstalledHarnesses(bin)).toEqual(["codex", "opencode"]);
  });
});

describe("globalCliLinkShellCommand", () => {
  it("creates /usr/local/bin before linking so fresh macOS never fails permanently", () => {
    const command = globalCliLinkShellCommand("/Users/me/Library/App/bin/volli");
    expect(command).toBe(
      "/bin/mkdir -p /usr/local/bin && ln -sf '/Users/me/Library/App/bin/volli' /usr/local/bin/volli",
    );
    expect(command.indexOf("/bin/mkdir")).toBeLessThan(command.indexOf("ln -sf"));
  });
});

describe("runAgentToolsConsent", () => {
  it("installs only after explicit first-launch consent and persists the choice", async () => {
    const prompt = vi.fn(async () => "install" as const);
    const install = vi.fn(async () => undefined);
    const persist = vi.fn(async () => undefined);

    expect(await runAgentToolsConsent({ current: null, prompt, install, persist })).toBe(
      "installed",
    );
    expect(install).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith("installed");

    prompt.mockClear();
    install.mockClear();
    await runAgentToolsConsent({ current: "deferred", prompt, install, persist });
    expect(prompt).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
  });
});
