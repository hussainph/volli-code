import { describe, expect, it } from "vite-plus/test";
import type { DoctorCheck } from "@volli/shared";

import type { CliToolStatus } from "../../../../../ipc/contract";
import { cliStatusRows } from "@renderer/components/pages/cli-status-model";
import type { HarnessListing } from "@renderer/components/pages/harness-catalog";

import { buildAboutReport } from "./about-report";

function status(overrides: Partial<CliToolStatus> = {}): CliToolStatus {
  return {
    link: { path: "/Users/ada/.local/bin/volli", state: "ours", target: "/shim/volli" },
    path: { binDir: "/Users/ada/.local/bin", state: "reachable" },
    environment: {
      loginPath: "/usr/bin:/Users/ada/.local/bin",
      session: {
        path: "/volli/bin:/usr/bin:/Users/ada/.local/bin",
        provenance: "adopted",
        interactiveProvenance: "already-complete",
        // The full VC-157 census — every name a session's PATH is looked up
        // for; the package managers this fixture's project never uses are
        // measured as absent, not omitted.
        tools: {
          git: "/usr/bin/git",
          gh: "/opt/homebrew/bin/gh",
          node: "/opt/homebrew/bin/node",
          npm: null,
          pnpm: "/opt/homebrew/bin/pnpm",
          yarn: null,
          bun: null,
        },
        // Only the faultable subset (VC-157): git always, node+pnpm because
        // this fixture's workspace is a pnpm one — never gh, which is
        // classified at the moment a PR action runs.
        requiredTools: ["git", "node", "pnpm"],
        dependencies: null,
        installCommand: null,
      },
      systemPathIssues: [],
      credentialHelperIssues: [],
    },
    socket: { path: "/profiles/volli.sock", live: true },
    wrappers: { commands: ["claude", "codex"] },
    shell: { name: "zsh", supported: true, chainActive: true },
    legacy: { path: "/usr/local/bin/volli", state: "foreign" },
    installSuppressed: false,
    ...overrides,
  };
}

describe("buildAboutReport", () => {
  it("includes every CLI status row shown in About", () => {
    const rows = cliStatusRows(status());

    const report = buildAboutReport({ rows, checks: [], listings: [] });

    expect(report).toContain("CLI status");
    for (const row of rows) {
      expect(report).toContain(`${row.label}: ${row.value}`);
      if (row.detail !== undefined) expect(report).toContain(`  ${row.detail}`);
    }
  });

  it("includes a fault with its remedy", () => {
    const checks: readonly DoctorCheck[] = [
      {
        id: "path-position",
        title: "Volli's bin is first on PATH",
        status: "fail",
        detail: "/Users/ada/.local/bin is second on PATH",
        remedy: "Run volli doctor --fix.",
      },
      { id: "socket", title: "App socket", status: "ok", detail: "Live" },
    ];

    const report = buildAboutReport({ rows: [], checks, listings: [] });

    expect(report).toContain("Doctor");
    expect(report).toContain("[fail] Volli's bin is first on PATH");
    expect(report).toContain("/Users/ada/.local/bin is second on PATH");
    expect(report).toContain("Remedy: Run volli doctor --fix.");
    expect(report).toContain("[ok] App socket");
    expect(report).not.toContain("Remedy: undefined");
  });

  it("lists harnesses only when the inventory has entries", () => {
    const listings: readonly HarnessListing[] = [
      { id: "claude-code", label: "Claude Code", command: "claude", origin: "built-in" },
      { id: "my-agent", label: "My Agent", command: "my-agent", origin: "registered" },
    ];

    const report = buildAboutReport({ rows: [], checks: [], listings });
    const noHarnesses = buildAboutReport({ rows: [], checks: [], listings: [] });

    expect(report).toContain("Harnesses");
    for (const listing of listings) {
      expect(report).toContain(`${listing.label}: ${listing.command} (${listing.origin})`);
    }
    expect(noHarnesses).not.toContain("Harnesses");
  });
});
