import { describe, expect, it } from "vite-plus/test";
import type { DoctorCheck } from "@volli/shared";

import type { CliToolStatus, SupportInfo } from "../../../../../ipc/contract";
import { cliStatusRows } from "@renderer/components/pages/cli-status-model";
import type { HarnessListing } from "@renderer/components/pages/harness-catalog";

import { buildAboutReport, type AboutReportInput } from "./about-report";

const GENERATED_AT = "2026-02-01T09:15:00.000Z";

function support(overrides: Partial<SupportInfo> = {}): SupportInfo {
  return {
    appVersion: "0.2.0-canary.4",
    channel: "canary",
    platform: "darwin",
    arch: "arm64",
    schemaVersion: 34,
    ...overrides,
  };
}

function report(overrides: Partial<AboutReportInput> = {}): string {
  return buildAboutReport({
    generatedAt: GENERATED_AT,
    support: support(),
    rows: [],
    checks: [],
    listings: [],
    ...overrides,
  });
}

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
    },
    socket: { path: "/profiles/volli.sock", live: true },
    wrappers: { commands: ["claude", "codex"] },
    shell: { name: "zsh", supported: true, chainActive: true },
    legacy: { path: "/usr/local/bin/volli", state: "foreign" },
    installSuppressed: false,
    ...overrides,
  };
}

/**
 * VC-293. The first question asked of any report is "which build, on what?",
 * and the report answered none of it: no version, no channel, no OS, no schema
 * number, and no way to tell a report taken this morning from one taken last
 * month. It leads with them now, and the timestamp is passed IN so one
 * snapshot backs both the preview and the clipboard.
 */
describe("buildAboutReport — support metadata", () => {
  it("starts with when it was taken and what took it", () => {
    const lines = report().split("\n");

    expect(lines.slice(0, 6)).toEqual([
      "Volli report",
      `Generated at: ${GENERATED_AT}`,
      "App version: 0.2.0-canary.4",
      "Release channel: canary",
      "OS: darwin arm64",
      "Database schema: 34",
    ]);
  });

  it("puts the metadata ahead of the measurements it describes", () => {
    const text = report({
      rows: cliStatusRows(status()),
      checks: [{ id: "volli-cli", title: "`volli` is this app's CLI", status: "ok", detail: "/b" }],
      listings: [
        { id: "claude-code", label: "Claude Code", command: "claude", origin: "built-in" },
      ],
    });

    expect(text.indexOf("App version:")).toBeLessThan(text.indexOf("CLI status"));
    expect(text.indexOf("Database schema:")).toBeLessThan(text.indexOf("Doctor"));
    expect(text.indexOf("Generated at:")).toBeLessThan(text.indexOf("Harnesses"));
  });

  it("reports a schema version of zero as the number it is", () => {
    expect(report({ support: support({ schemaVersion: 0 }) })).toContain("Database schema: 0");
  });

  /**
   * The allowlist, enforced from the reader's side: the report may consult the
   * five named fields and nothing else. A support result that also carried a
   * credential — through a widened contract, or a main-process mistake — must
   * not reach the clipboard through this builder.
   */
  it("reads only the allowlisted support fields, and exports no credential", () => {
    const read: string[] = [];
    const smuggled = {
      ...support(),
      apiKey: "sentinel-credential-do-not-export",
      env: { OPENAI_API_KEY: "sentinel-credential-do-not-export" },
    };
    const watched = new Proxy(smuggled, {
      get(target, property, receiver) {
        if (typeof property === "string") read.push(property);
        return Reflect.get(target, property, receiver) as unknown;
      },
    }) as SupportInfo;

    const text = report({ support: watched });

    expect(read.toSorted()).toEqual(["appVersion", "arch", "channel", "platform", "schemaVersion"]);
    expect(text).not.toContain("sentinel-credential-do-not-export");
    expect(text).not.toContain("apiKey");
    expect(text.toLowerCase()).not.toContain("api_key");
  });
});

describe("buildAboutReport", () => {
  it("includes every CLI status row shown in About", () => {
    const rows = cliStatusRows(status());

    const text = report({ rows });

    expect(text).toContain("CLI status");
    for (const row of rows) {
      expect(text).toContain(`${row.label}: ${row.value}`);
      if (row.detail !== undefined) expect(text).toContain(`  ${row.detail}`);
    }
  });

  it("includes a fault with its remedy", () => {
    const checks: readonly DoctorCheck[] = [
      {
        id: "path-position",
        title: "Volli's bin is first on PATH",
        failureTitle: "Volli bin is not first on PATH",
        status: "fail",
        detail: "/Users/ada/.local/bin is second on PATH",
        remedy: "Run volli doctor --fix.",
      },
      { id: "socket", title: "App socket", status: "ok", detail: "Live" },
    ];

    const text = report({ checks });

    expect(text).toContain("Doctor");
    expect(text).toContain("[fail] Volli bin is not first on PATH");
    expect(text).toContain("/Users/ada/.local/bin is second on PATH");
    expect(text).toContain("Remedy: Run volli doctor --fix.");
    expect(text).toContain("[ok] App socket");
    expect(text).not.toContain("Remedy: undefined");
  });

  // A finding's own claim is still worth having in the report — it is what the
  // check was measuring — but the line a reader scans has to be the finding.
  it("heads a Doctor finding with the failure, keeping its claim beside it", () => {
    const text = report({
      checks: [
        {
          id: "shell-init",
          title: "Shell integration is active",
          failureTitle: "Shell integration files are missing",
          status: "fail",
          detail: "/Users/ada/.volli/shell is missing",
        },
      ],
    });

    expect(text).toContain("[fail] Shell integration files are missing");
    expect(text).toContain("  Check: Shell integration is active");
  });

  it("lists harnesses only when the inventory has entries", () => {
    const listings: readonly HarnessListing[] = [
      { id: "claude-code", label: "Claude Code", command: "claude", origin: "built-in" },
      { id: "my-agent", label: "My Agent", command: "my-agent", origin: "registered" },
    ];

    const text = report({ listings });
    const noHarnesses = report();

    expect(text).toContain("Harnesses");
    for (const listing of listings) {
      expect(text).toContain(`${listing.label}: ${listing.command} (${listing.origin})`);
    }
    expect(noHarnesses).not.toContain("Harnesses");
  });

  // The same inputs must produce the same text, byte for byte: the pane takes
  // ONE snapshot and hands it to both the preview and the clipboard, and a
  // builder that reached for the clock itself would break that.
  it("is a pure function of its input, clock included", () => {
    const input: AboutReportInput = {
      generatedAt: GENERATED_AT,
      support: support(),
      rows: cliStatusRows(status()),
      checks: [{ id: "volli-cli", title: "`volli` is this app's CLI", status: "ok", detail: "/b" }],
      listings: [
        { id: "claude-code", label: "Claude Code", command: "claude", origin: "built-in" },
      ],
    };

    expect(buildAboutReport(input)).toBe(buildAboutReport(input));
  });
});
