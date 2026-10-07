import type { HostLinkState } from "@volli/host-protocol/client-link";
import { describe, expect, it } from "vite-plus/test";

import { nextRemoteHostLink, remoteHostLinkState, versionFacts } from "./remote-hosts-link";
import type { TunnelState } from "./tunnel";

const WELCOME = {
  protocolVersion: 1,
  host: { id: "0f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f", version: "1.1.0" },
  workspace: { id: "2f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f", epoch: 1 },
  actor: { kind: "device" },
  features: [],
  proof: null,
} as unknown as Extract<HostLinkState, { status: "ready" }>["welcome"];

const READY: HostLinkState = { status: "ready", welcome: WELCOME };
const CONNECTING: HostLinkState = { status: "connecting", attempt: 2 };
const REFUSED: HostLinkState = {
  status: "refused",
  error: { code: "UNAUTHORIZED", reason: "credential-invalid", message: "No." },
  closeCode: 4401,
};
const FENCED: HostLinkState = {
  status: "fenced",
  error: { code: "PRECONDITION_FAILED", reason: "workspace-epoch-fenced", message: "Moved." },
};
const UNREACHABLE: HostLinkState = {
  status: "unreachable",
  attempt: 3,
  // A link's own error may carry no reason.
  error: { code: "SERVICE_UNAVAILABLE", message: "Gone." },
  closeCode: 1006,
  retryAt: 5_000,
};
const CLOSED: HostLinkState = { status: "closed" };

const UP: TunnelState = { status: "up", url: "ws://127.0.0.1:1", localPort: 1 };
const of = (links: HostLinkState[], tunnel: TunnelState = UP) =>
  remoteHostLinkState({ tunnel, attempt: 4, retryAt: 9_000, links });

describe("a host's link from its Workspace links", () => {
  it("is ready when any link is, the welcome dropped", () => {
    expect(of([REFUSED, READY])).toEqual({ status: "ready" });
  });

  it("is refused, then fenced, before unreachable or connecting", () => {
    expect(of([UNREACHABLE, FENCED, REFUSED])).toEqual({
      status: "refused",
      error: { code: "UNAUTHORIZED", reason: "credential-invalid", message: "No." },
      closeCode: 4401,
    });
    expect(of([UNREACHABLE, FENCED])).toEqual({
      status: "fenced",
      error: { code: "PRECONDITION_FAILED", reason: "workspace-epoch-fenced", message: "Moved." },
    });
  });

  it("is unreachable before connecting, the link's own retry and close code kept", () => {
    expect(of([CONNECTING, UNREACHABLE])).toEqual({
      status: "unreachable",
      attempt: 3,
      error: { code: "SERVICE_UNAVAILABLE", reason: "", message: "Gone." },
      closeCode: 1006,
      retryAt: 5_000,
    });
    expect(of([CLOSED, CONNECTING])).toEqual({ status: "connecting", attempt: 2 });
    expect(of([CLOSED])).toEqual({ status: "closed" });
  });

  it("ignores the tunnel while links speak", () => {
    expect(of([CONNECTING], { status: "closed" })).toEqual({ status: "connecting", attempt: 2 });
  });
});

describe("a host's link from its tunnel, with no Workspace open", () => {
  it("maps each tunnel state", () => {
    expect(of([], { status: "starting" })).toEqual({ status: "connecting", attempt: 4 });
    expect(of([], UP)).toEqual({ status: "connecting", attempt: 4 });
    expect(
      remoteHostLinkState({
        tunnel: UP,
        attempt: 4,
        retryAt: 0,
        links: [],
        health: { status: "ready" },
      }),
    ).toEqual({ status: "ready" });
    expect(of([], { status: "down", error: "ssh exited 255", retryInMs: 2_000 })).toEqual({
      status: "unreachable",
      attempt: 4,
      error: { code: "SERVICE_UNAVAILABLE", reason: "host-unreachable", message: "ssh exited 255" },
      closeCode: null,
      retryAt: 9_000,
    });
    expect(of([], { status: "closed" })).toEqual({ status: "closed" });
  });
});

describe("ready since launch, and when it dropped", () => {
  it("anchors a never-ready host's first failure across retries and clears the outage on readiness", () => {
    const initial = nextRemoteHostLink(null, { status: "connecting", attempt: 0 }, 10);
    const failure = nextRemoteHostLink(initial, { status: "closed" }, 20);
    expect(failure).toMatchObject({ everReady: false, droppedAt: 20 });
    const retry = nextRemoteHostLink(failure, { status: "connecting", attempt: 1 }, 30);
    expect(retry).toMatchObject({ everReady: false, droppedAt: 20 });
    expect(nextRemoteHostLink(null, { status: "closed" }, 40).droppedAt).toBe(40);
    const ready = nextRemoteHostLink(retry, { status: "ready" }, 50);
    expect(ready).toMatchObject({ everReady: true, droppedAt: null });
    expect(nextRemoteHostLink(ready, { status: "closed" }, 60).droppedAt).toBe(60);
  });

  it("tracks everReady and droppedAt across changes", () => {
    const first = nextRemoteHostLink(null, { status: "connecting", attempt: 0 }, 10);
    expect(first).toEqual({
      state: { status: "connecting", attempt: 0 },
      everReady: false,
      droppedAt: null,
    });
    const ready = nextRemoteHostLink(first, { status: "ready" }, 20);
    expect(ready).toMatchObject({ everReady: true, droppedAt: null });
    const dropped = nextRemoteHostLink(ready, { status: "connecting", attempt: 0 }, 30);
    expect(dropped).toMatchObject({ everReady: true, droppedAt: 30 });
    const still = nextRemoteHostLink(dropped, { status: "closed" }, 40);
    expect(still).toMatchObject({ everReady: true, droppedAt: 30 });
    expect(nextRemoteHostLink(null, { status: "ready" }, 50)).toEqual({
      state: { status: "ready" },
      everReady: true,
      droppedAt: null,
    });
  });
});

describe("version facts", () => {
  it("offers this app's version to an older host, and says when the host is newer", () => {
    expect(versionFacts("1.0.0", "1.1.0")).toEqual({
      availableUpdate: "1.1.0",
      hostIsNewer: false,
    });
    expect(versionFacts("1.1.0", "1.1.0")).toEqual({ availableUpdate: null, hostIsNewer: false });
    expect(versionFacts("1.2.0", "1.1.0")).toEqual({ availableUpdate: null, hostIsNewer: true });
    expect(versionFacts(null, "1.1.0")).toEqual({ availableUpdate: null, hostIsNewer: false });
  });
});
