import { describe, expect, it } from "vite-plus/test";
import type { DoctorCheck } from "@volli/shared";

import type { CliToolStatus } from "../../../../../ipc/contract";
import { cliStatusRows } from "@renderer/components/pages/cli-status-model";

import {
  aboutHealth,
  aboutReportAvailability,
  scopedFactState,
  type AboutFactState,
} from "./about-health-model";

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
        tools: {
          git: "/usr/bin/git",
          gh: "/opt/homebrew/bin/gh",
          node: "/opt/homebrew/bin/node",
          npm: null,
          pnpm: "/opt/homebrew/bin/pnpm",
          yarn: null,
          bun: null,
        },
        requiredTools: ["git", "node", "pnpm"],
        dependencies: null,
        installCommand: null,
      },
      systemPathIssues: [],
    },
    socket: { path: "/profiles/volli.sock", live: true },
    wrappers: { commands: ["claude"] },
    shell: { name: "zsh", supported: true, chainActive: true },
    legacy: { path: "/usr/local/bin/volli", state: "absent" },
    installSuppressed: false,
    ...overrides,
  };
}

const HEALTHY_ROWS = cliStatusRows(status());
const SOCKET_DOWN_ROWS = cliStatusRows(status({ socket: { path: "/p/volli.sock", live: false } }));

const PASSING: readonly DoctorCheck[] = [
  { id: "volli-cli", title: "`volli` is this app's CLI", status: "ok", detail: "/bin/volli" },
];
const FAILING: readonly DoctorCheck[] = [
  ...PASSING,
  {
    id: "shell-init",
    title: "Shell integration is active",
    failureTitle: "Shell integration files are missing",
    status: "fail",
    detail: "/Users/ada/.volli/shell is missing",
    remedy: "Run `volli doctor --fix`.",
  },
];

function health(
  overrides: {
    status?: AboutFactState;
    doctor?: AboutFactState;
    rows?: readonly ReturnType<typeof cliStatusRows>[number][];
    checks?: readonly DoctorCheck[];
  } = {},
) {
  return aboutHealth({
    status: overrides.status ?? "ready",
    doctor: overrides.doctor ?? "ready",
    rows: overrides.rows ?? HEALTHY_ROWS,
    checks: overrides.checks ?? PASSING,
  });
}

/**
 * VC-293's headline finding: About started both reads empty and computed
 * "healthy" from an empty fault list, so the pane said "Everything's working"
 * before it had asked anything — and again when a read had failed.
 */
describe("aboutHealth — before the reads land", () => {
  it("checks rather than claiming health while either read is loading", () => {
    for (const loading of [
      { status: "loading" as const },
      { doctor: "loading" as const },
      { status: "loading" as const, doctor: "loading" as const },
    ]) {
      const result = health(loading);
      expect(result.state).toBe("checking");
      expect(result.headline).toBe("Checking…");
      expect(result.canFix).toBe(false);
    }
  });

  it("shows no faults from an earlier read while a new one is in flight", () => {
    const result = health({ status: "loading", rows: SOCKET_DOWN_ROWS, checks: FAILING });

    expect(result.state).toBe("checking");
    expect(result.faults).toEqual([]);
  });

  it("never reads as healthy on the very first frame, when nothing has been measured", () => {
    const first = aboutHealth({ status: "loading", doctor: "loading", rows: [], checks: [] });

    expect(first.state).toBe("checking");
    expect(first.headline).not.toContain("Everything's working");
  });
});

describe("aboutHealth — a read that could not be completed", () => {
  it("says the checks are incomplete rather than implying a healthy install", () => {
    for (const broken of [{ status: "unavailable" as const }, { doctor: "unavailable" as const }]) {
      const result = health(broken);
      expect(result.state).toBe("unavailable");
      expect(result.headline).toBe("Couldn't complete these checks");
      expect(result.canFix).toBe(false);
    }
  });

  it("offers recovery as soon as one read is unavailable, even while the other is loading", () => {
    for (const broken of [
      { status: "unavailable" as const, doctor: "loading" as const },
      { status: "loading" as const, doctor: "unavailable" as const },
    ]) {
      const result = health(broken);
      expect(result.state).toBe("unavailable");
      expect(result.headline).toBe("Couldn't complete these checks");
      expect(result.canFix).toBe(false);
    }
  });

  // An unavailable read is not a reason to hide what the other read did
  // measure — but only that read's findings, and never the failed one's.
  it("keeps the findings of the read that did complete", () => {
    const result = aboutHealth({
      status: "ready",
      doctor: "unavailable",
      rows: SOCKET_DOWN_ROWS,
      checks: FAILING,
    });

    expect(result.state).toBe("unavailable");
    expect(result.faults).toEqual([
      {
        id: "cli-status:socket",
        headline: "App socket: Not running",
        detail: "Relaunch Volli, then re-check.",
      },
    ]);
  });
});

describe("aboutHealth — once both reads are ready", () => {
  it("says everything is working only when both reads found nothing wrong", () => {
    const result = health();

    expect(result.state).toBe("healthy");
    expect(result.headline).toBe("Everything's working");
    expect(result.faults).toEqual([]);
    expect(result.canFix).toBe(false);
  });

  it("counts Doctor findings and status warnings in one attention headline", () => {
    const result = health({ rows: SOCKET_DOWN_ROWS, checks: FAILING });

    expect(result.state).toBe("attention");
    expect(result.headline).toBe("2 things need attention");
    expect(result.canFix).toBe(true);
  });

  it("uses singular wording for one fault", () => {
    expect(health({ checks: FAILING }).headline).toBe("1 thing needs attention");
  });

  it("heads a Doctor fault with what went wrong, and offers its remedy as the detail", () => {
    const result = health({ checks: FAILING });

    expect(result.faults).toEqual([
      {
        id: "shell-init",
        headline: "Shell integration files are missing",
        detail: "Run `volli doctor --fix`.",
      },
    ]);
  });

  it("gives an older Doctor fault generic repair guidance instead of its measurement", () => {
    const result = health({
      checks: [
        {
          id: "session",
          title: "Session context",
          failureTitle: "This terminal's Session has ended",
          status: "warn",
          detail: "VOLLI_SESSION names s-9, which has ended",
        },
      ],
    });

    expect(result.faults[0]).toEqual({
      id: "session",
      headline: "This terminal's Session has ended",
      detail: "Run `volli doctor` from a new Volli terminal for current repair guidance.",
    });
  });

  it("heads a status warning with its subject and state, then gives its repair", () => {
    const result = health({ rows: SOCKET_DOWN_ROWS });

    expect(result.faults).toEqual([
      {
        id: "cli-status:socket",
        headline: "App socket: Not running",
        detail: "Relaunch Volli, then re-check.",
      },
    ]);
  });

  it("gives an older status warning generic repair guidance when it carries no remedy", () => {
    const rows = [
      {
        key: "shell",
        label: "Shell chain",
        tone: "warn" as const,
        value: "Not generated",
        detail: "/Users/ada/.volli/shell is missing",
      },
    ];

    expect(aboutHealth({ status: "ready", doctor: "ready", rows, checks: PASSING }).faults).toEqual(
      [
        {
          id: "cli-status:shell",
          headline: "Shell chain: Not generated",
          detail: "Select Re-check for current repair guidance.",
        },
      ],
    );
  });
});

/**
 * The report gate: Copy report stays disabled until EVERY input is ready, the
 * support metadata included (VC-293), and a failed input says so rather than
 * offering a report with a hole in it.
 */
describe("aboutReportAvailability", () => {
  it("is ready only when every input is", () => {
    expect(aboutReportAvailability(["ready", "ready", "ready", "ready"])).toBe("ready");
  });

  it("waits while any input is still loading", () => {
    expect(aboutReportAvailability(["ready", "loading", "ready", "ready"])).toBe("loading");
  });

  it("reports unavailable ahead of loading, because a hole will not fill itself", () => {
    expect(aboutReportAvailability(["loading", "unavailable", "ready", "ready"])).toBe(
      "unavailable",
    );
  });
});

/**
 * A read belongs to the project it was made in. Answering for a different one
 * is the stale-result failure the acceptance names, so the scope decides
 * whether a landed read counts as current at all.
 */
describe("scopedFactState", () => {
  it("keeps a read made in the current scope", () => {
    expect(scopedFactState("/work/acme", "/work/acme", "ready")).toBe("ready");
    expect(scopedFactState(null, null, "unavailable")).toBe("unavailable");
  });

  it("treats a read from another project as still loading", () => {
    expect(scopedFactState("/work/acme", "/work/other", "ready")).toBe("loading");
    expect(scopedFactState(undefined, "/work/acme", "ready")).toBe("loading");
    expect(scopedFactState(null, "/work/acme", "unavailable")).toBe("loading");
  });
});
