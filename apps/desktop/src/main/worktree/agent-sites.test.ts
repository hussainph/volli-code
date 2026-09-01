import { describe, expect, it } from "vite-plus/test";
import type { OpenNativeBinding } from "@volli/session-engine";

import {
  agentSitesWithin,
  agentTurnOpenWithin,
  countOpenAgentTurns,
  releaseAgentSites,
  type AgentSiteRuntime,
} from "./agent-sites";

interface FakeSession {
  attachmentId: string;
  directory: string;
  turnActive?: boolean;
  /** Thrown by `projection` — the unreadable-ledger case. */
  projectionFailure?: Error;
  /** Thrown by `command` — the executor that would not stop. */
  releaseFailure?: Error;
  /** A release that resolves but leaves the binding open (the silent-leak case). */
  releaseKeepsBinding?: boolean;
}

interface FakeRuntime extends AgentSiteRuntime {
  releases: { sessionId: string; attachmentId: string; commandId: string }[];
  projections: string[];
}

function fakeRuntime(sessions: Record<string, FakeSession>): FakeRuntime {
  const live = new Map(Object.entries(sessions));
  const releases: FakeRuntime["releases"] = [];
  const projections: string[] = [];
  return {
    releases,
    projections,
    openNativeBindings(): readonly OpenNativeBinding[] {
      return [...live.entries()].map(([sessionId, session]) => ({
        sessionId,
        directory: session.directory,
        attachmentId: session.attachmentId,
        lastProgressAt: 0,
      }));
    },
    async projection({ sessionId }) {
      projections.push(sessionId);
      const session = live.get(sessionId);
      if (session?.projectionFailure) throw session.projectionFailure;
      return { projection: { turnActive: session?.turnActive === true } };
    },
    async command(request) {
      const session = live.get(request.sessionId);
      if (session?.releaseFailure) throw session.releaseFailure;
      releases.push({
        sessionId: request.sessionId,
        attachmentId: request.command.attachmentId,
        commandId: request.commandId,
      });
      if (session?.releaseKeepsBinding !== true) live.delete(request.sessionId);
      return {};
    },
  };
}

function ids(): () => string {
  let n = 0;
  return () => `command-${++n}`;
}

const swallow = () => undefined;

describe("agentSitesWithin", () => {
  it("takes the bindings at and under the directory, and nothing beside it", () => {
    const runtime = fakeRuntime({
      "at-target": { attachmentId: "a-1", directory: "/w/VC-1" },
      nested: { attachmentId: "a-2", directory: "/w/VC-1/packages/app" },
      // A prefix match on the raw string, which is not containment.
      sibling: { attachmentId: "a-3", directory: "/w/VC-10" },
      elsewhere: { attachmentId: "a-4", directory: "/repo" },
    });

    expect(agentSitesWithin(runtime, "/w/VC-1").map(({ sessionId }) => sessionId)).toEqual([
      "at-target",
      "nested",
    ]);
  });
});

describe("countOpenAgentTurns", () => {
  it("counts every binding with a turn open, wherever it lives — idle attachments are not busy", async () => {
    const runtime = fakeRuntime({
      working: { attachmentId: "a-1", directory: "/w/VC-1", turnActive: true },
      idle: { attachmentId: "a-2", directory: "/w/VC-2" },
      elsewhere: { attachmentId: "a-3", directory: "/repo", turnActive: true },
    });

    expect(await countOpenAgentTurns(runtime, swallow)).toBe(2);
  });

  it("an unreadable Session is reported and not counted — fail-open, like the worktree gate", async () => {
    const failures: string[] = [];
    const runtime = fakeRuntime({
      broken: {
        attachmentId: "a-1",
        directory: "/w/VC-1",
        projectionFailure: new Error("ledger unreadable"),
      },
      working: { attachmentId: "a-2", directory: "/w/VC-2", turnActive: true },
    });

    expect(await countOpenAgentTurns(runtime, (sessionId) => failures.push(sessionId))).toBe(1);
    expect(failures).toEqual(["broken"]);
  });
});

describe("agentTurnOpenWithin", () => {
  it("is false for a binding with no turn open — attachment alone is not busy", async () => {
    const runtime = fakeRuntime({ idle: { attachmentId: "a-1", directory: "/w/VC-1" } });

    expect(await agentTurnOpenWithin(runtime, "/w/VC-1", swallow)).toBe(false);
  });

  it("is true when a binding under the directory has a turn open", async () => {
    const runtime = fakeRuntime({
      idle: { attachmentId: "a-1", directory: "/w/VC-1" },
      working: { attachmentId: "a-2", directory: "/w/VC-1/src", turnActive: true },
    });

    expect(await agentTurnOpenWithin(runtime, "/w/VC-1", swallow)).toBe(true);
  });

  it("never reads a projection for a binding outside the directory", async () => {
    const runtime = fakeRuntime({
      here: { attachmentId: "a-1", directory: "/w/VC-1" },
      elsewhere: { attachmentId: "a-2", directory: "/w/VC-2", turnActive: true },
    });

    // The bound cost is the whole point: one destructive action must not replay
    // the ledger of every chat this launch has opened.
    expect(await agentTurnOpenWithin(runtime, "/w/VC-1", swallow)).toBe(false);
    expect(runtime.projections).toEqual(["here"]);
  });

  it("fails open on an unreadable Session, and reports which one", async () => {
    const runtime = fakeRuntime({
      broken: {
        attachmentId: "a-1",
        directory: "/w/VC-1",
        projectionFailure: new Error("ledger corrupt"),
      },
    });
    const unreadable: string[] = [];

    expect(
      await agentTurnOpenWithin(runtime, "/w/VC-1", (sessionId) => unreadable.push(sessionId)),
    ).toBe(false);
    expect(unreadable).toEqual(["broken"]);
  });
});

describe("releaseAgentSites", () => {
  it("releases every binding rooted at the directory, by attachment", async () => {
    const runtime = fakeRuntime({
      "chat-1": { attachmentId: "a-1", directory: "/w/VC-1" },
      "chat-2": { attachmentId: "a-2", directory: "/w/VC-1/src" },
      untouched: { attachmentId: "a-3", directory: "/w/VC-2" },
    });

    const report = await releaseAgentSites(runtime, "/w/VC-1", {
      newCommandId: ids(),
      onError: swallow,
    });

    expect(runtime.releases).toEqual([
      { sessionId: "chat-1", attachmentId: "a-1", commandId: "command-1" },
      { sessionId: "chat-2", attachmentId: "a-2", commandId: "command-2" },
    ]);
    expect(report).toEqual({ released: ["chat-1", "chat-2"], stillOpen: [] });
    expect(agentSitesWithin(runtime, "/w/VC-2")).toHaveLength(1);
  });

  it("is a no-op the second time, without issuing a command", async () => {
    const runtime = fakeRuntime({ "chat-1": { attachmentId: "a-1", directory: "/w/VC-1" } });
    const newCommandId = ids();

    await releaseAgentSites(runtime, "/w/VC-1", { newCommandId, onError: swallow });
    const second = await releaseAgentSites(runtime, "/w/VC-1", { newCommandId, onError: swallow });

    expect(second).toEqual({ released: [], stillOpen: [] });
    expect(runtime.releases).toHaveLength(1);
  });

  it("does nothing at all for a directory with no bindings", async () => {
    const runtime = fakeRuntime({ elsewhere: { attachmentId: "a-1", directory: "/w/VC-2" } });

    expect(
      await releaseAgentSites(runtime, "/w/VC-1", { newCommandId: ids(), onError: swallow }),
    ).toEqual({ released: [], stillOpen: [] });
    expect(runtime.releases).toEqual([]);
  });

  it("reports a throwing release as still open, and keeps going", async () => {
    const runtime = fakeRuntime({
      broken: {
        attachmentId: "a-1",
        directory: "/w/VC-1",
        releaseFailure: new Error("executor gone"),
      },
      "chat-2": { attachmentId: "a-2", directory: "/w/VC-1" },
    });
    const errors: string[] = [];

    const report = await releaseAgentSites(runtime, "/w/VC-1", {
      newCommandId: ids(),
      onError: (sessionId) => errors.push(sessionId),
    });

    expect(errors).toEqual(["broken"]);
    // Never throws: the caller's alternative is refusing a delete, which is how
    // a worktree becomes unremovable by any route.
    expect(report).toEqual({ released: ["chat-2"], stillOpen: ["broken"] });
  });

  it("reports a release that resolved but left the binding open", async () => {
    // The receipt is not the evidence — whether the binding is still listed is.
    const runtime = fakeRuntime({
      stubborn: { attachmentId: "a-1", directory: "/w/VC-1", releaseKeepsBinding: true },
    });

    const report = await releaseAgentSites(runtime, "/w/VC-1", {
      newCommandId: ids(),
      onError: swallow,
    });

    expect(runtime.releases).toHaveLength(1);
    expect(report).toEqual({ released: [], stillOpen: ["stubborn"] });
  });
});
