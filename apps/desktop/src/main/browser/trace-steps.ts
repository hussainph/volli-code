/**
 * How a Browser port call becomes a Browser Trace step (VC-453): wrappers the
 * port puts around its two changing calls, `navigate` and `act`, so the host
 * hears how each one settled — answered, refused or failed — in the order the
 * calls settle, which is the order a replay shows.
 *
 * Kept beside the port rather than inside it: the port's job is scope, holds
 * and the CDP wire, and a trace is a record the HOST keeps about that work.
 * The port only reports; {@link BrowserTabHost.recordTraceStep} decides
 * whether the tab is one it records (a Session's, never a person's).
 *
 * What a step says is Volli's record of the call, never the page's: the
 * target is the accessible name the host read (cleaned by the store) or what
 * the call named, the text a `type` or `select` carried is never kept, and a
 * failure is described in Volli's words rather than a thrown message.
 *
 * The wrappers sit INSIDE the port's `scoped` guard, so a call withdrawn
 * before it started — which never happened — is never recorded.
 */
import { BrowserRefusal } from "@volli/agent-runtime";
import type {
  RuntimeBrowserActResult,
  RuntimeBrowserPage,
  RuntimeBrowserPort,
  RuntimeBrowserSnapshot,
} from "@volli/shared";

import type { AgentBrowserHost } from "./agent-port";
import type { BrowserTraceStepInput } from "./trace-store";

type NavigateInput = Parameters<RuntimeBrowserPort["navigate"]>[0];
type ActInput = Parameters<RuntimeBrowserPort["act"]>[0];

/** What a step says about the call itself; the wrapper adds who, and how it ended. */
type StepFacts = Omit<BrowserTraceStepInput, "sessionId" | "outcome" | "rule">;

type Recorder = NonNullable<AgentBrowserHost["recordTraceStep"]>;

const WITHDRAWN = "The call was withdrawn before it finished.";
const FAILED = "The browser could not complete this action.";

/**
 * Runs the call, then reports it. Reporting is after the call and outside
 * its `try`, and a recorder that throws is logged rather than rethrown: a
 * trace is enrichment nobody is waiting on, so it can neither turn a call
 * into a failure nor record one call twice.
 */
async function report<I extends { signal: AbortSignal }, O>(
  recorder: Recorder,
  sessionId: string,
  input: I,
  run: (input: I) => Promise<O>,
  facts: (answer: O | null, page: RuntimeBrowserPage | null) => StepFacts | null,
): Promise<O> {
  const record = (step: BrowserTraceStepInput): void => {
    try {
      recorder(step);
    } catch (error) {
      console.warn("[volli] Browser Trace step was not recorded:", error);
    }
  };
  let answer: O;
  try {
    answer = await run(input);
  } catch (error) {
    const refusal = error instanceof BrowserRefusal ? error : null;
    // A tab this Session was never shown is not its tab to have a trace of.
    const step =
      refusal?.rule === "browser.unknown-tab" ? null : facts(null, refusal?.page ?? null);
    if (step !== null) {
      record({
        ...step,
        sessionId,
        outcome: refusal === null ? "failed" : "refused",
        rule: refusal?.rule ?? null,
        error: refusal === null ? (input.signal.aborted ? WITHDRAWN : FAILED) : null,
      });
    }
    throw error;
  }
  const step = facts(answer, null);
  if (step !== null) record({ ...step, sessionId, outcome: "ok", rule: null });
  return answer;
}

function navigate(
  host: Pick<AgentBrowserHost, "recordTraceStep" | "list">,
  scope: { projectId: string },
  sessionId: string,
  run: RuntimeBrowserPort["navigate"],
): RuntimeBrowserPort["navigate"] {
  const record = host.recordTraceStep?.bind(host);
  if (record === undefined) return run;
  const owned = (): Set<string> =>
    new Set(
      host
        .list({ projectId: scope.projectId })
        .filter((tab) => tab.ownerSessionId === sessionId)
        .map((tab) => tab.tabId),
    );
  return async (input) => {
    // An open that fails AFTER its tab was born still happened in that tab;
    // the only way to name it is the tab this Session owns now and did not
    // before. A refused open with no tab (a policy or a cap) has no page to
    // replay, and the transcript keeps it.
    const before = input.tabId === undefined ? owned() : null;
    const born = (): string | undefined =>
      before === null ? undefined : [...owned()].find((tabId) => !before.has(tabId));
    return await report(record, sessionId, input, run, (answer, page) =>
      navigateStep(input, answer, page, born),
    );
  };
}

function act(
  host: Pick<AgentBrowserHost, "recordTraceStep">,
  sessionId: string,
  run: RuntimeBrowserPort["act"],
): RuntimeBrowserPort["act"] {
  const record = host.recordTraceStep?.bind(host);
  if (record === undefined) return run;
  return async (input) =>
    await report(record, sessionId, input, run, (answer, page) => actStep(input, answer, page));
}

export const traced = { navigate, act };

function navigateStep(
  input: NavigateInput,
  answer: RuntimeBrowserSnapshot | null,
  page: RuntimeBrowserPage | null,
  born: () => string | undefined,
): StepFacts | null {
  const tabId = answer?.tabId ?? page?.tabId ?? input.tabId ?? born();
  if (tabId === undefined) return null;
  const aimed = input.navigation.kind === "url" ? input.navigation.url : null;
  return {
    tabId,
    action: input.navigation.kind === "url" ? "open" : input.navigation.kind,
    target: null,
    url: answer?.url ?? aimed ?? page?.url ?? null,
    title: answer?.title ?? page?.title ?? null,
    generation: answer?.generation ?? null,
    pictureId: answer?.picture ?? null,
    error: answer?.error ?? null,
  };
}

function actStep(
  input: ActInput,
  answer: RuntimeBrowserActResult | null,
  page: RuntimeBrowserPage | null,
): StepFacts {
  // The page's own name for what was touched, else what the call named. The
  // text a `type` or `select` carried is never a target: it may be a secret.
  const named = input.ref ?? input.key ?? input.direction ?? null;
  const target =
    answer === null || answer.target === null ? named : (answer.target.name ?? answer.target.ref);
  return {
    tabId: answer?.tabId ?? page?.tabId ?? input.tabId,
    action: input.kind,
    target,
    url: answer?.url ?? page?.url ?? null,
    title: answer?.title ?? page?.title ?? null,
    generation: answer?.generation ?? input.generation,
    pictureId: answer?.picture ?? null,
    error: answer?.error ?? null,
  };
}
