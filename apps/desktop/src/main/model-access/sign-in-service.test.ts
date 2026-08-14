import type { PiSignIn, PiSignInSteps } from "@volli/agent-runtime";
import type {
  ModelAccessSignInPrompt,
  ModelAccessSignInType,
  ModelAccessSignInUpdate,
} from "@volli/shared";
import { describe, expect, it, vi } from "vite-plus/test";

import { ModelAccessSignInService, redactSubmitted, type SignInOwner } from "./sign-in-service";

// --- a scripted flow -------------------------------------------------------
//
// The port, not pi-ai: `login` parks until the test says how it ended, and hands
// the test the same `steps` bag a provider's flow would drive. Everything the
// service does — parking, withdrawing, cancelling, redacting — is reachable
// from here with no Electron, no network and no credential file in the room.

interface Flow {
  providerId: string;
  type: ModelAccessSignInType;
  signal: AbortSignal;
  steps: PiSignInSteps;
  /** Ends the login the way a stored credential does. */
  succeed: () => void;
  /** Ends the login the way a provider rejection or an abort does. */
  fail: (error: unknown) => void;
}

interface ScriptedPort {
  pi: PiSignIn;
  flows: Flow[];
  /** The nth login the service actually started, or a failure naming which one is missing. */
  flow: (index?: number) => Flow;
  logout: ReturnType<typeof vi.fn>;
  offers: ReturnType<typeof vi.fn>;
}

function scriptedPort(options: { offers?: boolean } = {}): ScriptedPort {
  const flows: Flow[] = [];
  const offers = vi.fn(
    (_providerId: string, _type: ModelAccessSignInType) => options.offers ?? true,
  );
  const logout = vi.fn(async (_providerId: string) => undefined);
  const pi: PiSignIn = {
    offers,
    login: (providerId, type, signal, steps) => {
      const settle = Promise.withResolvers<void>();
      flows.push({
        providerId,
        type,
        signal,
        steps,
        succeed: () => {
          settle.resolve();
        },
        fail: (error: unknown) => {
          settle.reject(error);
        },
      });
      return settle.promise;
    },
    logout,
  };
  const flow = (index = 0): Flow => {
    const started = flows[index];
    if (started === undefined) throw new Error(`The service started no flow at ${index}.`);
    return started;
  };
  return { pi, flows, flow, logout, offers };
}

interface RecordingOwner extends SignInOwner {
  updates: ModelAccessSignInUpdate[];
}

function recordingOwner(): RecordingOwner {
  const updates: ModelAccessSignInUpdate[] = [];
  return {
    updates,
    send: (update) => {
      updates.push(update);
    },
  };
}

/** Ids a transcript can be read against, minted in the order the service asks. */
function countedIds(): () => string {
  let next = 0;
  return () => `id-${++next}`;
}

function serviceWith(pi: PiSignIn): ModelAccessSignInService {
  return new ModelAccessSignInService({ pi, newId: countedIds() });
}

interface Question {
  prompt: ModelAccessSignInPrompt;
  answer: Promise<string>;
}

/** Raises one step from inside the flow, the way a provider's `prompt()` does. */
function askStep(
  flow: Flow,
  step: Partial<ModelAccessSignInPrompt> = {},
  withdrawn?: AbortSignal,
): Question {
  const prompt: ModelAccessSignInPrompt = {
    promptId: flow.steps.newId(),
    kind: "secret",
    message: "API key",
    placeholder: null,
    options: [],
    ...step,
  };
  return { prompt, answer: flow.steps.ask(prompt, withdrawn) };
}

/** Lets the login promise's own `.then` — the one `begin` deliberately drops — run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const LIVE_KEY = "sk-live-9f2c4a7b1e8d6035aa11";

// --- tests -----------------------------------------------------------------

describe("ModelAccessSignInService", () => {
  it("publishes the flow's question, delivers the answer to it, and settles as signed in", async () => {
    const port = scriptedPort();
    const owner = recordingOwner();
    const service = serviceWith(port.pi);

    expect(service.begin("anthropic", "api-key", owner)).toEqual({ ok: true, attemptId: "id-1" });
    const flow = port.flow();
    expect(flow).toMatchObject({ providerId: "anthropic", type: "api-key" });
    const question = askStep(flow);

    expect(owner.updates).toContainEqual({
      attemptId: "id-1",
      kind: "prompt",
      prompt: question.prompt,
    });
    expect(service.respond("id-1", question.prompt.promptId, LIVE_KEY)).toEqual({ ok: true });
    await expect(question.answer).resolves.toBe(LIVE_KEY);

    flow.succeed();
    await flush();

    expect(owner.updates.at(-1)).toEqual({
      attemptId: "id-1",
      kind: "settled",
      // Stored, not verified: no provider offers a validation call.
      outcome: { kind: "signed-in" },
    });
  });

  it("rejects the parked question on cancel and calls the ending cancelled, not failed", async () => {
    const port = scriptedPort();
    const owner = recordingOwner();
    const service = serviceWith(port.pi);
    service.begin("anthropic", "api-key", owner);
    const flow = port.flow();
    const question = askStep(flow);

    expect(service.cancel("id-1")).toEqual({ ok: true });
    await expect(question.answer).rejects.toMatchObject({ name: "AbortError" });

    // Whatever the aborted step threw on the way out — the verdict is ours.
    flow.fail(new Error("The operation was aborted."));
    await flush();

    expect(owner.updates.at(-1)).toEqual({
      attemptId: "id-1",
      kind: "settled",
      outcome: { kind: "cancelled" },
    });
    // `settled` retires every question at once, so a per-prompt withdrawal
    // would be a second retirement of the same step.
    expect(owner.updates.filter((update) => update.kind === "prompt-withdrawn")).toEqual([]);
  });

  it("drops a window's attempts when the window goes, freeing the provider it was holding", async () => {
    const port = scriptedPort();
    const owner = recordingOwner();
    const service = serviceWith(port.pi);
    service.begin("anthropic", "api-key", owner);
    const flow = port.flow();
    const question = askStep(flow);

    service.abandonOwner(owner);
    await expect(question.answer).rejects.toMatchObject({ name: "AbortError" });

    flow.fail(new Error("aborted"));
    await flush();

    expect(owner.updates.at(-1)).toEqual({
      attemptId: "id-1",
      kind: "settled",
      outcome: { kind: "cancelled" },
    });
    // The slot is released rather than held to quit by a flow nobody can answer.
    expect(service.begin("anthropic", "api-key", recordingOwner())).toMatchObject({ ok: true });
  });

  it("withdraws the question when the flow takes it back, and refuses the answer that lost the race", async () => {
    const port = scriptedPort();
    const owner = recordingOwner();
    const service = serviceWith(port.pi);
    service.begin("anthropic", "oauth", owner);
    const flow = port.flow();
    const withdrawn = new AbortController();
    const question = askStep(
      flow,
      { kind: "manual-code", message: "Paste the code from the browser" },
      withdrawn.signal,
    );

    // The loopback callback server won.
    withdrawn.abort();

    expect(owner.updates).toContainEqual({
      attemptId: "id-1",
      kind: "prompt-withdrawn",
      promptId: question.prompt.promptId,
    });
    await expect(question.answer).rejects.toMatchObject({ name: "AbortError" });

    // A code pasted a moment too late must not be delivered to the next
    // question the flow asks.
    expect(service.respond("id-1", question.prompt.promptId, "late-code")).toEqual({
      ok: false,
      error: "This sign-in step is no longer waiting for an answer.",
    });
  });

  it("refuses an answer that names no live attempt, no pending step, or a step already answered", async () => {
    const port = scriptedPort();
    const owner = recordingOwner();
    const service = serviceWith(port.pi);
    service.begin("anthropic", "api-key", owner);
    const flow = port.flow();
    const question = askStep(flow);

    expect(service.respond("id-not-an-attempt", question.prompt.promptId, "value")).toEqual({
      ok: false,
      error: "This sign-in is no longer running.",
    });
    expect(service.respond("id-1", "id-not-a-prompt", "value")).toEqual({
      ok: false,
      error: "This sign-in step is no longer waiting for an answer.",
    });
    expect(service.respond("id-1", question.prompt.promptId, "first")).toEqual({ ok: true });
    expect(service.respond("id-1", question.prompt.promptId, "second")).toEqual({
      ok: false,
      error: "This sign-in step is no longer waiting for an answer.",
    });
    await expect(question.answer).resolves.toBe("first");
  });

  it("runs one attempt per provider and another provider alongside it", async () => {
    const port = scriptedPort();
    const owner = recordingOwner();
    const service = serviceWith(port.pi);
    service.begin("anthropic", "api-key", owner);

    expect(service.begin("anthropic", "oauth", owner)).toEqual({
      ok: false,
      error: "This provider is already signing in.",
    });
    // Refused rather than queued: nothing was started to race the first.
    expect(port.flows).toHaveLength(1);

    expect(service.begin("openai-codex", "oauth", owner)).toMatchObject({ ok: true });
    expect(port.flows).toHaveLength(2);

    port.flow().succeed();
    await flush();

    expect(service.begin("anthropic", "api-key", owner)).toMatchObject({ ok: true });
  });

  it("starts nothing for a method the provider does not offer", () => {
    const port = scriptedPort({ offers: false });
    const owner = recordingOwner();

    expect(serviceWith(port.pi).begin("anthropic", "oauth", owner)).toEqual({
      ok: false,
      error: "This provider does not offer that sign-in method.",
    });

    expect(port.offers).toHaveBeenCalledExactlyOnceWith("anthropic", "oauth");
    expect(port.flows).toEqual([]);
    // Nothing was begun, so there is no attempt for an update to be about.
    expect(owner.updates).toEqual([]);
  });

  it("keeps a submitted key out of the failure a provider echoed it back in", async () => {
    const port = scriptedPort();
    const owner = recordingOwner();
    const service = serviceWith(port.pi);
    service.begin("anthropic", "api-key", owner);
    const flow = port.flow();
    const question = askStep(flow);
    service.respond("id-1", question.prompt.promptId, LIVE_KEY);
    await question.answer;

    flow.fail(new Error(`401 invalid_api_key for request {"api_key":"${LIVE_KEY}"}`));
    await flush();

    const settled = owner.updates.at(-1);
    expect(settled).toMatchObject({ kind: "settled", outcome: { kind: "failed" } });
    const message =
      settled?.kind === "settled" && settled.outcome.kind === "failed"
        ? settled.outcome.message
        : "";
    expect(message).not.toContain(LIVE_KEY);
    expect(message).toContain("[redacted]");
    expect(message).toContain("401 invalid_api_key");
    // Not just the verdict: nothing on the whole channel carries what was typed.
    expect(JSON.stringify(owner.updates)).not.toContain(LIVE_KEY);
  });

  it("delegates a sign-out and reports a refusal in the store's own words", async () => {
    const port = scriptedPort();
    const { logout } = port;

    await expect(serviceWith(port.pi).signOut("anthropic")).resolves.toEqual({ ok: true });
    expect(logout).toHaveBeenCalledExactlyOnceWith("anthropic");

    logout.mockRejectedValueOnce(new Error("Could not lock Pi credentials."));
    await expect(serviceWith(port.pi).signOut("anthropic")).resolves.toEqual({
      ok: false,
      error: "Could not lock Pi credentials.",
    });
  });
});

describe("redactSubmitted", () => {
  it("blanks every occurrence of a submitted credential and leaves short answers alone", () => {
    expect(redactSubmitted(`rejected ${LIVE_KEY}; retried ${LIVE_KEY}`, new Set([LIVE_KEY]))).toBe(
      "rejected [redacted]; retried [redacted]",
    );

    expect(redactSubmitted("The account is not enrolled.", new Set([LIVE_KEY]))).toBe(
      "The account is not enrolled.",
    );

    // A menu choice and a project id are not credentials, and blanking them
    // would shred the message without protecting anything.
    expect(redactSubmitted("Project acct-1 rejected the key.", new Set(["acct-1"]))).toBe(
      "Project acct-1 rejected the key.",
    );
  });
});
