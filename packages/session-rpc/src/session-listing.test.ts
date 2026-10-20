// The Session listing as router procedures (VC-713): Workspace-scoped, the
// person's, its answer validated against the frozen wire grammar.
import type { HostActor } from "@volli/host-protocol";
import {
  BOARD_RESOURCE_KINDS,
  EMPTY_SESSION_USAGE_SUMMARY,
  PERSON_STARTED,
  type SessionListingPage,
} from "@volli/shared";
import { describe, expect, it, vi } from "vite-plus/test";

import { hostErrorOf, type RouterCaller, type WorkspaceResource } from "./catalog";
import { createSessionRouter, RpcDiagnosticLog, type SessionRouterContext } from "./index";
import { sessionHandlersFrom, type LegacySessionPorts } from "./session-handlers.test-support";

const WORKSPACE = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
const OTHER_WORKSPACE = "0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d";
const TICKET = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const DEVICE = "7e8d9c0b-1a2f-4e3d-9c4b-5a6f7e8d9c0b";

const device: HostActor = { kind: "device", deviceId: DEVICE, workspaceId: WORKSPACE };
const network = (actor: HostActor): RouterCaller => ({ actor, current: () => true });

const PAGE: SessionListingPage = {
  sessions: [
    {
      kind: "chat",
      record: {
        sessionId: "c0ffee00-0000-4000-8000-000000000001",
        title: "Waiting on you",
        projectId: WORKSPACE,
        ticketId: TICKET,
        createdAt: 1,
        adapterId: "pi",
        live: true,
        activity: "waiting",
        waitingOn: "question",
        outcome: null,
        lastActivityAt: 2,
        bornTicketless: false,
        role: "ticket",
        parentSessionId: null,
        model: null,
      },
      usage: EMPTY_SESSION_USAGE_SUMMARY,
      provenance: PERSON_STARTED,
    },
  ],
  omitted: 0,
};

function router(caller: RouterCaller, listSessions?: LegacySessionPorts["listSessions"]) {
  const context: SessionRouterContext = {
    caller,
    diagnostics: new RpcDiagnosticLog(),
    // A ticket is this Workspace's when it is the one ticket the case names.
    resourceWorkspace: async (resource: WorkspaceResource) =>
      resource.kind === BOARD_RESOURCE_KINDS.ticket && resource.id === TICKET ? WORKSPACE : null,
    handlers: sessionHandlersFrom({
      runtime: {},
      ...(listSessions === undefined ? {} : { listSessions }),
    }),
  };
  return createSessionRouter().createCaller(context);
}

async function refusal(call: Promise<unknown>): Promise<unknown> {
  try {
    await call;
  } catch (error) {
    return hostErrorOf(error);
  }
  throw new Error("Expected the router to refuse this call");
}

describe("the Session listing (VC-713)", () => {
  it("answers a Workspace's rows and one ticket's, through the map", async () => {
    const list = vi.fn(async () => PAGE);
    const caller = router(network(device), list);
    expect(await caller.session.listing({ projectId: WORKSPACE })).toStrictEqual(PAGE);
    expect(await caller.session.listingForTicket({ ticketId: TICKET })).toStrictEqual(PAGE);
    expect(list.mock.calls).toStrictEqual([[{ projectId: WORKSPACE }], [{ ticketId: TICKET }]]);
  });

  it("refuses another Workspace, and another Workspace's ticket, before the map is asked", async () => {
    const list = vi.fn(async () => PAGE);
    const caller = router(network(device), list);
    expect(await refusal(caller.session.listing({ projectId: OTHER_WORKSPACE }))).toMatchObject({
      code: "NOT_FOUND",
      reason: "workspace-unknown",
    });
    expect(
      await refusal(caller.session.listingForTicket({ ticketId: "someone-elses-ticket" })),
    ).toMatchObject({ code: "NOT_FOUND", reason: "workspace-unknown" });
    expect(list).not.toHaveBeenCalled();
  });

  it("is the person's: a Session in the same Workspace is refused", async () => {
    const list = vi.fn(async () => PAGE);
    const session: HostActor = {
      kind: "session",
      sessionId: "c0ffee00-0000-4000-8000-000000000001",
      workspaceId: WORKSPACE,
    };
    const caller = router(network(session), list);
    expect(await refusal(caller.session.listing({ projectId: WORKSPACE }))).toMatchObject({
      code: "FORBIDDEN",
      reason: "verb-refused",
    });
    expect(list).not.toHaveBeenCalled();
  });

  it("refuses to send a page the frozen grammar does not allow", async () => {
    const caller = router(network(device), async () => ({ ...PAGE, omitted: -1 }));
    expect(await refusal(caller.session.listing({ projectId: WORKSPACE }))).toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
    });
  });

  it("answers unavailable on a host with no listing", async () => {
    const caller = router(network(device));
    expect(await refusal(caller.session.listing({ projectId: WORKSPACE }))).toMatchObject({
      reason: "operation-unavailable",
    });
    expect(await refusal(caller.session.listingForTicket({ ticketId: TICKET }))).toMatchObject({
      reason: "operation-unavailable",
    });
  });
});
