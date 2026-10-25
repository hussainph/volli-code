import { describe, expect, expectTypeOf, it } from "vite-plus/test";

import {
  AGENT_COMMAND_BINDINGS,
  SOCKET_BOARD_PROJECTIONS,
  VERB_TOOL_KEYS,
  type AgentCommandBindingId,
} from "@volli/shared";

import { createCloudBoardVerbs } from "./board-verbs";
import {
  AGENT_DOOR_HANDLER_KEYS,
  agentDoorKeyOf,
  CLOUD_AGENT_ROUTES,
  type AgentDoorHandlerKey,
  type CloudBoardKey,
} from "./routes";

describe("the cloud route table", () => {
  it("classifies every key an agent door reaches, and nothing else", () => {
    expectTypeOf<keyof typeof CLOUD_AGENT_ROUTES>().toEqualTypeOf<AgentDoorHandlerKey>();
    expect(Object.keys(CLOUD_AGENT_ROUTES).toSorted()).toEqual(
      [...AGENT_DOOR_HANDLER_KEYS].toSorted(),
    );
    // Every socket binding (a ticket write under its board key) and every tool verb.
    for (const binding of Object.values(AGENT_COMMAND_BINDINGS)) {
      expect(AGENT_DOOR_HANDLER_KEYS).toContain(agentDoorKeyOf(binding));
    }
    for (const tool of VERB_TOOL_KEYS) expect(AGENT_DOOR_HANDLER_KEYS).toContain(tool);
    expect(new Set(AGENT_DOOR_HANDLER_KEYS).size).toBe(AGENT_DOOR_HANDLER_KEYS.length);
  });

  it("projects the socket's ticket writes onto the board keys they reach", () => {
    for (const [binding, key] of Object.entries(SOCKET_BOARD_PROJECTIONS)) {
      expect(agentDoorKeyOf(binding as AgentCommandBindingId)).toBe(key);
    }
    expect(agentDoorKeyOf("ticket.move")).toBe("ticket.move");
  });

  it("keeps retired tools routable for frozen Sessions", () => {
    expect(CLOUD_AGENT_ROUTES["ticket.await"]).toMatchObject({ route: "cloud-watch" });
    expect(CLOUD_AGENT_ROUTES["session.await"]).toMatchObject({ route: "cloud-watch" });
    expect(CLOUD_AGENT_ROUTES.watch).toMatchObject({ route: "cloud-watch" });
  });

  it("sends the board's reads and writes to the backend, and a project's creation to a person", () => {
    const board = AGENT_DOOR_HANDLER_KEYS.filter(
      (key) => CLOUD_AGENT_ROUTES[key].route === "cloud-board",
    );
    expect(board.toSorted()).toEqual(
      [
        "board",
        "ticket.list",
        "ticket.show",
        "ticket.events",
        "ticket.brief",
        "label.list",
        "project.list",
        "board.createTicket",
        "board.updateTicket",
        "ticket.move",
        "board.createComment",
        "ticket.signal",
        "label.merge",
      ].toSorted(),
    );
    expect(CLOUD_AGENT_ROUTES["project.add"]).toEqual({ route: "person-only" });
    expect(CLOUD_AGENT_ROUTES["session.done"]).toEqual({ route: "ledger" });
    expect(CLOUD_AGENT_ROUTES["identify"]).toEqual({ route: "machine" });
  });

  it("has a cloud verb for every key it routes to the backend", () => {
    const verbs = createCloudBoardVerbs({
      backend: {
        query: async () => null,
        mutation: async () => null,
        action: async () => null,
        forget: () => {},
      },
    });
    expectTypeOf<keyof typeof verbs>().toEqualTypeOf<CloudBoardKey>();
    const routed = AGENT_DOOR_HANDLER_KEYS.filter(
      (key) => CLOUD_AGENT_ROUTES[key].route === "cloud-board",
    );
    expect(Object.keys(verbs).toSorted()).toEqual(routed.toSorted());
  });
});
