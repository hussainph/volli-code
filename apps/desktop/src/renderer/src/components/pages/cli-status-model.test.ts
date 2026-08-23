import { describe, expect, it } from "vite-plus/test";

import type { CliToolStatus } from "../../../../ipc/contract";
import {
  cliNeedsAttention,
  cliStatusDisclosure,
  cliStatusRows,
  sessionPathComparison,
} from "./cli-status-model";

function session(
  overrides: Partial<CliToolStatus["environment"]["session"]> = {},
): CliToolStatus["environment"]["session"] {
  return {
    path: "/volli/bin:/usr/bin:/home/me/.local/bin",
    provenance: "adopted",
    interactiveProvenance: "already-complete",
    tools: {
      git: "/usr/bin/git",
      gh: "/opt/homebrew/bin/gh",
      node: "/opt/homebrew/bin/node",
      npm: "/opt/homebrew/bin/npm",
      pnpm: "/opt/homebrew/bin/pnpm",
      yarn: null,
      bun: null,
    },
    requiredTools: ["git", "node", "pnpm"],
    dependencies: null,
    installCommand: null,
    ...overrides,
  };
}

function status(overrides: Partial<CliToolStatus> = {}): CliToolStatus {
  return {
    link: { path: "/home/me/.local/bin/volli", state: "ours", target: "/shim/volli" },
    path: { binDir: "/home/me/.local/bin", state: "reachable" },
    environment: {
      loginPath: "/usr/bin:/home/me/.local/bin",
      session: session(),
      systemPathIssues: [],
      credentialHelperIssues: [],
    },
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

describe("sessionPathComparison", () => {
  it("keeps expected Session-only entries quiet while preserving their full path", () => {
    const loginPath = "/usr/bin:/opt/homebrew/bin:/Users/me/.local/bin";
    const sessionOnly = "/Users/me/Library/Application Support/Volli Code/bin";

    const comparison = sessionPathComparison(
      status({
        environment: {
          loginPath,
          session: session({ path: `${sessionOnly}:${loginPath}` }),
          systemPathIssues: [],
          credentialHelperIssues: [],
        },
      }),
    );

    expect(comparison).toMatchObject({
      state: "matching",
      missingFromSession: [],
      sessionOnly: [sessionOnly],
      sharedEntryCount: 3,
      sharedOrderMatches: true,
    });
  });

  it("makes a missing, deeply nested directory explicit instead of reducing the paths to strings", () => {
    const missing = "/Users/me/Library/Application Support/Acme Toolchains/current/bin";
    const comparison = sessionPathComparison(
      status({
        environment: {
          loginPath: `/usr/bin:${missing}:/opt/homebrew/bin`,
          session: session({
            path: "/Users/me/Library/Application Support/Volli Code/bin:/usr/bin:/opt/homebrew/bin",
            provenance: "probe-failed",
            interactiveProvenance: "pending",
          }),
          systemPathIssues: [],
          credentialHelperIssues: [],
        },
      }),
    );

    expect(comparison).toMatchObject({
      state: "diverged",
      missingFromSession: [missing],
      sharedOrderMatches: true,
    });
  });

  it("names the brief interactive adoption gap without presenting it as a permanent mismatch", () => {
    const comparison = sessionPathComparison(
      status({
        environment: {
          loginPath: "/usr/bin:/Users/me/.bun/bin:/opt/homebrew/bin",
          session: session({
            path: "/volli/bin:/usr/bin:/opt/homebrew/bin",
            interactiveProvenance: "pending",
          }),
          systemPathIssues: [],
          credentialHelperIssues: [],
        },
      }),
    );

    expect(comparison).toMatchObject({
      state: "pending",
      missingFromSession: ["/Users/me/.bun/bin"],
    });
  });

  it("treats a changed shared order as divergence because it can resolve another command", () => {
    const comparison = sessionPathComparison(
      status({
        environment: {
          loginPath: "/usr/bin:/opt/homebrew/bin:/Users/me/.local/bin",
          session: session({
            path: "/volli/bin:/opt/homebrew/bin:/usr/bin:/Users/me/.local/bin",
          }),
          systemPathIssues: [],
          credentialHelperIssues: [],
        },
      }),
    );

    expect(comparison).toMatchObject({
      state: "diverged",
      missingFromSession: [],
      sharedOrderMatches: false,
    });
  });

  it("does not claim a match when the login shell never answered", () => {
    const comparison = sessionPathComparison(
      status({
        environment: {
          loginPath: null,
          session: session({
            path: "/volli/bin:/usr/bin",
            provenance: "probe-failed",
            interactiveProvenance: "pending",
          }),
          systemPathIssues: [],
          credentialHelperIssues: [],
        },
      }),
    );

    expect(comparison).toMatchObject({
      state: "unknown",
      loginEntries: [],
      sessionEntries: ["/volli/bin", "/usr/bin"],
    });
  });
});

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

  it("keeps all diagnostics behind the compact summary when nothing needs attention", () => {
    const rows = cliStatusRows(status());
    const disclosure = cliStatusDisclosure(rows);

    expect(disclosure.needsAttention).toBe(false);
    expect(disclosure.attentionRows).toEqual([]);
    expect(disclosure.detailRows).toBe(rows);
  });

  it("keeps only warning diagnostics in sight when the compact summary needs attention", () => {
    const rows = cliStatusRows(
      status({
        socket: { path: "/profiles/volli.sock", live: false },
        shell: { name: "zsh", supported: true, chainActive: false },
      }),
    );
    const disclosure = cliStatusDisclosure(rows);

    expect(disclosure.needsAttention).toBe(true);
    expect(disclosure.attentionRows.map((entry) => entry.key)).toEqual(["socket", "shell"]);
    expect(disclosure.detailRows.map((entry) => entry.key)).toEqual(["link", "path", "wrappers"]);
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
