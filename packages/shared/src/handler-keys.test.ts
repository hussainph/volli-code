import { describe, expect, expectTypeOf, it } from "vite-plus/test";

import { DESKTOP_ENTRIES, type DesktopKey } from "./desktop-entries";
import {
  AGENT_HANDLER_KEYS,
  CATALOG_HANDLER_KEYS,
  DESKTOP_HANDLER_KEYS,
  DOOR_LOCAL_CATALOG_KEYS,
  HANDLER_PROJECTION_KEYS,
  HOST_HANDLER_KEYS,
  PUBLIC_HANDLER_KEYS,
  SERVED_AGENT_HANDLER_KEYS,
  SHARED_AGENT_HANDLER_KEYS,
  SOCKET_BOARD_PROJECTIONS,
  SOCKET_DELEGATED_HANDLER_KEYS,
  type AgentHandlerKey,
  type ServedAgentHandlerKey,
  type SharedAgentHandlerKey,
  type SharedAgentHandlerKeysExact,
  type CatalogHandlerKey,
  type HostHandlerKey,
  type HostHandlerKeyOf,
  type SocketHandlerKey,
} from "./handler-keys";
import {
  AGENT_COMMAND_BINDINGS,
  AGENT_COMMANDS,
  BOARD_ENTRIES,
  CATALOG_ENTRIES,
  VERB_REGISTRY,
  VERB_TOOL_KEYS,
  isVerbToolKey,
  verbEntry,
  type AgentCommandBindingId,
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

  // D-A1 = (c): one map, two catalog tiers, no key in both; and the agent
  // doors' own keys beside them (VC-923).
  it("are the catalog's two tiers and the agent doors' keys, which share no key", () => {
    expect(CATALOG_HANDLER_KEYS).toEqual([...PUBLIC_HANDLER_KEYS, ...DESKTOP_HANDLER_KEYS]);
    expect(HOST_HANDLER_KEYS).toEqual([...CATALOG_HANDLER_KEYS, ...AGENT_HANDLER_KEYS]);
    expect(new Set(HOST_HANDLER_KEYS).size).toBe(HOST_HANDLER_KEYS.length);
    expect(DESKTOP_HANDLER_KEYS).toEqual(DESKTOP_ENTRIES.map(({ key }) => key));
    expect(Object.isFrozen(DESKTOP_HANDLER_KEYS)).toBe(true);
    expect(Object.isFrozen(CATALOG_HANDLER_KEYS)).toBe(true);
    expect(Object.isFrozen(AGENT_HANDLER_KEYS)).toBe(true);
    const registry = new Set<string>(VERB_REGISTRY.map(({ key }) => key));
    for (const key of DESKTOP_HANDLER_KEYS) expect(registry.has(key), key).toBe(false);
    expectTypeOf<Extract<DesktopKey, HostHandlerKey>>().toEqualTypeOf<DesktopKey>();
    expectTypeOf<Extract<AgentHandlerKey, CatalogHandlerKey>>().toEqualTypeOf<never>();
  });

  it("give every socket verb a key: a catalog command's, a board write's, or its own (VC-923)", () => {
    const catalog = new Set<string>(CATALOG_ENTRIES.map(({ key }) => key));
    const board: Readonly<Record<string, string>> = SOCKET_BOARD_PROJECTIONS;
    for (const command of AGENT_COMMANDS) {
      const id = AGENT_COMMAND_BINDINGS[command];
      const key = board[id] ?? id;
      expect(HOST_HANDLER_KEYS, command).toContain(key);
      expect((AGENT_HANDLER_KEYS as readonly string[]).includes(id), command).toBe(
        !catalog.has(id) && board[id] === undefined,
      );
    }
    for (const key of Object.values(board)) expect(catalog.has(key), key).toBe(true);
    expect(Object.isFrozen(SOCKET_BOARD_PROJECTIONS)).toBe(true);
  });

  it("give every tool verb its own agent key, and share only the start with the socket", () => {
    for (const key of VERB_TOOL_KEYS) expect(AGENT_HANDLER_KEYS, key).toContain(key);
    const socket = new Set<string>(Object.values(AGENT_COMMAND_BINDINGS));
    expect(AGENT_HANDLER_KEYS.filter((key) => socket.has(key) && isVerbToolKey(key))).toEqual([
      ...SHARED_AGENT_HANDLER_KEYS,
    ]);
    expect(SERVED_AGENT_HANDLER_KEYS).toEqual(
      AGENT_HANDLER_KEYS.filter((key) => key !== "session.start"),
    );
    expect(Object.isFrozen(SHARED_AGENT_HANDLER_KEYS)).toBe(true);
    expect(Object.isFrozen(SERVED_AGENT_HANDLER_KEYS)).toBe(true);
    expectTypeOf<SharedAgentHandlerKeysExact>().toEqualTypeOf<never>();
    expectTypeOf<Extract<ServedAgentHandlerKey, SharedAgentHandlerKey>>().toEqualTypeOf<never>();
  });

  it("name the both-door commands, each bound on the socket under its own key", () => {
    expectTypeOf<SocketHandlerKey>().toEqualTypeOf<
      "ticket.move" | Extract<AgentHandlerKey, AgentCommandBindingId>
    >();
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
    // No router family projects an agent door's key.
    expectTypeOf<
      Extract<HostHandlerKeyOf<(typeof CATALOG_ENTRIES)[number]>, AgentHandlerKey>
    >().toEqualTypeOf<never>();
    // The lab's diagnostics are the router's own, so no family projects them.
    expectTypeOf<
      Extract<"labDiagnostics.list" | "labDiagnostics.subscribe", HostHandlerKey>
    >().toEqualTypeOf<never>();
  });
});
