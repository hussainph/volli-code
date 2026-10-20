import { describe, expect, expectTypeOf, it } from "vite-plus/test";

import { DESKTOP_ENTRIES, type DesktopKey } from "./desktop-entries";
import {
  DESKTOP_HANDLER_KEYS,
  DOOR_LOCAL_CATALOG_KEYS,
  HANDLER_PROJECTION_KEYS,
  HOST_HANDLER_KEYS,
  PUBLIC_HANDLER_KEYS,
  SOCKET_DELEGATED_HANDLER_KEYS,
  type HostHandlerKey,
  type HostHandlerKeyOf,
  type SocketHandlerKey,
} from "./handler-keys";
import {
  AGENT_COMMAND_BINDINGS,
  BOARD_ENTRIES,
  CATALOG_ENTRIES,
  VERB_REGISTRY,
  verbEntry,
} from "./verb-registry";

describe("the host handler map's keys", () => {
  it("are every catalog key but the ones a door answers itself", () => {
    expect(
      [...PUBLIC_HANDLER_KEYS, ...DOOR_LOCAL_CATALOG_KEYS, ...HANDLER_PROJECTION_KEYS].toSorted(),
    ).toEqual(CATALOG_ENTRIES.map(({ key }) => key).toSorted());
    expect(HOST_HANDLER_KEYS.some((key) => key.startsWith("labDiagnostics."))).toBe(false);
    expect(Object.isFrozen(HANDLER_PROJECTION_KEYS)).toBe(true);
    expect(HOST_HANDLER_KEYS.some((key) => key.startsWith("hostModels."))).toBe(false);
    expect(Object.isFrozen(HOST_HANDLER_KEYS)).toBe(true);
    expect(Object.isFrozen(PUBLIC_HANDLER_KEYS)).toBe(true);
    expect(Object.isFrozen(DOOR_LOCAL_CATALOG_KEYS)).toBe(true);
  });

  // D-A1 = (c): one map, two tiers, no key in both.
  it("are the union of the public tier and the desktop-only tier, which share no key", () => {
    expect(HOST_HANDLER_KEYS).toEqual([...PUBLIC_HANDLER_KEYS, ...DESKTOP_HANDLER_KEYS]);
    expect(DESKTOP_HANDLER_KEYS).toEqual(DESKTOP_ENTRIES.map(({ key }) => key));
    expect(Object.isFrozen(DESKTOP_HANDLER_KEYS)).toBe(true);
    const registry = new Set<string>(VERB_REGISTRY.map(({ key }) => key));
    for (const key of DESKTOP_HANDLER_KEYS) expect(registry.has(key), key).toBe(false);
    expectTypeOf<Extract<DesktopKey, HostHandlerKey>>().toEqualTypeOf<DesktopKey>();
  });

  it("name the both-door commands, each bound on the socket under its own key", () => {
    expectTypeOf<SocketHandlerKey>().toEqualTypeOf<"ticket.move">();
    for (const key of PUBLIC_HANDLER_KEYS) {
      const entry = verbEntry(key)!;
      if (!entry.accessModes.includes("cli")) continue;
      // The socket projection resolves the map by binding id: a both-door
      // entry whose binding id were not its key would reach another handler.
      expect(entry.handler.id, key).toBe(key);
      expect(AGENT_COMMAND_BINDINGS[key as SocketHandlerKey]).toBe(key);
    }
  });

  it("delegate only the socket's Session reads to the socket's own handler (VC-663, D4)", () => {
    for (const key of SOCKET_DELEGATED_HANDLER_KEYS) {
      expect(HOST_HANDLER_KEYS, key).toContain(key);
      expect(verbEntry(key)!.accessModes, key).toEqual(["cli", "hostApi"]);
    }
    expect(Object.isFrozen(SOCKET_DELEGATED_HANDLER_KEYS)).toBe(true);
    // The handshake's own answer is the door's, never a handler's.
    expect(HOST_HANDLER_KEYS).not.toContain("protocol.welcome");
  });

  it("type each router family by its own rows", () => {
    // The board family: the both-door move (VC-668), and its own router-only
    // operations under `board.` (VC-565), none of which a socket verb binds.
    expectTypeOf<
      Exclude<HostHandlerKeyOf<(typeof BOARD_ENTRIES)[number]>, "ticket.move" | `board.${string}`>
    >().toEqualTypeOf<never>();
    expectTypeOf<
      Extract<HostHandlerKeyOf<(typeof BOARD_ENTRIES)[number]>, SocketHandlerKey>
    >().toEqualTypeOf<"ticket.move">();
    // The lab's diagnostics are the router's own, so no family projects them.
    expectTypeOf<
      Extract<"labDiagnostics.list" | "labDiagnostics.subscribe", HostHandlerKey>
    >().toEqualTypeOf<never>();
  });
});
