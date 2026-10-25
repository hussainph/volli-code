/**
 * The map's one invocation path (VC-668): a door's policy, then the handler,
 * and never the handler without the policy.
 */
import {
  HOST_HANDLER_KEYS,
  isHandlerRefused,
  type HandlerCall,
  type HostHandlerKey,
} from "@volli/shared";
import { describe, expect, expectTypeOf, it, vi } from "vite-plus/test";

import { sealTestHandlers } from "../testing/host-handlers";
import {
  ADMITTED,
  admittedHandlers,
  HandlerNotServedError,
  invokeHandler,
  isHostHandlerMap,
  refused,
  serveHostHandlers,
  type AdmissionRecord,
  type AdmissionVerdict,
  type HandlerPolicy,
  type HostHandlerMap,
} from "./handler-map";
import { ROUTER_POLICY } from "./policies";

const USER: HandlerCall = { actor: { kind: "user" } };
const MOVE = { projectId: "p", ticketId: "t", toStatus: "doing" } as const;

/** A policy that writes its verdict into `log` before answering it. */
function recordingPolicy(
  log: string[],
  verdict: (key: HostHandlerKey) => AdmissionVerdict | Promise<AdmissionVerdict> = () => ADMITTED,
): HandlerPolicy {
  return {
    door: "test-door",
    admit(key, input, call) {
      log.push(`admit ${key} ${JSON.stringify(input)} ${call.actor.kind}`);
      return verdict(key);
    },
  };
}

function recordingMap(log: string[], records: AdmissionRecord[] = []) {
  const move = vi.fn((input: unknown) => {
    log.push(`handle ticket.move ${JSON.stringify(input)}`);
    return [];
  });
  return {
    move,
    map: sealTestHandlers({ "ticket.move": move }, (record) => records.push(record)),
  };
}

describe("a sealed map", () => {
  it("offers no entry a door can call: the type and the object both", () => {
    const { map } = recordingMap([]);
    expectTypeOf<HostHandlerMap>().not.toHaveProperty("ticket.move");
    expect(Object.keys(map)).toEqual([]);
    expect(Object.isFrozen(map)).toBe(true);
    expect(isHostHandlerMap(map)).toBe(true);
    for (const forged of [{}, { "ticket.move": () => [] }, null, "map"]) {
      expect(isHostHandlerMap(forged)).toBe(false);
    }
  });

  it("refuses to invoke anything that is not a sealed map", () => {
    expect(() =>
      invokeHandler({} as HostHandlerMap, recordingPolicy([]), "ticket.move", MOVE, USER),
    ).toThrow("Not a host handler map: build one with createHostHandlers.");
  });

  it("refuses a key the map has no entry for", () => {
    const map = sealTestHandlers({});
    expect(() =>
      invokeHandler(map, recordingPolicy([]), "nope" as "ticket.move", MOVE, USER),
    ).toThrow("The handler map has no nope.");
  });

  it("answers a door's call to a key the test left out with the test's own error", () => {
    expect(() =>
      invokeHandler(sealTestHandlers({}), recordingPolicy([]), "ticket.move", MOVE, USER),
    ).toThrow("This test states no ticket.move handler.");
  });
});

describe("invokeHandler", () => {
  it("runs the door's policy, then the handler, synchronously when both are", () => {
    const log: string[] = [];
    const records: AdmissionRecord[] = [];
    const { map, move } = recordingMap(log, records);
    const answer = invokeHandler(map, recordingPolicy(log), "ticket.move", MOVE, USER);
    expect(answer).toEqual([]);
    expect(log).toEqual([
      `admit ticket.move ${JSON.stringify(MOVE)} user`,
      `handle ticket.move ${JSON.stringify(MOVE)}`,
    ]);
    expect(records).toEqual([{ door: "test-door", key: "ticket.move", admitted: true }]);
    expect(move).toHaveBeenCalledExactlyOnceWith(MOVE, USER);
  });

  it("awaits an asynchronous verdict before the handler", async () => {
    const log: string[] = [];
    const { map } = recordingMap(log);
    const answer = invokeHandler(
      map,
      recordingPolicy(log, async () => ADMITTED),
      "ticket.move",
      MOVE,
      USER,
    );
    expect(answer).toBeInstanceOf(Promise);
    expect(log).toHaveLength(1);
    await expect(answer).resolves.toEqual([]);
    expect(log).toHaveLength(2);
  });

  it("never reaches the handler when the policy refuses, and says why", () => {
    const log: string[] = [];
    const records: AdmissionRecord[] = [];
    const { map, move } = recordingMap(log, records);
    let thrown: unknown;
    try {
      invokeHandler(
        map,
        recordingPolicy(log, () => refused("Not you.", "Ask a person.")),
        "ticket.move",
        MOVE,
        USER,
      );
    } catch (error) {
      thrown = error;
    }
    expect(isHandlerRefused(thrown)).toBe(true);
    expect(thrown).toMatchObject({ message: "Not you.", hint: "Ask a person." });
    expect(move).not.toHaveBeenCalled();
    expect(log).toEqual([`admit ticket.move ${JSON.stringify(MOVE)} user`]);
    expect(records).toEqual([{ door: "test-door", key: "ticket.move", admitted: false }]);
  });

  it("refuses asynchronously too, still without the handler", async () => {
    const { map, move } = recordingMap([]);
    const refusal = { admitted: false, message: "Later, no." } as const;
    await expect(
      invokeHandler(
        map,
        recordingPolicy([], async () => refusal),
        "ticket.move",
        MOVE,
        USER,
      ),
    ).rejects.toMatchObject({ message: "Later, no.", hint: null });
    expect(move).not.toHaveBeenCalled();
  });

  it("fails closed when the policy itself throws", () => {
    const { map, move } = recordingMap([]);
    const broken: HandlerPolicy = {
      door: "broken",
      admit: () => {
        throw new Error("policy store unreadable");
      },
    };
    expect(() => invokeHandler(map, broken, "ticket.move", MOVE, USER)).toThrow(
      "policy store unreadable",
    );
    expect(move).not.toHaveBeenCalled();
  });

  it("passes a subscription's sink through to its handler", async () => {
    const subscribe = vi.fn(async () => () => {});
    const map = sealTestHandlers({ "session.subscribe": subscribe });
    const sink = { emit: vi.fn(), fail: vi.fn() };
    const input = { sessionId: "s", afterSequence: 0 };
    await invokeHandler(map, recordingPolicy([]), "session.subscribe", input, USER, sink);
    expect(subscribe).toHaveBeenCalledExactlyOnceWith(input, USER, sink);
  });
});

// The agent doors' own verbs (VC-923): sealed empty, served once by the
// door that composes their ports, and reached like any other entry.
describe("a served entry", () => {
  const answer = { v: 1, ok: true, data: {} } as const;

  it("is reached through the policy once served, and unavailable before", async () => {
    const log: string[] = [];
    const map = sealTestHandlers({});
    const policy = recordingPolicy(log);
    const call = () =>
      invokeHandler(map, policy, "identify", {} as never, USER) as Promise<unknown>;
    await expect(Promise.resolve().then(call)).rejects.toBeInstanceOf(HandlerNotServedError);
    const identify = vi.fn(async () => answer);
    serveHostHandlers(map, { identify });
    await expect(call()).resolves.toBe(answer);
    expect(identify).toHaveBeenCalledOnce();
    expect(log).toEqual(["admit identify {} user", "admit identify {} user"]);
  });

  it("is never served over a sealed entry or a served one, and a refused serve serves nothing", async () => {
    const identify = vi.fn(async () => answer);
    const board = vi.fn(async () => answer);
    const sealed = sealTestHandlers({ identify });
    expect(() => serveHostHandlers(sealed, { board, identify })).toThrow(
      "The handler map already serves identify.",
    );
    await expect(
      Promise.resolve().then(() =>
        invokeHandler(sealed, recordingPolicy([]), "board", {} as never, USER),
      ),
    ).rejects.toBeInstanceOf(HandlerNotServedError);
    const map = sealTestHandlers({});
    serveHostHandlers(map, { board });
    expect(() => serveHostHandlers(map, { board })).toThrow(
      "The handler map already serves board.",
    );
    expect(() => serveHostHandlers({} as HostHandlerMap, { board })).toThrow(
      "Not a host handler map",
    );
  });

  it("is never reached past a refusing policy, a router's included", async () => {
    const identify = vi.fn(async () => answer);
    const map = sealTestHandlers({});
    serveHostHandlers(map, { identify });
    const view = admittedHandlers(map, ROUTER_POLICY);
    await expect(Promise.resolve().then(() => view.identify({} as never, USER))).rejects.toSatisfy(
      isHandlerRefused,
    );
    expect(identify).not.toHaveBeenCalled();
  });
});

describe("admittedHandlers", () => {
  it("is every key of the map, each one through the policy", () => {
    const log: string[] = [];
    const { map, move } = recordingMap(log);
    const view = admittedHandlers(
      map,
      recordingPolicy(log, () => refused("No.")),
    );
    expect(Object.keys(view).toSorted()).toEqual([...HOST_HANDLER_KEYS].toSorted());
    expect(Object.isFrozen(view)).toBe(true);
    expect(() => view["ticket.move"](MOVE, USER)).toThrow("No.");
    expect(move).not.toHaveBeenCalled();
    expect(log).toHaveLength(1);
  });
});
