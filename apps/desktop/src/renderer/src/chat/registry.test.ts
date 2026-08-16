import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type {
  ChatSessionClientDeps,
  ChatSessionRpc,
  ChatSessionWrites,
} from "@renderer/chat/client";
import {
  disposeChatClient,
  getChatClient,
  getOrCreateChatClient,
  liveChatClients,
  onLiveChatClientsChanged,
} from "@renderer/chat/registry";

const unreachable = () => {
  throw new Error("the registry must not touch the transport");
};

/**
 * Deps that answer nothing. Every test here is about the map, and a client only
 * reaches its transport once something asks it to connect.
 */
function deps(): ChatSessionClientDeps {
  const writes = {
    sessions: {},
    applyStream: () => undefined,
    setProjection: () => undefined,
    attaching: () => undefined,
    delivered: () => undefined,
    settle: () => undefined,
    dequeue: () => undefined,
  } satisfies ChatSessionWrites;
  return {
    rpc: {
      session: {
        snapshot: { query: unreachable },
        projection: { query: unreachable },
        subscribe: { subscribe: unreachable },
        command: { mutate: unreachable },
        cancelInteraction: { mutate: unreachable },
        reconcile: { mutate: unreachable },
      },
    } as unknown as ChatSessionRpc,
    store: { getState: () => writes, subscribe: () => () => undefined },
    scheduler: { schedule: () => () => undefined },
    newCommandId: () => "cmd",
    createSession: unreachable,
    attachSession: unreachable,
  };
}

const registered: string[] = [];

function register(sessionId: string) {
  registered.push(sessionId);
  return getOrCreateChatClient(sessionId, deps());
}

afterEach(() => {
  for (const sessionId of registered) disposeChatClient(sessionId);
  registered.length = 0;
});

describe("getOrCreateChatClient", () => {
  it("hands back the same client for the same Session", () => {
    const first = register("s1");

    expect(register("s1")).toBe(first);
    expect(first.sessionId).toBe("s1");
  });

  it("keeps one client per Session", () => {
    register("s1");
    register("s2");

    expect(liveChatClients().map((client) => client.sessionId)).toEqual(["s1", "s2"]);
  });
});

describe("getChatClient", () => {
  it("looks up without constructing", () => {
    expect(getChatClient("never-opened")).toBeUndefined();
    expect(liveChatClients()).toHaveLength(0);
  });

  it("finds a registered client", () => {
    const client = register("s1");

    expect(getChatClient("s1")).toBe(client);
  });
});

describe("disposeChatClient", () => {
  it("forgets the client before disposing it", () => {
    // A watcher that recomputes from the registry on the way out must never see
    // the dying client counted as a live one.
    let seen: readonly string[] = ["unset"];
    register("s1");
    const stop = onLiveChatClientsChanged(() => {
      seen = liveChatClients().map((client) => client.sessionId);
    });

    disposeChatClient("s1");

    expect(seen).toEqual([]);
    expect(getChatClient("s1")).toBeUndefined();
    stop();
  });

  it("is a no-op for a Session that was never registered", () => {
    let announcements = 0;
    const stop = onLiveChatClientsChanged(() => {
      announcements += 1;
    });

    disposeChatClient("never-opened");

    expect(announcements).toBe(0);
    stop();
  });
});

describe("onLiveChatClientsChanged", () => {
  it("announces the set growing and shrinking, and stops on unsubscribe", () => {
    let announcements = 0;
    const stop = onLiveChatClientsChanged(() => {
      announcements += 1;
    });

    register("s1");
    disposeChatClient("s1");
    expect(announcements).toBe(2);

    stop();
    register("s2");

    expect(announcements).toBe(2);
  });

  it("lets a throwing watcher fail without aborting the dispose it observed", () => {
    // An exception escaping here would strand every subscription after it.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const stop = onLiveChatClientsChanged(() => {
      throw new Error("watcher is broken");
    });
    register("s1");

    expect(() => {
      disposeChatClient("s1");
    }).not.toThrow();
    expect(getChatClient("s1")).toBeUndefined();

    stop();
    warn.mockRestore();
  });

  it("walks a snapshot, so a watcher unsubscribing itself cannot skip its neighbour", () => {
    let neighbour = 0;
    const stopFirst = onLiveChatClientsChanged(() => {
      stopFirst();
    });
    const stopSecond = onLiveChatClientsChanged(() => {
      neighbour += 1;
    });

    register("s1");

    expect(neighbour).toBe(1);
    stopSecond();
  });
});
