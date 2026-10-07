import { describe, expect, it } from "vite-plus/test";
import type { AddHostView, RemoteHost } from "@volli/shared";

import {
  agentsShareAccountLine,
  flowBadge,
  questionPrompt,
  readyFacts,
  readySummary,
  stepRows,
  validTarget,
} from "./add-host-model";

const STEPS = ["connect", "probe", "deliver", "install", "start", "enroll", "link"] as const;

function view(patch: Partial<AddHostView> = {}): AddHostView {
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
    ...patch,
  };
}

describe("the checklist's rows", () => {
  it("says a noun while waiting, a verb while running, and marks each status", () => {
    const rows = stepRows(
      view({
        steps: [
          { id: "connect", status: "done" },
          { id: "probe", status: "skipped" },
          { id: "deliver", status: "running" },
          { id: "install", status: "pending" },
          { id: "start", status: "failed" },
          { id: "enroll", status: "pending" },
          { id: "link", status: "pending" },
        ],
      }),
    );
    expect(rows.map((row) => [row.id, row.mark, row.label, row.detail])).toEqual([
      ["connect", "done", "Connect", null],
      ["probe", "done", "Check the system", "Already in place"],
      ["deliver", "active", "Uploading Volli host…", null],
      ["install", "pending", "Install", null],
      ["start", "failed", "Start", null],
      ["enroll", "pending", "Pair this Mac", null],
      ["link", "pending", "Open the connection", null],
    ]);
  });

  it("marks the step a question waits on for attention, not as running", () => {
    const rows = stepRows(
      view({
        status: "question",
        steps: STEPS.map((id) => ({ id, status: id === "connect" ? "running" : "pending" })),
      }),
    );
    expect(rows[0]).toMatchObject({ mark: "attention", label: "Connect" });
  });

  it("badges the tile for a failure or a question only", () => {
    expect(flowBadge(view({ status: "failed" }))).toBe("fail");
    expect(flowBadge(view({ status: "question" }))).toBe("attention");
    expect(flowBadge(view())).toBeNull();
    expect(flowBadge(view({ status: "done" }))).toBeNull();
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
  it("sums the host up from the registry", () => {
    expect(readySummary(host())).toBe("Linux · Volli host 1.1.0");
    expect(readySummary(host({ os: "macos", version: null }))).toBe("macOS");
    expect(readySummary(host({ os: null, version: null }))).toBe("Ready");
    expect(readySummary(undefined)).toBe("Ready");
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
