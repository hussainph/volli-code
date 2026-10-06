/**
 * The catalog's door policies at the handler map (VC-668): the router's rule,
 * transport-independent, and the desktop window's trusted identity.
 */
import {
  DESKTOP_HANDLER_KEYS,
  HOST_HANDLER_KEYS,
  PUBLIC_HANDLER_KEYS,
  type HandlerCall,
} from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import { ADMITTED } from "./handler-map";
import { catalogVerdict, DESKTOP_WINDOW_POLICY, ROUTER_POLICY } from "./policies";

const WINDOW: HandlerCall = { actor: { kind: "user" }, origin: "desktop-window" };
const DEVICE: HandlerCall = { actor: { kind: "user" } };
const SESSION: HandlerCall = { actor: { kind: "session", sessionId: "s-1", ticketId: null } };
const REFUSED = (key: string) => ({
  admitted: false,
  message: `${key} is not open to this caller.`,
  hint: null,
});

describe("catalogVerdict", () => {
  it("admits the desktop's own window to every key the map serves", () => {
    for (const key of HOST_HANDLER_KEYS) {
      expect(catalogVerdict(key, WINDOW), key).toBe(ADMITTED);
    }
  });

  it("admits a paired device to every public key the map serves", () => {
    for (const key of PUBLIC_HANDLER_KEYS) {
      expect(catalogVerdict(key, DEVICE), key).toBe(ADMITTED);
    }
  });

  // Placement-derived policy (VC-608): a desktop-only entry is the person's,
  // on no network door, so a paired device is refused it at the map as well
  // as at the router, whatever its placement.
  it("refuses a paired device every desktop-only key", () => {
    expect(DESKTOP_HANDLER_KEYS.length).toBeGreaterThan(0);
    for (const key of DESKTOP_HANDLER_KEYS) {
      expect(catalogVerdict(key, DEVICE), key).toEqual(REFUSED(key));
      expect(DESKTOP_WINDOW_POLICY.admit(key, {}, WINDOW), key).toBe(ADMITTED);
    }
  });

  it("refuses a Session every key whose router actor is the person, ticket.move included", () => {
    // The socket's coordination policy is separate: a Session moves tickets
    // there (agent-dispatch/admission.ts), and nothing here changes that.
    for (const key of HOST_HANDLER_KEYS) {
      expect(catalogVerdict(key, SESSION), key).toEqual(REFUSED(key));
    }
  });

  it("refuses an actor no catalog entry admits", () => {
    for (const actor of [
      { kind: "automation" },
      { kind: "unauthenticated" },
    ] as HandlerCall["actor"][]) {
      expect(catalogVerdict("ticket.move", { actor })).toEqual(REFUSED("ticket.move"));
    }
  });

  it("refuses a desktop-window origin on anyone but the person", () => {
    expect(catalogVerdict("ticket.move", { ...SESSION, origin: "desktop-window" })).toEqual(
      REFUSED("ticket.move"),
    );
  });

  it("admits a network caller only to what the WebSocket projects", () => {
    // The lab's diagnostics have no host handler and no `hostApi` mode: the
    // rule, shown on the one entry that exercises it.
    const lab = "labDiagnostics.list" as "ticket.move";
    expect(catalogVerdict(lab, WINDOW)).toBe(ADMITTED);
    expect(catalogVerdict(lab, DEVICE)).toEqual(REFUSED(lab));
  });
});

describe("the catalog doors' policies", () => {
  it("judges a router's call by the catalog alone", () => {
    expect(ROUTER_POLICY.door).toBe("router");
    expect(ROUTER_POLICY.admit("ticket.move", {}, DEVICE)).toBe(ADMITTED);
    expect(ROUTER_POLICY.admit("ticket.move", {}, SESSION)).toEqual(REFUSED("ticket.move"));
  });

  it("opens the desktop's legacy channel to its own window alone, synchronously", () => {
    expect(DESKTOP_WINDOW_POLICY.door).toBe("desktop-ipc");
    expect(DESKTOP_WINDOW_POLICY.admit("ticket.move", {}, WINDOW)).toBe(ADMITTED);
    expect(DESKTOP_WINDOW_POLICY.admit("ticket.move", {}, DEVICE)).toEqual({
      admitted: false,
      message: "ticket.move is open on this channel only to the desktop's own window.",
      hint: null,
    });
  });
});
