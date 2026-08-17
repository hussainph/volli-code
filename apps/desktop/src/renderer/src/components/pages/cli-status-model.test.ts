import { describe, expect, it } from "vite-plus/test";

import type { CliToolStatus } from "../../../../ipc/contract";
import { cliNeedsAttention, cliStatusRows } from "./cli-status-model";

function status(overrides: Partial<CliToolStatus> = {}): CliToolStatus {
  return {
    link: { path: "/home/me/.local/bin/volli", state: "ours", target: "/shim/volli" },
    path: { binDir: "/home/me/.local/bin", state: "reachable" },
    socket: { path: "/profiles/volli.sock", live: true },
    wrappers: { commands: ["claude", "codex"] },
    shell: { name: "zsh", supported: true, chainActive: true },
    legacy: { path: "/usr/local/bin/volli", state: "absent" },
    installSuppressed: false,
    ...overrides,
  };
}

function row(rows: ReturnType<typeof cliStatusRows>, key: string) {
  const found = rows.find((entry) => entry.key === key);
  if (!found) throw new Error(`no row ${key}`);
  return found;
}

describe("cliStatusRows", () => {
  it("reads a healthy install as all-ok with no legacy row and no attention", () => {
    const rows = cliStatusRows(status());

    expect(rows.map((entry) => [entry.key, entry.tone])).toEqual([
      ["link", "ok"],
      ["path", "ok"],
      ["socket", "ok"],
      ["wrappers", "ok"],
      ["shell", "ok"],
    ]);
    expect(row(rows, "link").detail).toBe("/home/me/.local/bin/volli");
    expect(row(rows, "wrappers").value).toBe("claude, codex");
    expect(cliNeedsAttention(rows)).toBe(false);
  });

  it("warns on a missing link, but mutes it when the user explicitly removed the tools", () => {
    const missing = status({
      link: { path: "/home/me/.local/bin/volli", state: "missing", target: null },
    });
    expect(row(cliStatusRows(missing), "link")).toMatchObject({
      tone: "warn",
      value: "Not linked",
    });

    const removed = cliStatusRows({ ...missing, installSuppressed: true });
    expect(row(removed, "link")).toMatchObject({ tone: "muted", value: "Removed" });
    expect(row(removed, "link").detail).toContain("File");
  });

  it("names a foreign link and a squatting regular file without pretending to own them", () => {
    const foreign = cliStatusRows(
      status({
        link: { path: "/home/me/.local/bin/volli", state: "foreign", target: "/opt/other/volli" },
      }),
    );
    expect(row(foreign, "link")).toMatchObject({ tone: "warn", detail: "/opt/other/volli" });

    const foreignNoTarget = cliStatusRows(
      status({ link: { path: "/home/me/.local/bin/volli", state: "foreign", target: null } }),
    );
    expect(row(foreignNoTarget, "link").detail).toBeUndefined();

    const file = cliStatusRows(
      status({ link: { path: "/home/me/.local/bin/volli", state: "not-symlink", target: null } }),
    );
    expect(row(file, "link")).toMatchObject({
      tone: "warn",
      value: "A file of yours holds the name",
    });
  });

  it("distinguishes a missing PATH entry from a shell that could not be asked", () => {
    const missing = cliStatusRows(
      status({ path: { binDir: "/home/me/.local/bin", state: "missing" } }),
    );
    expect(row(missing, "path")).toMatchObject({ tone: "warn", value: "Missing" });
    expect(cliNeedsAttention(missing)).toBe(true);

    const unknown = cliStatusRows(
      status({ path: { binDir: "/home/me/.local/bin", state: "unknown" } }),
    );
    expect(row(unknown, "path")).toMatchObject({ tone: "muted", value: "Unknown" });
  });

  it("covers the socket, wrapper, and shell-chain states", () => {
    const down = cliStatusRows(
      status({
        socket: { path: "/profiles/volli.sock", live: false },
        wrappers: { commands: [] },
        shell: { name: "zsh", supported: true, chainActive: false },
      }),
    );
    expect(row(down, "socket")).toMatchObject({ tone: "warn", value: "Not running" });
    expect(row(down, "wrappers")).toMatchObject({ tone: "muted", value: "None generated" });
    expect(row(down, "shell")).toMatchObject({ tone: "warn", value: "Not generated" });
  });

  it("states the zsh-only limitation for other shells as a known state, not a failure", () => {
    const fish = cliStatusRows(
      status({ shell: { name: "fish", supported: false, chainActive: false } }),
    );
    expect(row(fish, "shell")).toMatchObject({
      tone: "muted",
      value: "fish — zsh only for now",
    });
  });

  it("reports a surviving legacy link truthfully: ours muted, foreign warned, absent invisible", () => {
    const ours = cliStatusRows(status({ legacy: { path: "/usr/local/bin/volli", state: "ours" } }));
    expect(row(ours, "legacy")).toMatchObject({ tone: "muted" });

    const foreign = cliStatusRows(
      status({ legacy: { path: "/usr/local/bin/volli", state: "foreign" } }),
    );
    expect(row(foreign, "legacy")).toMatchObject({ tone: "warn" });

    expect(cliStatusRows(status()).some((entry) => entry.key === "legacy")).toBe(false);
  });
});
