import { readHostError } from "@volli/host-protocol";
import type { HostLinkCalls } from "@volli/host-protocol/client-link";
import { EMPTY_SESSION_USAGE_SUMMARY, PERSON_STARTED } from "@volli/shared";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  closedListingReader,
  closedRemoteTransport,
  isNotGranted,
  remoteListingReader,
  remoteSessionClient,
  sessionsUnavailableOn,
} from "./remote-session-wire";

const flushHost = {
  requestAnimationFrame: () => 1,
  cancelAnimationFrame: () => undefined,
  setTimeout: () => 1,
  clearTimeout: () => undefined,
};

/** A link whose every call fails with the host error given. */
function failing(hostError: { code: string; message: string; reason?: string }): HostLinkCalls {
  return {
    query: async () => Promise.reject(hostError),
    mutate: async () => Promise.reject(hostError),
    subscribe: (_path, _input, handlers) => {
      queueMicrotask(() => handlers.onError(hostError));
      return { unsubscribe: () => {} };
    },
  };
}

async function failureOf(call: Promise<unknown>) {
  try {
    await call;
  } catch (error) {
    return { message: (error as Error).message, hostError: readHostError(error) };
  }
  throw new Error("expected a failure");
}

describe("a remote Workspace's client names its host (VC-713, B3)", () => {
  it("says an operation an older host never granted is not available there", async () => {
    const client = remoteSessionClient(
      failing({ code: "FORBIDDEN", message: "not among the operations", reason: "verb-refused" }),
      "hetzner-1",
    );
    const failure = await failureOf(client.session.snapshot.query({ sessionId: "s" }));
    expect(failure.message).toBe(sessionsUnavailableOn("hetzner-1"));
    expect(failure.hostError).toMatchObject({ code: "FORBIDDEN", reason: "verb-refused" });
    expect(isNotGranted(failure.hostError)).toBe(true);
  });

  it("says a link that is not connected in the host's name, and leaves every other failure alone", async () => {
    const unreachable = remoteSessionClient(
      failing({
        code: "SERVICE_UNAVAILABLE",
        message: "can't be reached",
        reason: "host-unreachable",
      }),
      "hetzner-1",
    );
    expect(
      (
        await failureOf(
          unreachable.sessions.create.mutate({
            operationId: "o",
            projectId: "p",
            ticketId: null,
            title: null,
          }),
        )
      ).message,
    ).toBe("hetzner-1 isn’t connected");
    const resnapshot = remoteSessionClient(
      failing({
        code: "PRECONDITION_FAILED",
        message: "resnapshot",
        reason: "subscription-resnapshot-required",
      }),
      "hetzner-1",
    );
    const failure = await failureOf(resnapshot.session.projection.query({ sessionId: "s" }));
    expect(failure.message).toBe("resnapshot");
    expect(failure.hostError.reason).toBe("subscription-resnapshot-required");
    expect(isNotGranted(failure.hostError)).toBe(false);
  });

  it("streams an answer through untouched", async () => {
    const answer = { sessions: [], omitted: 0 };
    const client = remoteSessionClient(
      {
        query: async () => answer,
        mutate: async () => answer,
        subscribe: () => ({ unsubscribe: () => {} }),
      },
      "hetzner-1",
    );
    expect(await client.session.listing.query({ projectId: "p" })).toEqual(answer);
  });
});

describe("the listing reader (VC-713)", () => {
  const row = {
    kind: "chat" as const,
    record: {
      sessionId: "s",
      title: "t",
      projectId: "p",
      ticketId: null,
      createdAt: 1,
      adapterId: "pi",
      live: false,
      activity: "idle" as const,
      waitingOn: null,
      outcome: null,
      lastActivityAt: 1,
      bornTicketless: true,
      role: "project" as const,
      parentSessionId: null,
      model: null,
    },
    usage: EMPTY_SESSION_USAGE_SUMMARY,
    provenance: PERSON_STARTED,
  };

  it("answers an operation never granted as an empty listing, once said (B3)", async () => {
    const notGranted = vi.fn();
    const reader = remoteListingReader(
      remoteSessionClient(
        failing({ code: "FORBIDDEN", message: "no", reason: "verb-refused" }),
        "hetzner-1",
      ),
      notGranted,
    );
    expect(await reader.list({ projectId: "p" })).toEqual({ ok: true, sessions: [] });
    expect(await reader.listForTicket({ ticketId: "t" })).toEqual({ ok: true, sessions: [] });
    expect(notGranted).toHaveBeenCalledTimes(2);
  });

  it("says any other failure, and reads rows through", async () => {
    const failingReader = remoteListingReader(
      remoteSessionClient(
        failing({ code: "SERVICE_UNAVAILABLE", message: "x", reason: "host-unreachable" }),
        "hetzner-1",
      ),
      () => {},
    );
    expect(await failingReader.list({ projectId: "p" })).toEqual({
      ok: false,
      error: "hetzner-1 isn’t connected",
    });
    const reading = remoteListingReader(
      remoteSessionClient(
        {
          query: async () => ({ sessions: [row], omitted: 0 }),
          mutate: async () => null,
          subscribe: () => ({ unsubscribe: () => {} }),
        },
        "hetzner-1",
      ),
      () => {},
    );
    expect(await reading.list({ projectId: "p" })).toEqual({ ok: true, sessions: [row] });
  });

  it("refuses every read of a project whose Workspace is not bound (B1)", async () => {
    const reader = closedListingReader("hetzner-1");
    expect(await reader.list({ projectId: "p" })).toEqual({
      ok: false,
      error: "hetzner-1 isn’t connected",
    });
    expect(await reader.listForTicket({ ticketId: "t" })).toEqual({
      ok: false,
      error: "hetzner-1 isn’t connected",
    });
  });
});

describe("the closed transport (VC-713, B1)", () => {
  it("refuses every call and ends every stream in the host's name", async () => {
    const transport = closedRemoteTransport("hetzner-1", flushHost);
    expect(transport.streamRecovery).toBe("host-link");
    expect(transport.newCommandId()).not.toBe(transport.newCommandId());
    await expect(transport.rpc.session.command.mutate({} as never)).rejects.toThrow(
      "hetzner-1 isn’t connected",
    );
    await expect(transport.attachSession({ operationId: "o", sessionId: "s" })).rejects.toThrow(
      "hetzner-1 isn’t connected",
    );
    const onError = vi.fn();
    const handlers = { onStarted: vi.fn(), onData: vi.fn(), onError, onComplete: vi.fn() };
    transport.rpc.session.subscribe.subscribe({ sessionId: "s" }, handlers);
    // One let go before the failure lands hears nothing.
    transport.rpc.session.subscribeQueue!.subscribe({ sessionId: "s" }, handlers).unsubscribe();
    await Promise.resolve();
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]![0] as Error).message).toBe("hetzner-1 isn’t connected");
  });
});
