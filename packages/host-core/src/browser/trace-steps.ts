/**
 * How a Browser port call becomes a Browser Trace step (VC-453): wrappers the
 * port puts around every call it makes against one tab — `navigate` and `act`,
 * which change the page, and the reads `snapshot`, `find`, `screenshot` and
 * `console` — so the host hears how each one settled — answered, refused or
 * failed — in the order the calls settle, which is the order a replay shows.
 * A read carries a frame only when the call took one (a screenshot); the
 * replay shows the tab's last frame beside the others.
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
  BrowserTraceAction,
  RuntimeBrowserActResult,
  RuntimeBrowserPage,
  RuntimeBrowserPort,
  RuntimeBrowserSnapshot,
} from "@volli/shared";

import type { AgentBrowserBackend, AgentBrowserPort } from "./agent-port";
import type { BrowserTraceStepInput } from "./trace-store";
import { hostLogger } from "../log/root";

const log = hostLogger("browser");

type NavigateInput = Parameters<RuntimeBrowserPort["navigate"]>[0];
type ActInput = Parameters<RuntimeBrowserPort["act"]>[0];

/** What a step says about the call itself; the wrapper adds who, and how it ended. */
type StepFacts = Omit<BrowserTraceStepInput, "sessionId" | "outcome" | "rule">;

type Recorder = NonNullable<AgentBrowserBackend["recordTraceStep"]>;

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
      log.warn("browser trace step was not recorded", { error });
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
  host: Pick<AgentBrowserBackend, "recordTraceStep" | "list">,
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
  host: Pick<AgentBrowserBackend, "recordTraceStep">,
  sessionId: string,
  run: RuntimeBrowserPort["act"],
): RuntimeBrowserPort["act"] {
  const record = host.recordTraceStep?.bind(host);
  if (record === undefined) return run;
  return async (input) =>
    await report(record, sessionId, input, run, (answer, page) => actStep(input, answer, page));
}

/**
 * A read against one tab: it changes nothing, so its step is the page as the
 * host answered it, what the call looked for (a find's query — the model's
 * own words, bounded by the store), and the picture only if the call took one.
 */
function read<I extends { tabId: string; signal: AbortSignal }, O extends RuntimeBrowserPage>(
  host: Pick<AgentBrowserBackend, "recordTraceStep">,
  sessionId: string,
  action: Extract<BrowserTraceAction, "read" | "find" | "screenshot" | "console">,
  run: (input: I) => Promise<O>,
  said: (
    input: I,
    answer: O | null,
  ) => { target: string | null; pictureId: string | null; generation: number | null } = () => ({
    target: null,
    pictureId: null,
    generation: null,
  }),
): (input: I) => Promise<O> {
  const record = host.recordTraceStep?.bind(host);
  if (record === undefined) return run;
  return async (input) =>
    await report(record, sessionId, input, run, (answer, page) => ({
      tabId: answer?.tabId ?? page?.tabId ?? input.tabId,
      action,
      url: answer?.url ?? page?.url ?? null,
      title: answer?.title ?? page?.title ?? null,
      error: answer?.error ?? null,
      ...said(input, answer),
    }));
}

type Host = Pick<AgentBrowserBackend, "recordTraceStep">;
const NOTHING_SAID = { target: null, pictureId: null, generation: null };

export const traced = {
  navigate,
  act,
  snapshot: (host: Host, sessionId: string, run: RuntimeBrowserPort["snapshot"]) =>
    read(host, sessionId, "read", run, (_input, snap) => ({
      ...NOTHING_SAID,
      generation: snap?.generation ?? null,
    })),
  find: (host: Host, sessionId: string, run: AgentBrowserPort["find"]) =>
    read(host, sessionId, "find", run, (input, found) => ({
      ...NOTHING_SAID,
      target: input.query,
      generation: found?.generation ?? null,
    })),
  screenshot: (host: Host, sessionId: string, run: RuntimeBrowserPort["screenshot"]) =>
    read(host, sessionId, "screenshot", run, (_input, shot) => ({
      ...NOTHING_SAID,
      pictureId: shot?.picture ?? null,
    })),
  console: (host: Host, sessionId: string, run: RuntimeBrowserPort["console"]) =>
    read(host, sessionId, "console", run),
};

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
