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
 * `agent-commands.ts` holds the loop that reads this, and nothing else about
 * a verb.
 */

import type { AgentCommandBindingId } from "@volli/shared";

import type { AgentVerbHandler } from "./context";
import { doctorVerb, modelListVerb, notifyVerb, promptBaselineVerb } from "./app-verbs";
import { conflictsVerb } from "./conflicts-verb";
import { costVerb } from "./cost-verb";
import { hookVerb, sessionHarnessVerb, sessionLinkVerb } from "./harness-verbs";
import { labelMergeVerb } from "./label-verbs";
import {
  boardVerb,
  identifyVerb,
  labelListVerb,
  projectListVerb,
  ticketBriefVerb,
  ticketEventsVerb,
  ticketListVerb,
  ticketShowVerb,
} from "./read-verbs";
import {
  sessionBlockedVerb,
  sessionDoneVerb,
  sessionListVerb,
  sessionAnswerVerb,
  sessionPeekVerb,
} from "./session-verbs";
import {
  ticketCommentVerb,
  ticketCreateVerb,
  ticketMoveVerb,
  ticketSignalVerb,
  ticketUpdateVerb,
} from "./ticket-verbs";
import { worktreeDiffVerb, worktreeStatusVerb, worktreeSyncVerb } from "./worktree-verbs";

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
 * this one. VC-403 retired it: `AgentCommandContext.loadProjections` /
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
 * One verb's binding: the handler that answers it, and what the dispatch
 * resolves on its behalf first.
 *
 * The policy sits HERE, beside the handler, rather than in a condition inside
 * the dispatch. In the chain it was two `request.cmd` tests listing six verbs
 * and four verbs respectively, several lines above the branches they governed
 * — so a verb's laziness was a fact about the top of a function rather than a
 * fact about the verb. Reading an entry now tells you what that verb costs
 * before it runs.
 */
export interface AgentVerbBinding {
  readonly handle: AgentVerbHandler;
  readonly envSession: EnvSessionPolicy;
}

/** Every socket binding, in the order the Verb Registry declares them. */
export const AGENT_VERB_TABLE: {
  readonly [Id in AgentCommandBindingId]: AgentVerbBinding;
} = {
  identify: { handle: identifyVerb, envSession: "resolve" },
  board: { handle: boardVerb, envSession: "resolve" },
  "ticket.list": { handle: ticketListVerb, envSession: "resolve" },
  "ticket.show": { handle: ticketShowVerb, envSession: "resolve" },
  "ticket.events": { handle: ticketEventsVerb, envSession: "resolve" },
  "ticket.create": { handle: ticketCreateVerb, envSession: "resolve" },
  "ticket.update": { handle: ticketUpdateVerb, envSession: "resolve" },
  "ticket.move": { handle: ticketMoveVerb, envSession: "resolve" },
  "ticket.comment": { handle: ticketCommentVerb, envSession: "resolve" },
  // Identity is the whole requirement, exactly as it is for the two session
  // signals below: a verdict needs a signer, not a terminal attachment, so the
  // roster buys this verb nothing.
  "ticket.signal": { handle: ticketSignalVerb, envSession: "resolve" },
  // No `ticket.archive` and no `session.start` (VC-163). Neither is an omission
  // to be filled in: this table is a TOTAL mapping over the binding ids the
  // registry projects onto the socket, so a handler for either would be an
  // excess property and would not compile. Their application acts remain
  // available through the app and Agent Tool Surface respectively.
  "ticket.brief": { handle: ticketBriefVerb, envSession: "resolve" },
  "worktree.status": { handle: worktreeStatusVerb, envSession: "resolve" },
  "worktree.diff": { handle: worktreeDiffVerb, envSession: "resolve" },
  // The one worktree verb that writes (VC-185). Like its two read siblings, the
  // context ladder that answers WHICH worktree runs off Tickets rather than off
  // any Session, so none of the three reads the roster.
  "worktree.sync": { handle: worktreeSyncVerb, envSession: "resolve" },
  // The radar reads Tickets and worktree diffs, and no Session anywhere — which
  // is what keeps the one verb whose design claim is that it is cheap enough to
  // run in a bash pipeline actually cheap.
  conflicts: { handle: conflictsVerb, envSession: "resolve" },
  "project.list": { handle: projectListVerb, envSession: "resolve" },
  "label.list": { handle: labelListVerb, envSession: "resolve" },
  // Reads Tickets and labels and writes both; no Session is in the answer.
  // `envSession` still resolves, because the merge is attributed history.
  "label.merge": { handle: labelMergeVerb, envSession: "resolve" },
  // Reads the Model Access snapshot and nothing else.
  "model.list": { handle: modelListVerb, envSession: "resolve" },
  // Reads the roster only for `--session <handle>`, which resolves a short id
  // against it. Everything else the answer needs is one indexed read of the
  // usage projection — no Session history is folded to price a pass.
  cost: { handle: costVerb, envSession: "resolve" },
  "session.list": { handle: sessionListVerb, envSession: "resolve" },
  // The one verb that reads BOTH halves of the roster (VC-79), off one fold
  // rather than by listing the world twice.
  "session.peek": { handle: sessionPeekVerb, envSession: "resolve" },
  // The whole of a chat's last message (VC-9): resolves the handle against the
  // same fold a peek does, then reads one artifact.
  "session.answer": { handle: sessionAnswerVerb, envSession: "resolve" },
  // Identity is the whole requirement (VC-51): the signal needs no terminal
  // attachment, so it needs no roster to find one in.
  "session.done": { handle: sessionDoneVerb, envSession: "resolve" },
  "session.blocked": { handle: sessionBlockedVerb, envSession: "resolve" },
  // The three that resolve their own terminal record — see EnvSessionPolicy.
  "session.link": { handle: sessionLinkVerb, envSession: "skip" },
  "session.harness": { handle: sessionHarnessVerb, envSession: "skip" },
  notify: { handle: notifyVerb, envSession: "resolve" },
  // The hot path: `hook` addresses one durable Session directly and resolves
  // its own terminal record, so it needs neither the identity lookup nor a
  // fleet fold it never asks for.
  hook: { handle: hookVerb, envSession: "skip" },
  doctor: { handle: doctorVerb, envSession: "resolve" },
  "prompt.baseline": { handle: promptBaselineVerb, envSession: "resolve" },
};
