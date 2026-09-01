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
 * ## Which project's policy governs — both of them
 *
 * An authority policy is a statement a project makes about its own board, so
 * the project a write LANDS IN has to allow it. But a project that narrows its
 * own Sessions is making a statement too, and that one is about the project the
 * caller is acting FROM. These are different projects whenever a caller touches
 * another project's Ticket, and reading only one of them was wrong in both
 * directions: judging by the caller's project alone let a Session (or a granted
 * unauthenticated caller) write straight past a policy the target had narrowed,
 * and judging by the target's alone would silently drop the narrowing a project
 * had applied to its own Sessions.
 *
 * So both are consulted and BOTH must allow. That is the fail-closed reading,
 * it is the union of the two intents rather than a choice between them, and it
 * costs a default install nothing: the built-in policy grants a Session every
 * coordination verb, so two allows is two allows.
 *
 * ## Why the project resolution here is deliberately cheap
 *
 * A per-project policy needs a project, and this runs before the verb resolves
 * its own. Both rungs are therefore cheap by construction:
 *
 * - The CALLER's project comes from an explicit `--project`, the authenticated
 *   Session's own project, or a cwd inside a project root — and NEVER the
 *   expensive rung (indexing every Ticket's worktree path to match a cwd).
 * - The TARGET's project comes from the display id's own prefix, which names a
 *   project directly. No Ticket is loaded and no table is scanned; the verb's
 *   own resolution does that afterwards, with the full ladder.
 *
 * When neither resolves, the built-in defaults apply. For the property this
 * ticket is about that is the fail-CLOSED direction and not a gap: the built-in
 * policy grants an unauthenticated caller nothing, and a project can only ever
 * WIDEN that, so an unresolvable project refuses the write.
 *
 * Say the remaining limit plainly, because it is the one that surprises. A
 * project that NARROWS its own Sessions is not enforced when the CALLER's
 * project cannot be resolved cheaply, which today means a `hook` or
 * `session.harness` fired from a worktree directory (those verbs skip identity
 * resolution by design, so there is no Session to read a project off, and they
 * name no Ticket to read one off either). That case falls back to the defaults
 * and allows the verb. It is accepted rather than overlooked: narrowing your
 * own authenticated Sessions is an operational preference, not a boundary
 * against an attacker, and closing it would cost the hottest involuntary path
 * in the app a Session lookup per event. The boundary — what an UNAUTHENTICATED
 * caller may do, and what any caller may do to a project that did not invite it
 * — holds in every case, because the target rung resolves from the request
 * itself and the unauthenticated default is nothing.
 *
 * This resolution never decides what the verb ACTS on; the verb's own
 * resolution does that. It decides only whether the caller is admitted at all.
 */

import {
  coordinationVerbAllowed,
  DEFAULT_AUTHORITY_POLICY,
  pathContains,
  verbEntry,
} from "@volli/shared";
import type {
  AgentRequest,
  AgentResponse,
  AuthorityActorKind,
  AuthorityPolicy,
  Project,
  VerbEntry,
} from "@volli/shared";

import { failure } from "./context";
import type { EnvSessionIdentity } from "./context";
import type { DoorActor } from "./resolution";

/**
 * Reads one project's resolved authority policy.
 *
 * A port rather than a database handle, so this module holds no store: the
 * policy lives in SQLite under Electron's `userData` today, and the same
 * judgement has to run in whatever host serves the External Agent Surface
 * later. `agent-commands.ts` supplies the default binding.
 */
export type ReadAuthorityPolicy = (projectId: string) => AuthorityPolicy;

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

/** The project the caller is acting FROM — the cheap rungs only. */
function callerProjectId(
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
 * The project the write LANDS IN, from the Ticket display id the request names.
 *
 * Reads {@link VerbEntry.positionalSubject} rather than assuming `args.id` is a
 * Ticket: `session.link` and `session.harness` both take an `id` that is not
 * one, and a native harness session id spelled `something-123` would otherwise
 * be parsed as a display id and resolve a project by accident.
 *
 * A prefix no project claims, or one that several claim, resolves nothing. The
 * ambiguous case needs no special handling here because the verb itself refuses
 * it as AMBIGUOUS_TICKET, so no write lands either way.
 */
function targetProjectId(
  entry: VerbEntry,
  projects: readonly Project[],
  request: AgentRequest,
): string | null {
  if (entry.positionalSubject !== "ticket") return null;
  const displayId = request.args["id"];
  if (typeof displayId !== "string") return null;
  const prefix = /^(.+)-\d+$/.exec(displayId)?.[1];
  if (prefix === undefined) return null;
  const matches = projects.filter((project) => project.ticketPrefix === prefix);
  return matches.length === 1 ? matches[0]!.id : null;
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
  readPolicy: ReadAuthorityPolicy,
  projects: readonly Project[],
  envSession: EnvSessionIdentity | null,
  request: AgentRequest,
  actor: DoorActor,
): AgentResponse | null {
  // Read tier: any caller, no policy consulted. A verb with no registry entry
  // cannot reach here — the socket refuses an unknown command before dispatch.
  const entry = verbEntry(request.cmd);
  if (entry?.actor !== "session") return null;

  const kind = actorKind(actor);
  // Deduplicated, so the ordinary same-project write reads exactly one policy.
  const governing = new Set(
    [
      callerProjectId(projects, envSession, request),
      targetProjectId(entry, projects, request),
    ].filter((projectId): projectId is string => projectId !== null),
  );
  // No project resolved at all means the built-in defaults, which grant an
  // unauthenticated caller nothing — fail-closed, as the header says.
  const policies: readonly AuthorityPolicy[] =
    governing.size === 0 ? [DEFAULT_AUTHORITY_POLICY] : [...governing].map(readPolicy);
  if (policies.every((policy) => coordinationVerbAllowed(policy, kind, request.cmd))) return null;

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
    "This is per-project policy, held outside the agent-writable tree. A person can change it in Settings; a Session cannot grant it to itself. A write into another project is judged by that project's policy too.",
  );
}
