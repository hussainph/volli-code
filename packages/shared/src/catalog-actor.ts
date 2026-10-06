/**
 * The one mapping between Volli's three actor vocabularies (VC-564).
 *
 * - **HostActor** (`@volli/host-protocol`): who a host-protocol connection's
 *   credential proved, `device | session | worker`. The desktop's own window
 *   is the reserved local device (D7), still a `device`.
 * - **DoorActor** (`@volli/host-core`, the agent socket): who an NDJSON
 *   request's token proved, `session | operator | unauthenticated`.
 * - **VerbActor** (the Verb Registry): what an entry requires of its caller,
 *   `any | session | role | user`.
 *
 * Both door vocabularies land on one policy actor, {@link AuthorityActorKind},
 * and every door judges a {@link VerbActor} requirement against that, never
 * against its own vocabulary. That is the whole rule this module exists to
 * keep in one place: a paired device and a VC-623 operator are both the
 * person (`user`), a Session is a Session on every door, and a worker is
 * refused outright until VC-580/581 give it delegated Session grants (D10).
 *
 * The kind names are restated here rather than imported, because this package
 * depends on neither door. Each door indexes these tables with its own actor's
 * `kind`, so a kind added to either union fails to compile there until this
 * table answers it.
 */
import type { AuthorityActorKind } from "./authority-config";
import type { CatalogActor, VerbActor } from "./verb-registry";

/** `HostActor["kind"]`, which `@volli/session-rpc` pins equal to this. */
export type HostActorKindName = "device" | "session" | "worker";

/** `DoorActor["kind"]`, which host-core's admission gate indexes with. */
export type DoorActorKindName = "session" | "operator" | "unauthenticated";

/**
 * A host-protocol actor's policy actor. `null` is refused before any entry is
 * read: a worker has no policy of its own, only a hosted Session's.
 */
export const HOST_ACTOR_POLICY = {
  device: "user",
  session: "session",
  worker: null,
} as const satisfies Readonly<Record<HostActorKindName, AuthorityActorKind | null>>;

/** An agent-socket actor's policy actor. The operator is the person (VC-623). */
export const DOOR_ACTOR_POLICY = {
  session: "session",
  operator: "user",
  unauthenticated: "unauthenticated",
} as const satisfies Readonly<Record<DoorActorKindName, AuthorityActorKind>>;

/**
 * Whether an entry's requirement admits this policy actor on the actor's kind
 * alone. `any` admits everyone and `user` only the person.
 *
 * `session` and `role` are never answered here. A `session` requirement is
 * per-project policy (the socket reads it from the authority policy), and a
 * `role` requirement is a Session's frozen Role bundle; a door that has neither
 * to consult must refuse, and this answer is that refusal.
 */
export function actorRequirementAdmits(requirement: VerbActor, actor: AuthorityActorKind): boolean {
  switch (requirement) {
    case "any":
      return true;
    case "user":
      return actor === "user";
    case "session":
    case "role":
      return false;
  }
}

/**
 * How a router admits a policy actor to an entry whose router actor is
 * `requirement`: outright, only to resources the Session owns (`if-owner`,
 * answered after the Workspace check by the context's `resourceOwner` port),
 * or not at all.
 */
export type CatalogAdmission = "admitted" | "if-owner" | "refused";

export function catalogActorAdmits(
  requirement: CatalogActor,
  actor: AuthorityActorKind,
): CatalogAdmission {
  if (requirement === "session-own" && actor === "session") return "if-owner";
  const judged = requirement === "session-own" ? "user" : requirement;
  return actorRequirementAdmits(judged, actor) ? "admitted" : "refused";
}
