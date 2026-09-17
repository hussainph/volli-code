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
 * `loadSessions` fold the fleet lazily and memoized, so a verb that never
 * calls either one simply never pays for the fold, with no policy needed to
 * say so up front. `VOLLI_SESSION` identity stays a real per-verb choice —
 * some verbs want the identity, three want their own terminal record instead
 * — so it keeps its declared field.
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
  "ticket.signal": { handle: ticketSignalVerb, envSession: "resolve" },
  // No `ticket.archive` and no `session.start` (VC-163). Neither is an omission
  // to be filled in: this table is a TOTAL mapping over the binding ids the
  // registry projects onto the socket, so a handler for either would be an
  // excess property and would not compile. Their application acts remain
  // available through the app and Agent Tool Surface respectively.
  "ticket.brief": { handle: ticketBriefVerb, envSession: "resolve" },
  "worktree.status": { handle: worktreeStatusVerb, envSession: "resolve" },
  "worktree.diff": { handle: worktreeDiffVerb, envSession: "resolve" },
  "worktree.sync": { handle: worktreeSyncVerb, envSession: "resolve" },
  conflicts: { handle: conflictsVerb, envSession: "resolve" },
  "project.list": { handle: projectListVerb, envSession: "resolve" },
  "label.list": { handle: labelListVerb, envSession: "resolve" },
  "label.merge": { handle: labelMergeVerb, envSession: "resolve" },
  "model.list": { handle: modelListVerb, envSession: "resolve" },
  cost: { handle: costVerb, envSession: "resolve" },
  "session.list": { handle: sessionListVerb, envSession: "resolve" },
  "session.peek": { handle: sessionPeekVerb, envSession: "resolve" },
  "session.answer": { handle: sessionAnswerVerb, envSession: "resolve" },
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
