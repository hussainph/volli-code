import { describe, expect, it } from "vite-plus/test";

import { AUTHORITY_ACTOR_KINDS } from "./authority-config";
import { actorRequirementAdmits, DOOR_ACTOR_POLICY, HOST_ACTOR_POLICY } from "./catalog-actor";

describe("the one actor mapping (VC-564)", () => {
  it("maps a paired device to the person, a Session to itself, and refuses a worker (D10)", () => {
    expect(HOST_ACTOR_POLICY).toEqual({ device: "user", session: "session", worker: null });
  });

  it("maps the VC-623 operator to the person, exactly as a paired device", () => {
    expect(DOOR_ACTOR_POLICY).toEqual({
      session: "session",
      operator: "user",
      unauthenticated: "unauthenticated",
    });
    expect(DOOR_ACTOR_POLICY.operator).toBe(HOST_ACTOR_POLICY.device);
  });

  it("judges a requirement by the actor alone, and only the two that can be", () => {
    const matrix = Object.fromEntries(
      (["any", "user", "session", "role"] as const).map((requirement) => [
        requirement,
        AUTHORITY_ACTOR_KINDS.filter((actor) => actorRequirementAdmits(requirement, actor)),
      ]),
    );
    expect(matrix).toEqual({
      any: ["user", "session", "unauthenticated"],
      user: ["user"],
      // Policy and Role bundles answer these; a door with neither refuses.
      session: [],
      role: [],
    });
  });
});
