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
import { hookVerb, sessionHarnessVerb, sessionLinkVerb } from "./harness-verbs";
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
  sessionPeekVerb,
  sessionStartVerb,
} from "./session-verbs";
import {
  ticketArchiveVerb,
  ticketCommentVerb,
  ticketCreateVerb,
  ticketMoveVerb,
  ticketUpdateVerb,
} from "./ticket-verbs";
import { worktreeDiffVerb, worktreeStatusVerb } from "./worktree-verbs";

/**
 * Whether the dispatch folds every project's Sessions before calling the
 * handler.
 *
 * `skip` is not an optimization someone may revisit casually. A `hook` arrives
 * on a process-per-event hot path and addresses one durable Session directly,
 * so taking a complete multi-project snapshot merely to find it is work the
 * hottest involuntary path in the app pays for nothing. The three verbs that
 * want terminal FACTS on top of identity resolve their own record, and the
 * ones that never look at a Session at all have nothing to resolve.
 */
type ProjectionPolicy = "load" | "skip";

/**
 * Whether the dispatch resolves `VOLLI_SESSION` to an identity before calling
 * the handler.
 *
 * `skip` again means the handler does it itself, on terms only it knows:
 * `hook`, `session.link` and `session.harness` need the TERMINAL record rather
 * than the identity, so resolving both would make the hook path pay for two
 * lookups where one answers.
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
  readonly projections: ProjectionPolicy;
  readonly envSession: EnvSessionPolicy;
}

/** Every socket binding, in the order the Verb Registry declares them. */
export const AGENT_VERB_TABLE: {
  readonly [Id in AgentCommandBindingId]: AgentVerbBinding;
} = {
  identify: { handle: identifyVerb, projections: "load", envSession: "resolve" },
  board: { handle: boardVerb, projections: "load", envSession: "resolve" },
  "ticket.list": { handle: ticketListVerb, projections: "load", envSession: "resolve" },
  "ticket.show": { handle: ticketShowVerb, projections: "load", envSession: "resolve" },
  "ticket.events": { handle: ticketEventsVerb, projections: "load", envSession: "resolve" },
  "ticket.create": { handle: ticketCreateVerb, projections: "load", envSession: "resolve" },
  "ticket.update": { handle: ticketUpdateVerb, projections: "load", envSession: "resolve" },
  "ticket.move": { handle: ticketMoveVerb, projections: "load", envSession: "resolve" },
  "ticket.comment": { handle: ticketCommentVerb, projections: "load", envSession: "resolve" },
  "ticket.archive": { handle: ticketArchiveVerb, projections: "load", envSession: "resolve" },
  "ticket.brief": { handle: ticketBriefVerb, projections: "load", envSession: "resolve" },
  "worktree.status": { handle: worktreeStatusVerb, projections: "load", envSession: "resolve" },
  "worktree.diff": { handle: worktreeDiffVerb, projections: "load", envSession: "resolve" },
  "project.list": { handle: projectListVerb, projections: "load", envSession: "resolve" },
  "label.list": { handle: labelListVerb, projections: "load", envSession: "resolve" },
  // Reads the Model Access snapshot and nothing else — no Session anywhere in
  // the answer, so folding every project's is pure cost.
  "model.list": { handle: modelListVerb, projections: "skip", envSession: "resolve" },
  "session.list": { handle: sessionListVerb, projections: "load", envSession: "resolve" },
  // The one verb that reads BOTH halves of the snapshot (VC-79), from this one
  // fold rather than by listing the world twice.
  "session.peek": { handle: sessionPeekVerb, projections: "load", envSession: "resolve" },
  "session.start": { handle: sessionStartVerb, projections: "load", envSession: "resolve" },
  // Identity is the whole requirement (VC-51): the signal needs no terminal
  // attachment, so it needs no terminal snapshot to find one in.
  "session.done": { handle: sessionDoneVerb, projections: "skip", envSession: "resolve" },
  "session.blocked": { handle: sessionBlockedVerb, projections: "skip", envSession: "resolve" },
  // The three that resolve their own terminal record — see EnvSessionPolicy.
  "session.link": { handle: sessionLinkVerb, projections: "skip", envSession: "skip" },
  "session.harness": { handle: sessionHarnessVerb, projections: "skip", envSession: "skip" },
  notify: { handle: notifyVerb, projections: "load", envSession: "resolve" },
  // The hot path. Both skips are load-bearing here.
  hook: { handle: hookVerb, projections: "skip", envSession: "skip" },
  doctor: { handle: doctorVerb, projections: "load", envSession: "resolve" },
  "prompt.baseline": { handle: promptBaselineVerb, projections: "load", envSession: "resolve" },
};
