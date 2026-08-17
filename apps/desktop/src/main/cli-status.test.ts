import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { readCliStatus, type CliStatusDeps } from "./cli-status";

let root: string | undefined;

afterEach(async () => {
  if (!root) return;
  await rm(root, { recursive: true, force: true });
  root = undefined;
});

function deps(home: string, overrides: Partial<CliStatusDeps> = {}): CliStatusDeps {
  return {
    home,
    shimPath: () => join(home, "userData", "bin", "volli"),
    managedTargets: [],
    socketPath: join(home, "volli.sock"),
    socketLive: () => true,
    loginShellPath: async () => `/usr/bin:${join(home, ".local", "bin")}`,
    wrapperCommands: () => ["claude", "codex"],
    shellFile: "/bin/zsh",
    shellChainActive: () => true,
    installSuppressed: () => false,
    // Isolated from the machine's real /usr/local/bin.
    legacyLinkPath: join(home, "legacy-volli"),
    ...overrides,
  };
}

describe("readCliStatus", () => {
  it("reports a healthy install: our link, reachable PATH, live socket, active zsh chain", async () => {
    root = await mkdtemp(join(tmpdir(), "volli-cli-status-"));
    const d = deps(root);
    await mkdir(join(root, ".local", "bin"), { recursive: true });
    await symlink(d.shimPath(), join(root, ".local", "bin", "volli"));

    const status = await readCliStatus(d);

    expect(status.link).toEqual({
      path: join(root, ".local", "bin", "volli"),
      state: "ours",
      target: d.shimPath(),
    });
    expect(status.path).toEqual({ binDir: join(root, ".local", "bin"), state: "reachable" });
    expect(status.socket).toEqual({ path: join(root, "volli.sock"), live: true });
    expect(status.wrappers.commands).toEqual(["claude", "codex"]);
    expect(status.shell).toEqual({ name: "zsh", supported: true, chainActive: true });
    expect(status.legacy).toEqual({ path: join(root, "legacy-volli"), state: "absent" });
    expect(status.installSuppressed).toBe(false);
  });

  it("reports a surviving legacy /usr/local/bin link, ours and foreign alike", async () => {
    root = await mkdtemp(join(tmpdir(), "volli-cli-status-"));
    const d = deps(root);

    await symlink(d.shimPath(), join(root, "legacy-volli"));
    expect((await readCliStatus(d)).legacy.state).toBe("ours");

    await rm(join(root, "legacy-volli"));
    await symlink("/opt/other/volli", join(root, "legacy-volli"));
    expect((await readCliStatus(d)).legacy.state).toBe("foreign");
  });

  it("distinguishes missing, foreign, and not-a-symlink link states", async () => {
    root = await mkdtemp(join(tmpdir(), "volli-cli-status-"));
    const d = deps(root);

    expect((await readCliStatus(d)).link.state).toBe("missing");

    await mkdir(join(root, ".local", "bin"), { recursive: true });
    await symlink("/somewhere/else/volli", join(root, ".local", "bin", "volli"));
    const foreign = await readCliStatus(d);
    expect(foreign.link.state).toBe("foreign");
    expect(foreign.link.target).toBe("/somewhere/else/volli");

    await rm(join(root, ".local", "bin", "volli"));
    await writeFile(join(root, ".local", "bin", "volli"), "#!/bin/sh\n");
    expect((await readCliStatus(d)).link.state).toBe("not-symlink");
  });

  it("counts a managed sibling's link as ours", async () => {
    root = await mkdtemp(join(tmpdir(), "volli-cli-status-"));
    const devShim = join(root, "Volli Code-dev", "bin", "volli");
    const d = deps(root, { managedTargets: [devShim] });
    await mkdir(join(root, ".local", "bin"), { recursive: true });
    await symlink(devShim, join(root, ".local", "bin", "volli"));

    expect((await readCliStatus(d)).link.state).toBe("ours");
  });

  it("reports the PATH as unknown when the login shell could not be asked, never as missing", async () => {
    root = await mkdtemp(join(tmpdir(), "volli-cli-status-"));

    const status = await readCliStatus(deps(root, { loginShellPath: async () => null }));

    expect(status.path.state).toBe("unknown");
  });

  it("reports a missing PATH entry, an unsupported shell, and the removal tombstone", async () => {
    root = await mkdtemp(join(tmpdir(), "volli-cli-status-"));

    const status = await readCliStatus(
      deps(root, {
        loginShellPath: async () => "/usr/bin:/bin",
        shellFile: "/bin/bash",
        shellChainActive: () => false,
        socketLive: () => false,
        wrapperCommands: () => [],
        installSuppressed: () => true,
      }),
    );

    expect(status.path.state).toBe("missing");
    expect(status.shell).toEqual({ name: "bash", supported: false, chainActive: false });
    expect(status.socket.live).toBe(false);
    expect(status.wrappers.commands).toEqual([]);
    expect(status.installSuppressed).toBe(true);
  });
});
