/**
 * The dispatch: one entry per verb, keyed by the Verb Registry's own handler
 * binding (VC-167).
 *
 * This replaced a 1,400-line `if (request.cmd === …)` chain. The chain worked,
 * but the compiler could not hold it: it NARROWED `request.cmd` rather than
 * exhausting it, so deleting a branch still compiled and quietly turned a
 * declared verb into a runtime `UNSUPPORTED_COMMAND`. VC-161 pinned that gap
 * with a test that read the dispatch as source text, and named this table as
 * what would replace the scan. This is that table.
 *
 * What the compiler now holds, in both directions:
 *
 * - **A missing binding is a compile error.** {@link AGENT_VERB_TABLE} is a
 *   total mapping over `AgentCommandBindingId` — every id the registry
 *   projects onto the socket — so a declared verb with no handler does not
 *   build.
 * - **An extra binding is a compile error.** A key that is not a projected
 *   binding id is an excess property on that mapped type. A handler for
 *   `app.launch` or `help` cannot be added here, which is the registry's rule
 *   that one verb has one binding: `packages/cli` answers both locally, and a
 *   second implementation is what the declaration exists to make impossible.
 *
 * An entry does not hold its verb's handler (VC-923). The handler is
 * the host handler map's entry for the verb's key (`./verbs.ts` for the
 * socket's own verbs), and the entry here is the door's projection of it:
 * what the dispatch resolves first, and how the request maps onto the
 * handler's input. One table of handlers, then, behind every door.
 *
 * `agent-commands.ts` holds the loop that reads this, and nothing else about
 * a verb.
 */

import type { AgentCommandBindingId, SocketHandlerKey } from "@volli/shared";

import type { SocketVerbHandle } from "./context";
import { sessionStartDecode, sessionStartFailure } from "./operator-session-start";
import {
  sessionAnswerVerb,
  sessionListVerb,
  sessionPeekVerb,
  sessionShowVerb,
} from "./session-verbs";
import {
  ticketCommentDecode,
  ticketCreateDecode,
  ticketMoveDecode,
  ticketUpdateDecode,
} from "./ticket-verbs";
import {
  projectHandler,
  servedVerb,
  type ProjectedVerbBinding,
  type SocketBoardProjections,
} from "./projection";

/**
 * Whether the dispatch resolves `VOLLI_SESSION` to an identity before calling
 * the handler.
 *
 * `skip` again means the handler does it itself, on terms only it knows:
 * `hook`, `session.link` and `session.harness` need the TERMINAL record rather
 * than the identity, so resolving both would make the hook path pay for two
 * lookups where one answers.
 *
 * There used to be a second policy here — whether the dispatch folded every
 * project's Sessions before calling the handler — declared per verb beside
 * this one. VC-403 retired it: `AgentVerbContext.loadProjections` /
 * `loadSessions` fold the roster lazily and memoized, so a verb that never
 * calls either one simply never pays for the fold, with no policy needed to
 * say so up front. `VOLLI_SESSION` identity stays a real per-verb choice —
 * some verbs want the identity, three want their own terminal record instead
 * — so it keeps its declared field.
 *
 * The comments below still say which verbs read the roster and why, because
 * that is the design fact a reader needs; what they no longer do is DECLARE
 * it, so a comment that drifts costs nothing. The enforcement moved to
 * `agent-dispatch.test.ts`, which drives every verb through the real dispatch
 * and asserts the folding set exactly.
 */
type EnvSessionPolicy = "resolve" | "skip";

/**
 * One verb's binding: the projection (or, for a delegated read, the handler)
 * that answers it, and what the dispatch resolves on its behalf first.
 *
 * The policy sits HERE, beside the handler, rather than in a condition inside
 * the dispatch. In the chain it was two `request.cmd` tests listing six verbs
 * and four verbs respectively, several lines above the branches they governed
 * — so a verb's laziness was a fact about the top of a function rather than a
 * fact about the verb. Reading an entry now tells you what that verb costs
 * before it runs.
 */
export interface AgentVerbBinding {
  readonly handle: SocketVerbHandle;
  readonly envSession: EnvSessionPolicy;
}

/**
 * Every socket binding, in the order the Verb Registry declares them.
 *
 * Every verb is a {@link ProjectedVerbBinding}, bar the four Session reads
 * the map delegates the other way (`SOCKET_DELEGATED_HANDLER_KEYS`): the
 * map's entry for each of those runs this socket's own handler, so a
 * projection of it would call itself. The table's type holds the rest:
 *
 * - A verb whose key the map holds ({@link SocketHandlerKey}: a both-door
 *   catalog command's, VC-668, and each of the socket's own verbs', VC-923)
 *   must be `projectHandler`'s or `servedVerb`'s projection of
 *   `handlers[key]`.
 * - A ticket write whose command is a board handler must project the board's
 *   key ({@link SocketBoardProjections}, VC-794).
 *
 * So a second implementation of any verb beside the map's does not compile.
 * What each entry keeps is the door's own: how the request maps onto the
 * handler's input, and what the dispatch resolves before it.
 */
export const AGENT_VERB_TABLE: {
  readonly [Id in AgentCommandBindingId]: Id extends SocketHandlerKey
    ? ProjectedVerbBinding<Id>
    : Id extends keyof SocketBoardProjections
      ? ProjectedVerbBinding<SocketBoardProjections[Id]>
      : AgentVerbBinding;
} = {
  identify: servedVerb("identify", "resolve"),
  board: servedVerb("board", "resolve"),
  "ticket.list": servedVerb("ticket.list", "resolve"),
  "ticket.show": servedVerb("ticket.show", "resolve"),
  "ticket.events": servedVerb("ticket.events", "resolve"),
  "ticket.create": projectHandler("board.createTicket", {
    decode: ticketCreateDecode,
    envSession: "resolve",
  }),
  "ticket.update": projectHandler("board.updateTicket", {
    decode: ticketUpdateDecode,
    envSession: "resolve",
  }),
  "ticket.move": projectHandler("ticket.move", { decode: ticketMoveDecode, envSession: "resolve" }),
  "ticket.comment": projectHandler("board.createComment", {
    decode: ticketCommentDecode,
    envSession: "resolve",
  }),
  // Identity is the whole requirement, exactly as it is for the two session
  // signals below: a verdict needs a signer, not a terminal attachment, so the
  // roster buys this verb nothing.
  "ticket.signal": servedVerb("ticket.signal", "resolve"),
  // No `ticket.archive` (VC-163). Not an omission to be filled in: this table
  // is a TOTAL mapping over the binding ids the registry projects onto the
  // socket, so a handler for it would be an excess property and would not
  // compile. Its application act remains available through the app.
  "ticket.brief": servedVerb("ticket.brief", "resolve"),
  "worktree.status": servedVerb("worktree.status", "resolve"),
  "worktree.diff": servedVerb("worktree.diff", "resolve"),
  // The one worktree verb that writes (VC-185). Like its two read siblings, the
  // context ladder that answers WHICH worktree runs off Tickets rather than off
  // any Session, so none of the three reads the roster.
  "worktree.sync": servedVerb("worktree.sync", "resolve"),
  // The radar reads Tickets and worktree diffs, and no Session anywhere — which
  // is what keeps the one verb whose design claim is that it is cheap enough to
  // run in a bash pipeline actually cheap.
  conflicts: servedVerb("conflicts", "resolve"),
  "project.list": servedVerb("project.list", "resolve"),
  // The person's bootstrap write (VC-623). Reads no Session; `resolve` only so
  // the dispatch computes the actor it attributes, like every other write.
  "project.add": servedVerb("project.add", "resolve"),
  "label.list": servedVerb("label.list", "resolve"),
  // Reads Tickets and labels and writes both; no Session is in the answer.
  // `envSession` still resolves, because the merge is attributed history.
  "label.merge": servedVerb("label.merge", "resolve"),
  // Reads the Model Access snapshot and nothing else.
  "model.list": servedVerb("model.list", "resolve"),
  // Reads the roster only for `--session <handle>`, which resolves a short id
  // against it. Everything else the answer needs is one indexed read of the
  // usage projection — no Session history is folded to price a pass.
  cost: servedVerb("cost", "resolve"),
  // The person's start, on a hostd operator token only (`operatorCli`); an
  // agent starts a Session through the named `session_start` tool. Both reach
  // the map's one start command (VC-923).
  "session.start": projectHandler("session.start", {
    decode: sessionStartDecode,
    failed: sessionStartFailure,
    envSession: "skip",
  }),
  // The four Session reads the map delegates the other way (VC-663, D4): the
  // WebSocket's `session.list` (and its siblings) runs THIS handler, Workspace-
  // scoped, so the socket keeps it.
  "session.list": { handle: sessionListVerb, envSession: "resolve" },
  "session.show": { handle: sessionShowVerb, envSession: "resolve" },
  // The one verb that reads BOTH halves of the roster (VC-79), off one fold
  // rather than by listing the world twice.
  "session.peek": { handle: sessionPeekVerb, envSession: "resolve" },
  // The whole of a chat's last message (VC-9): resolves the handle against the
  // same fold a peek does, then reads one artifact.
  "session.answer": { handle: sessionAnswerVerb, envSession: "resolve" },
  // Identity is the whole requirement (VC-51): the signal needs no terminal
  // attachment, so it needs no roster to find one in.
  "session.done": servedVerb("session.done", "resolve"),
  "session.blocked": servedVerb("session.blocked", "resolve"),
  // The three that resolve their own terminal record — see EnvSessionPolicy.
  "session.link": servedVerb("session.link", "skip"),
  "session.harness": servedVerb("session.harness", "skip"),
  notify: servedVerb("notify", "resolve"),
  // The hot path: `hook` addresses one durable Session directly and resolves
  // its own terminal record, so it needs neither the identity lookup nor a
  // fleet fold it never asks for.
  hook: servedVerb("hook", "skip"),
  doctor: servedVerb("doctor", "resolve"),
  "prompt.baseline": servedVerb("prompt.baseline", "resolve"),
};
