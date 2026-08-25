/**
 * Who may run a verb over the agent socket, decided once, before it runs
 * (VC-163).
 *
 * `requestActor` answers who the caller IS. This answers what that caller may
 * do — the second half of VC-92 §6, and the half that makes the first one
 * matter. Both run in the dispatch loop rather than inside each verb, for the
 * reason the decomposition gives everywhere else: a rule that lives in one
 * place cannot be forgotten by the next verb someone adds.
 *
 * The gate is REGISTRY-DRIVEN and therefore total. A verb's `actor` field says
 * what it needs — `any` for a read, `session` for a coordination write — so a
 * verb added tomorrow is judged by declaring its requirement, never by being
 * named in a list here. That is the same discipline `verbTier` holds: the
 * governance class is derived from the declaration, not stored beside it.
 *
 * ## Why the project resolution here is deliberately cheap
 *
 * A per-project policy needs a project, and this runs before the verb resolves
 * its own. So it takes the cheap rungs of the context ladder — an explicit
 * `--project`, the authenticated Session's own project, or a cwd inside a
 * project root — and NEVER the expensive one (indexing every ticket's worktree
 * path to match a cwd).
 *
 * When no project resolves, the built-in defaults apply. For the property this
 * ticket is about, that is the fail-CLOSED direction and not a gap: the
 * built-in policy grants an unauthenticated caller nothing, and a project can
 * only ever WIDEN that, so an unresolvable project refuses the write.
 *
 * Say the other direction plainly, because it is the one that surprises. A
 * project that NARROWS its own Sessions — withdrawing a verb the defaults grant
 * — is not enforced when the project cannot be resolved cheaply, which today
 * means a `hook` or `session.harness` fired from a worktree directory (those
 * verbs skip identity resolution by design, so there is no Session to read a
 * project off). That case falls back to the defaults and allows the verb. It is
 * accepted rather than overlooked: narrowing your own authenticated Sessions is
 * an operational preference, not a boundary against an attacker, and closing it
 * would cost the hottest involuntary path in the app a Session lookup and a
 * policy read per event. The boundary — what an UNAUTHENTICATED caller may do —
 * holds in every case, because its default is nothing.
 *
 * This resolution never decides what the verb ACTS on; the verb's own
 * resolution does that, with the full ladder. It decides only whether the
 * caller is admitted at all.
 */

import type Database from "better-sqlite3";
import { coordinationVerbAllowed, DEFAULT_AUTHORITY_POLICY, verbEntry } from "@volli/shared";
import type { AgentRequest, AgentResponse, AuthorityActorKind, Project } from "@volli/shared";

import { getProjectAuthorityPolicy } from "../db/projects-repo";
import { failure } from "./context";
import type { EnvSessionIdentity } from "./context";
import type { DoorActor } from "./resolution";

/**
 * The door's actor vocabulary, from the door's own actor.
 *
 * Two vocabularies on purpose, and VC-44 said why: `TicketEventActor` is who a
 * ticket event is attributed to, written after the fact;
 * {@link AuthorityActorKind} is who a caller is at the door, asked before
 * anything happens. They overlap without being the same list — and `user`,
 * which exists in both, can no longer arrive over this door at all.
 */
function actorKind(actor: DoorActor): AuthorityActorKind {
  return actor.kind === "session" ? "session" : "unauthenticated";
}

function pathContains(root: string, candidate: string): boolean {
  const normalized = root.endsWith("/") ? root.slice(0, -1) : root;
  return candidate === normalized || candidate.startsWith(`${normalized}/`);
}

/** The cheap rungs only — see this module's header for why. */
function policyProjectId(
  projects: readonly Project[],
  envSession: EnvSessionIdentity | null,
  request: AgentRequest,
): string | null {
  const selector = request.args["project"];
  if (typeof selector === "string") {
    const named = projects.find(
      ({ name, path, ticketPrefix }) =>
        name === selector || path === selector || ticketPrefix === selector,
    );
    if (named) return named.id;
  }
  if (envSession) return envSession.projectId;
  const byCwd = projects.filter((project) => pathContains(project.path, request.ctx.cwd));
  return byCwd.length === 1 ? byCwd[0]!.id : null;
}

/**
 * Why this caller may not run this verb, or `null` when it may.
 *
 * The refusal names the actor kind and the verb, because the caller's next move
 * differs completely by kind: an unauthenticated caller has to run inside a
 * Volli Session, and a Session refused by a narrowed project policy has to have
 * the policy changed by a person. Telling them apart is the difference between
 * a teaching error and a wall.
 */
export function coordinationRefusal(
  db: Database.Database,
  projects: readonly Project[],
  envSession: EnvSessionIdentity | null,
  request: AgentRequest,
  actor: DoorActor,
): AgentResponse | null {
  // Read tier: any caller, no policy consulted. A verb with no registry entry
  // cannot reach here — the socket refuses an unknown command before dispatch.
  if (verbEntry(request.cmd)?.actor !== "session") return null;

  const projectId = policyProjectId(projects, envSession, request);
  // No project resolved means the built-in defaults, which grant an
  // unauthenticated caller nothing — fail-closed, as the header says.
  const policy =
    projectId === null ? DEFAULT_AUTHORITY_POLICY : getProjectAuthorityPolicy(db, projectId);
  const kind = actorKind(actor);
  if (coordinationVerbAllowed(policy, kind, request.cmd)) return null;

  if (kind === "unauthenticated") {
    return failure(
      "FORBIDDEN_ACTOR",
      `${request.cmd} is a coordination-tier verb and this caller is not an authenticated Volli Session, so it may read but not write.`,
      "Run this from inside a Volli Session, whose environment carries the token that authenticates it. A process that merely runs as your user is not a Session.",
    );
  }
  return failure(
    "FORBIDDEN_ACTOR",
    `${request.cmd} is not among the coordination-tier verbs this project allows a ${kind} caller to run.`,
    "This is per-project policy, held outside the agent-writable tree. A person can change it in Settings; a Session cannot grant it to itself.",
  );
}
