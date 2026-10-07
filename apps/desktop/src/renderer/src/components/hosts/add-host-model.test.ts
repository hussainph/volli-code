import { describe, expect, it } from "vite-plus/test";
import type { AddHostStepStatus, RemoteHost } from "@volli/shared";

import {
  agentsShareAccountLine,
  cancelNeedsConfirmation,
  changedHostKeyCommand,
  flowBadge,
  questionPrompt,
  readyFacts,
  readySummary,
  memoryText,
  NO_FACTS,
  stepRows,
  validTarget,
  type AddHostFlowView,
} from "./add-host-model";

const STEPS = ["connect", "probe", "deliver", "install", "start", "enroll", "link"] as const;

function view(patch: Partial<AddHostFlowView> = {}): AddHostFlowView {
  return {
    flowId: "flow-1",
    target: "deploy@box",
    name: "box",
    status: "running",
    steps: STEPS.map((id) => ({ id, status: "pending" })),
    question: null,
    failure: null,
    hostId: null,
    startup: null,
    facts: NO_FACTS,
    ...patch,
  };
}

function host(patch: Partial<RemoteHost> = {}): RemoteHost {
  return {
    id: "0f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f",
    name: "box",
    target: "deploy@box",
    transport: "ssh-tunnel",
    os: "linux",
    mode: "system",
    agentsShareAccount: false,
    version: "1.1.0",
    availableUpdate: null,
    hostIsNewer: false,
    deviceId: "1f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f",
    addedAt: "2026-10-07T00:00:00.000Z",
    liveSessions: null,
    system: null,
    arch: null,
    hostKeys: [],
    ...patch,
  };
}

const FOUND = {
  user: "deploy",
  os: "linux" as const,
  system: "Ubuntu 24.04.1 LTS",
  arch: "x86-64",
  memoryBytes: 8 * 1024 ** 3,
  version: "1.1.0",
  keepsRunning: true,
  alreadyPaired: false,
};

const all = (status: AddHostStepStatus) => STEPS.map((id) => ({ id, status }));

describe("the checklist's rows", () => {
  it("is five rows: uploading under Install, opening the connection under Pair", () => {
    const rows = stepRows(view());
    expect(rows.map((row) => [row.id, row.mark, row.label])).toEqual([
      ["connect", "pending", "Connect"],
      ["check", "pending", "Check the system"],
      ["install", "pending", "Install"],
      ["start", "pending", "Start"],
      ["pair", "pending", "Pair"],
    ]);
  });

  it("says a verb while a row runs, halfway through its steps included", () => {
    const rows = stepRows(
      view({
        name: "hetzner-1",
        steps: [
          { id: "connect", status: "running" },
          { id: "probe", status: "pending" },
          { id: "deliver", status: "done" },
          { id: "install", status: "pending" },
          { id: "start", status: "running" },
          { id: "enroll", status: "running" },
          { id: "link", status: "pending" },
        ],
      }),
    );
    expect(rows.map((row) => [row.mark, row.label])).toEqual([
      ["active", "Connecting to hetzner-1…"],
      ["pending", "Check the system"],
      ["active", "Installing Volli host…"],
      ["active", "Starting…"],
      ["active", "Pairing…"],
    ]);
    // The check, running.
    expect(
      stepRows(
        view({
          steps: [
            { id: "connect", status: "done" },
            { id: "probe", status: "running" },
          ],
        }),
      )[1],
    ).toMatchObject({ mark: "active", label: "Checking the system…" });
    // Halfway, but stopped (a failure elsewhere): it waits.
    expect(
      stepRows(view({ status: "failed", steps: [{ id: "deliver", status: "done" }] }))[2],
    ).toMatchObject({ mark: "pending", label: "Install" });
  });

  it("says what each done row found, the lab's words", () => {
    expect(
      stepRows(view({ status: "done", steps: all("done"), facts: FOUND })).map((row) => row.label),
    ).toEqual([
      "Connected as deploy",
      "Ubuntu 24.04.1 LTS · x86-64 · 8 GB",
      "Volli host 1.1.0",
      "Keeps running when you log out",
      "Connected over SSH",
    ]);
    // A user unit that does not linger, a Mac's login start, and what a skipped row found.
    const rows = stepRows(
      view({
        steps: STEPS.map((id) => ({ id, status: id === "start" ? "skipped" : "done" })),
        facts: { ...FOUND, keepsRunning: false, memoryBytes: 512 * 1024 ** 2, alreadyPaired: true },
      }),
    );
    expect(rows.map((row) => [row.label, row.detail])).toEqual([
      ["Connected as deploy", null],
      ["Ubuntu 24.04.1 LTS · x86-64 · 512 MB", null],
      ["Volli host 1.1.0", null],
      ["Stops when you log out", "Already in place"],
      ["Already paired with this Mac", null],
    ]);
    expect(
      stepRows(
        view({
          steps: all("done"),
          startup: "Starts when you log in to studio",
          facts: { ...FOUND, os: "macos", keepsRunning: null },
        }),
      )[3]?.label,
    ).toBe("Starts when you log in to studio");
  });

  it("keeps the noun where nothing was found, and never makes a fact up", () => {
    expect(stepRows(view({ steps: all("done") })).map((row) => row.label)).toEqual([
      "Connect",
      "Check the system",
      "Install",
      "Start",
      "Connected over SSH",
    ]);
    expect(memoryText(1)).toBe("1 MB");
  });

  it("claims the tunnel, not the host: done says Connected over SSH (VC-719)", () => {
    // The flow proved SSH and pairing; whether the host ANSWERS is the
    // engine's health, read on the host after the sheet closes. The last
    // row never claims ready or a serving hostd.
    const rows = stepRows(view({ status: "done", steps: all("done") }));
    expect(rows[4]).toMatchObject({ id: "pair", mark: "done", label: "Connected over SSH" });
    expect(readySummary(view({ status: "done", steps: all("done") }), undefined)).toBe(
      "Connected over SSH",
    );
    // A check that found this Mac paired already still says what it found.
    expect(
      stepRows(view({ facts: { ...NO_FACTS, alreadyPaired: true }, steps: all("done") }))[4],
    ).toMatchObject({ label: "Already paired with this Mac" });
  });

  it("marks the row a question waits on for attention, and a failed row failed", () => {
    const asked = stepRows(
      view({ status: "question", steps: [{ id: "connect", status: "running" }] }),
    );
    expect(asked[0]).toMatchObject({ mark: "attention", label: "Connect" });
    const failed = stepRows(view({ status: "failed", steps: [{ id: "link", status: "failed" }] }));
    expect(failed[4]).toMatchObject({ mark: "failed", label: "Pair" });
  });

  it("ticks Check and Pair when this Mac is already paired, with no attention on the check", () => {
    const rows = stepRows(
      view({
        status: "question",
        steps: [
          { id: "connect", status: "done" },
          { id: "probe", status: "running" },
        ],
        question: { id: "q1", kind: "already-paired", step: "probe", hostId: "h" },
      }),
    );
    expect(rows.map((row) => [row.mark, row.label])).toEqual([
      ["done", "Connect"],
      ["done", "Check the system"],
      ["pending", "Install"],
      ["pending", "Start"],
      ["done", "Already paired with this Mac"],
    ]);
  });

  it("badges the tile: a failure, a question, and a check once it is ready", () => {
    expect(flowBadge(view({ status: "failed" }))).toBe("fail");
    expect(flowBadge(view({ status: "question" }))).toBe("attention");
    expect(flowBadge(view())).toBeNull();
    expect(flowBadge(view({ status: "done" }))).toBe("ready");
  });
});

describe("questions", () => {
  it("shows a host key's fingerprints to compare, dropping malformed ones", () => {
    const prompt = questionPrompt(
      {
        id: "q1",
        kind: "host-key",
        step: "connect",
        offer: {
          entries: [],
          fingerprints: [
            { type: "ED25519", fingerprint: "SHA256:abc" },
            { fingerprint: "SHA256:untyped" },
            { type: "RSA" },
            null,
          ],
        },
      },
      "box",
    );
    expect(prompt).toEqual({
      kind: "host-key",
      line: "This Mac hasn’t seen box’s key before",
      fingerprints: [
        { type: "ED25519", fingerprint: "SHA256:abc" },
        { type: "", fingerprint: "SHA256:untyped" },
      ],
      action: "Trust and continue",
    });
    expect(
      questionPrompt({ id: "q1", kind: "host-key", step: "connect", offer: null }, "box"),
    ).toMatchObject({ fingerprints: [] });
  });

  it("offers Use <version> only for an older host it can manage", () => {
    expect(
      questionPrompt(
        {
          id: "q1",
          kind: "existing-hostd",
          step: "probe",
          version: "0.2.4",
          mode: "user",
          adoptable: true,
        },
        "box",
      ),
    ).toEqual({
      kind: "existing-hostd",
      line: "Volli host 0.2.4 is already running here",
      note: "Its workspaces stay either way.",
      adopt: "Use 0.2.4",
      action: "Update and pair",
    });
    expect(
      questionPrompt({ id: "q1", kind: "existing-hostd", step: "probe", adoptable: false }, "box"),
    ).toMatchObject({ line: "Volli host an older version is already running here", adopt: null });
  });

  it("opens a host this Mac already paired with", () => {
    expect(
      questionPrompt({ id: "q1", kind: "already-paired", step: "probe", hostId: "h" }, "studio"),
    ).toEqual({
      kind: "already-paired",
      line: "This Mac is already paired with studio",
      action: "Open studio",
    });
  });

  it("asks for sudo with the command, offering a user install only for installing", () => {
    const install = questionPrompt(
      {
        id: "q1",
        kind: "sudo-password",
        step: "install",
        reason: "install",
        command: "sudo /tmp/volli-hostd install --system",
        retry: false,
      },
      "box",
    );
    expect(install).toEqual({
      kind: "sudo-password",
      line: "Installing for every account needs sudo",
      command: "sudo /tmp/volli-hostd install --system",
      placeholder: "sudo password",
      retry: false,
      userInstall: {
        label: "Install for my account only",
        note: "Agents on box will share your account.",
      },
      action: "Run it",
    });
    expect(
      questionPrompt(
        {
          id: "q1",
          kind: "sudo-password",
          step: "start",
          reason: "linger",
          command: "sudo x",
          retry: false,
        },
        "box",
      ),
    ).toMatchObject({ line: "Keeping it running after you log out needs sudo", userInstall: null });
    expect(
      questionPrompt(
        {
          id: "q1",
          kind: "sudo-password",
          step: "enroll",
          reason: "enroll",
          command: "sudo y",
          retry: true,
        },
        "box",
      ),
    ).toMatchObject({ line: "That password didn’t work", retry: true, userInstall: null });
    expect(
      questionPrompt({ id: "q1", kind: "sudo-password", step: "install", reason: "other" }, "box"),
    ).toMatchObject({ line: "This step needs sudo", command: "sudo", userInstall: null });
    expect(
      questionPrompt({ id: "q1", kind: "sudo-password", step: "install" }, "box"),
    ).toMatchObject({
      line: "Installing for every account needs sudo",
    });
  });

  it("says a restored host must pair again", () => {
    expect(
      questionPrompt(
        { id: "q1", kind: "identity-changed", step: "enroll", pinned: "a", hostId: "b" },
        "box",
      ),
    ).toEqual({
      kind: "identity-changed",
      line: "box has a new identity",
      note: "It was restored or reinstalled. Devices paired before must pair again.",
      action: "Pair again",
    });
  });

  it("can only go back from a question it does not know", () => {
    expect(questionPrompt({ id: "q1", kind: "brand-new", step: "link" }, "box")).toEqual({
      kind: "unknown",
      line: "box asked something this build can’t answer",
    });
  });
});

describe("ready", () => {
  it("sums the host up from what the add found, the registry's OS where it found nothing", () => {
    expect(readySummary(view({ facts: FOUND }), host())).toBe(
      "Ubuntu 24.04.1 LTS · x86-64 · Volli host 1.1.0",
    );
    expect(readySummary(view(), host())).toBe("Linux · Volli host 1.1.0");
    expect(readySummary(view(), host({ os: "macos", version: null }))).toBe("macOS");
    expect(readySummary(view({ facts: { ...NO_FACTS, os: "macos" } }), undefined)).toBe("macOS");
    expect(readySummary(view(), host({ os: null, version: null }))).toBe("Connected over SSH");
    expect(readySummary(view(), undefined)).toBe("Connected over SSH");
  });

  it("states when it starts and whose account its agents share", () => {
    expect(
      readyFacts(
        view({ status: "done", startup: "Starts when you log in to studio" }),
        host({ name: "studio", agentsShareAccount: true }),
      ),
    ).toEqual(["Starts when you log in to studio", "Agents on studio share your account"]);
    expect(readyFacts(view({ status: "done" }), host())).toEqual([]);
    expect(readyFacts(view({ status: "done" }), undefined)).toEqual([]);
    expect(agentsShareAccountLine("box")).toBe("Agents on box share your account");
  });
});

describe("the address", () => {
  it("accepts a target or an alias, and nothing ssh would read as an option", () => {
    expect(validTarget("deploy@box")).toBe(true);
    expect(validTarget(" box:2222 ")).toBe(true);
    expect(validTarget("")).toBe(false);
    expect(validTarget("   ")).toBe(false);
    expect(validTarget("a b")).toBe(false);
    expect(validTarget("-oProxyCommand=x")).toBe(false);
    expect(validTarget(":22")).toBe(false);
  });
});

describe("detaching and explicit cancellation", () => {
  it("confirms after upload begins, including failures and questions, not before or after completion", () => {
    expect(cancelNeedsConfirmation(null)).toBe(false);
    expect(cancelNeedsConfirmation(view())).toBe(false);
    for (const status of ["running", "done", "failed"] as const) {
      expect(cancelNeedsConfirmation(view({ steps: [{ id: "deliver", status }] }))).toBe(true);
    }
    expect(
      cancelNeedsConfirmation(
        view({ status: "question", steps: [{ id: "install", status: "running" }] }),
      ),
    ).toBe(true);
    expect(cancelNeedsConfirmation(view({ steps: [{ id: "deliver", status: "skipped" }] }))).toBe(
      false,
    );
    expect(
      cancelNeedsConfirmation(view({ status: "done", steps: [{ id: "install", status: "done" }] })),
    ).toBe(false);
    expect(cancelNeedsConfirmation(view({ status: "cancelled" }))).toBe(false);
  });
});

describe("changed SSH host key repair", () => {
  it.each([
    [
      "Host key for real.example has changed and you have requested strict checking.",
      "ssh-keygen -R real.example",
    ],
    ["Host key for [real.example]:2200 has changed", "ssh-keygen -R '[real.example]:2200'"],
    ["Host key for host-key-alias has changed", "ssh-keygen -R host-key-alias"],
    ["Host key for 2001:db8::1 has changed", "ssh-keygen -R '2001:db8::1'"],
    ["Host key for [2001:db8::1]:2200 has changed", "ssh-keygen -R '[2001:db8::1]:2200'"],
    ["Host key for -bad has changed", "ssh-keygen -R my-alias"],
    ["Host key for box;echo has changed", "ssh-keygen -R my-alias"],
    ["Host key for [box]:0 has changed", "ssh-keygen -R my-alias"],
    ["Host key for [box]:65536 has changed", "ssh-keygen -R my-alias"],
  ])("prefers the actual known_hosts identifier reported by SSH: %s", (detail, command) => {
    expect(changedHostKeyCommand("my-alias", detail)).toBe(command);
  });

  it.each([
    ["deploy@box", "ssh-keygen -R box"],
    [" my-alias ", "ssh-keygen -R my-alias"],
    ["deploy@box:22", "ssh-keygen -R box"],
    ["deploy@box:2222", "ssh-keygen -R '[box]:2222'"],
    ["deploy@[2001:db8::1]:2222", "ssh-keygen -R '[2001:db8::1]:2222'"],
    ["[::1]", "ssh-keygen -R '::1'"],
    ["box:0", null],
    ["box:65536", null],
    ["-oProxyCommand=x", null],
    ["box;rm", null],
  ])("uses SSH's host for %s, never the display name or login", (target, command) => {
    expect(changedHostKeyCommand(target)).toBe(command);
  });
});
