// @vitest-environment node
/**
 * The remote sign-in wiring (VC-702 PR 2) against a fake client link and a
 * fake service: the host's operations by path, answers checked against the
 * published schemas, the engine's link lookup, and one running sign-in per
 * host and provider, cancelled when its stream ends.
 */
import type {
  HostLink,
  HostLinkState,
  HostLinkSubscriptionHandlers,
} from "@volli/host-protocol/client-link";
import type { HostSignInRunEvent } from "@volli/shared";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { engineSignInLinks, hostLinkSignIns, remoteSignInsPort, signInPreflight } from "./port";
import {
  createHostSignInService,
  type HostSignInHostLink,
  type HostSignInService,
} from "./service";
import {
  HostFlowLedger,
  REFUSED_SIGN_IN_LINK,
  REPLACE_ATTEMPTS,
  REPLACE_RETRY_MS,
  STILL_ENDING,
  type HostSignInRun,
} from "./sign-in-runner";

const STATUS = { providers: [], git: [{ host: "github.com", state: "signed-in", kind: "git" }] };

function fakeLink(answers: Record<string, unknown>) {
  const calls: [string, string, unknown][] = [];
  let handlers: HostLinkSubscriptionHandlers | null = null;
  let state: HostLinkState = { status: "ready", welcome: {} as never };
  const watchers = new Set<(state: HostLinkState) => void>();
  const link = {
    getState: () => state,
    subscribeState: (listener: (state: HostLinkState) => void) => {
      watchers.add(listener);
      return () => watchers.delete(listener);
    },
    query: vi.fn(async (path: string, input?: unknown) => {
      calls.push(["query", path, input]);
      return answers[path];
    }),
    mutate: vi.fn(async (path: string, input?: unknown) => {
      calls.push(["mutate", path, input]);
      if (answers[path] instanceof Error) throw answers[path];
      return answers[path];
    }),
    subscribe: vi.fn((path: string, input: unknown, next: HostLinkSubscriptionHandlers) => {
      calls.push(["subscribe", path, input]);
      handlers = next;
      return { unsubscribe: vi.fn() };
    }),
  } as unknown as HostLink;
  return {
    link,
    calls,
    handlers: () => handlers!,
    watchers,
    set(next: HostLinkState) {
      state = next;
      for (const watcher of watchers) watcher(next);
    },
  };
}

describe("hostLinkSignIns", () => {
  it("calls each host operation by its path and checks what the host answers", async () => {
    const host = fakeLink({
      "signIns.status": STATUS,
      "signIns.setApiKey": STATUS,
      "signIns.setGitCredential": STATUS,
      "signIns.start": { flowId: "flow-1" },
      "auth.callback.deliver": { status: 200 },
      "signIns.answer": null,
      "signIns.cancel": null,
    });
    const signIns = hostLinkSignIns(host.link);
    expect(await signIns.status()).toEqual(STATUS);
    expect(await signIns.setApiKey({ providerId: "p", key: "k" })).toEqual(STATUS);
    expect(
      await signIns.setGitCredential({ host: "github.com", username: "u", password: "t" }),
    ).toEqual(STATUS);
    expect(await signIns.start({ providerId: "xai" })).toEqual({ flowId: "flow-1" });
    expect(await signIns.deliver({ flowId: "flow-1", pathAndQuery: "/cb?code=c" })).toEqual({
      status: 200,
    });
    await signIns.answer({ flowId: "flow-1", promptId: "p", value: "" });
    await signIns.cancel({ flowId: "flow-1" });
    expect(host.calls.map(([kind, path]) => `${kind} ${path}`)).toEqual([
      "query signIns.status",
      "mutate signIns.setApiKey",
      "mutate signIns.setGitCredential",
      "mutate signIns.start",
      "mutate auth.callback.deliver",
      "mutate signIns.answer",
      "mutate signIns.cancel",
    ]);
  });

  it("refuses a host that answers badly, and skips an update this build does not know", async () => {
    for (const answers of [
      { "signIns.start": {}, "auth.callback.deliver": {} },
      { "signIns.start": { flowId: "" }, "auth.callback.deliver": { status: Number.NaN } },
      { "signIns.start": { flowId: "x".repeat(257) }, "auth.callback.deliver": { status: 200.5 } },
    ]) {
      const bad = hostLinkSignIns(
        fakeLink({
          "signIns.status": { providers: "nope" },
          "signIns.answer": { ok: true },
          "signIns.cancel": "done",
          ...answers,
        }).link,
      );
      await expect(bad.status()).rejects.toThrow();
      await expect(bad.start({ providerId: "xai" })).rejects.toThrow("started no sign-in");
      await expect(bad.deliver({ flowId: "f", pathAndQuery: "/cb" })).rejects.toThrow(
        "did not say",
      );
      await expect(bad.answer({ flowId: "f", promptId: "p", value: "" })).rejects.toThrow();
      await expect(bad.cancel({ flowId: "f" })).rejects.toThrow();
    }
    const host = fakeLink({ "signIns.cancel": new Error("gone") });
    const seen: unknown[] = [];
    const errors: unknown[] = [];
    let completed = 0;
    hostLinkSignIns(host.link).subscribe(
      { flowId: "f" },
      {
        onData: (update) => void seen.push(update),
        onError: (error) => void errors.push(error),
        onComplete: () => void (completed += 1),
      },
    );
    const handlers = host.handlers();
    handlers.onData({ kind: "progress", message: "Waiting" });
    handlers.onData({ kind: "a-kind-from-tomorrow" });
    // A known update that breaks its schema ends the sign-in, here and on the host.
    handlers.onData({
      kind: "auth-url",
      url: "file:///System/Applications/Calculator.app",
      instructions: null,
    });
    handlers.onData({
      kind: "device-code",
      userCode: "WXYZ",
      verificationUri: `https://example.com/${"a".repeat(8192)}`,
      intervalSeconds: null,
      expiresInSeconds: null,
    });
    handlers.onData({
      kind: "device-code",
      userCode: "WXYZ",
      verificationUri: "https://accounts.x.ai/device",
      intervalSeconds: null,
      expiresInSeconds: null,
    });
    handlers.onData({ kind: "progress" });
    handlers.onData(null);
    handlers.onResnapshot({ code: "PRECONDITION_FAILED", message: "gone" });
    handlers.onError(new Error("host-unreachable"));
    handlers.onComplete!();
    expect(seen).toEqual([
      { kind: "progress", message: "Waiting" },
      { kind: "failed", message: REFUSED_SIGN_IN_LINK },
      { kind: "failed", message: REFUSED_SIGN_IN_LINK },
      expect.objectContaining({
        kind: "device-code",
        verificationUri: "https://accounts.x.ai/device",
      }),
      { kind: "failed", message: "The host sent a sign-in step Volli can’t read" },
    ]);
    expect(host.calls.filter(([, path]) => path === "signIns.cancel")).toHaveLength(3);
    expect(errors).toHaveLength(2);
    expect(completed).toBe(1);
  });
});

describe("hostLinkSignIns' watch on the link (VC-702 review B2)", () => {
  it("says the connection is gone once, on the first state that is not ready, and stops watching", () => {
    for (const next of [
      { status: "unreachable", attempt: 1, error: {} as never, closeCode: 1006, retryAt: 0 },
      { status: "connecting", attempt: 1 },
      { status: "fenced", error: {} as never },
      { status: "closed" },
    ] satisfies HostLinkState[]) {
      const host = fakeLink({});
      const lost = vi.fn();
      hostLinkSignIns(host.link).watchLoss(lost);
      host.set({ status: "ready", welcome: {} as never });
      expect(lost).not.toHaveBeenCalled();
      host.set(next);
      host.set({ status: "closed" });
      expect(lost).toHaveBeenCalledOnce();
      expect(host.watchers.size).toBe(0);
    }
  });

  it("says so at once for a link already gone, and stops when the run asks", () => {
    const gone = fakeLink({});
    gone.set({ status: "closed" });
    const lost = vi.fn();
    hostLinkSignIns(gone.link).watchLoss(lost);
    expect(lost).toHaveBeenCalledOnce();
    expect(gone.watchers.size).toBe(0);

    const host = fakeLink({});
    const quiet = vi.fn();
    const stop = hostLinkSignIns(host.link).watchLoss(quiet);
    stop();
    expect(host.watchers.size).toBe(0);
    host.set({ status: "closed" });
    expect(quiet).not.toHaveBeenCalled();
  });
});

describe("engineSignInLinks", () => {
  it("answers a link only while the engine lends one", () => {
    let lent: HostLink | null = null;
    const links = engineSignInLinks({ signInLink: () => lent });
    expect(links.linkFor("host-1")).toBeNull();
    lent = fakeLink({}).link;
    expect(links.linkFor("host-1")).not.toBeNull();
  });
});

function fakeService() {
  const runs: { onEvent: (event: HostSignInRunEvent) => void; run: HostSignInRun }[] = [];
  const service = {
    status: vi.fn(async () => STATUS),
    macKeys: vi.fn(async () => ["openrouter"]),
    sendFromThisMac: vi.fn(async () => ({ ok: true, status: STATUS })),
    setApiKey: vi.fn(async () => STATUS),
    setGitCredential: vi.fn(async () => STATUS),
    signInOnHost: vi.fn((_hostId: string, _providerId: string, onEvent) => {
      const ended = Promise.withResolvers<"done" | "failed" | "cancelled" | "lost">();
      const run: HostSignInRun = {
        flowId: Promise.resolve("flow"),
        ended: ended.promise,
        answer: vi.fn(async () => null),
        cancel: vi.fn(async () => {
          ended.resolve("cancelled");
          return true;
        }),
      };
      runs.push({ onEvent, run });
      return run;
    }),
  } as unknown as HostSignInService;
  return { service, runs };
}

describe("remoteSignInsPort", () => {
  it("passes reads and writes through, the confirm's send included", async () => {
    const { service } = fakeService();
    const port = remoteSignInsPort(service);
    expect(await port.status("h")).toEqual(STATUS);
    expect(await port.macKeys()).toEqual(["openrouter"]);
    await port.sendFromThisMac("h", "openrouter");
    expect(service.sendFromThisMac).toHaveBeenCalledWith("h", "openrouter", true);
    await port.setApiKey("h", "openrouter", "k");
    await port.setGitCredential("h", { host: "github.com", username: "u", password: "t" });
    expect(service.setGitCredential).toHaveBeenCalledOnce();
    await signInPreflight(service, "h");
    expect(service.status).toHaveBeenCalledTimes(2);
  });

  it("runs one sign-in per host and provider, answers it, and cancels it when its stream ends", async () => {
    const { service, runs } = fakeService();
    const port = remoteSignInsPort(service);
    const heard: unknown[] = [];
    const stop = await port.run("h", "xai", (event) => void heard.push(event), "run-1");
    expect(service.signInOnHost).toHaveBeenLastCalledWith("h", "xai", expect.any(Function), {
      replaces: undefined,
      ledger: expect.any(HostFlowLedger),
    });
    const ledger = vi.mocked(service.signInOnHost).mock.calls[0]![3]!.ledger;
    runs[0]!.onEvent({ kind: "progress", message: "Waiting" });
    expect(heard).toEqual([{ kind: "progress", message: "Waiting" }]);
    await port.answer("h", "xai", "p", "", "run-1");
    await port.answer("h", "xai", "p", "");
    expect(runs[0]!.run.answer).toHaveBeenCalledTimes(2);
    expect(runs[0]!.run.answer).toHaveBeenCalledWith("p", "");
    // A second for the same provider replaces the first: the run itself waits
    // for the first's flow to be over on the host.
    const stopSecond = await port.run("h", "xai", () => {}, "run-2");
    expect(service.signInOnHost).toHaveBeenLastCalledWith("h", "xai", expect.any(Function), {
      replaces: runs[0]!.run,
      ledger,
    });
    // The first's stream ending, its answer and its cancel reach nothing now.
    stop();
    await expect(port.answer("h", "xai", "p", "x", "run-1")).rejects.toThrow("no longer running");
    await port.cancel("h", "xai", "run-1");
    expect(runs[1]!.run.cancel).not.toHaveBeenCalled();
    expect(runs[1]!.run.answer).not.toHaveBeenCalled();
    await port.cancel("h", "xai", "run-2");
    expect(runs[1]!.run.cancel).toHaveBeenCalledOnce();
    await runs[1]!.run.ended;
    await Promise.resolve();
    await expect(port.answer("h", "xai", "p", "x")).rejects.toThrow("no longer running");
    stopSecond();
    await port.cancel("h", "none");
    // The next for that provider follows the last one, ended or not.
    const stopThird = await port.run("h", "xai", () => {});
    expect(service.signInOnHost).toHaveBeenLastCalledWith("h", "xai", expect.any(Function), {
      replaces: runs[1]!.run,
      ledger,
    });
    // A stream that ends while its sign-in runs cancels it.
    stopThird();
    expect(runs[2]!.run.cancel).toHaveBeenCalledOnce();
  });
});

/** A listener that keeps what it hears in `into`. */
const heard = (into: HostSignInRunEvent[]) => (event: HostSignInRunEvent) => void into.push(event);

describe("remoteSignInsPort's replacements over the real runner (VC-702 review B3)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("still treats an unwinding flow as the old run's after a replacement ran out of retries", async () => {
    vi.useFakeTimers();
    // The host answers flow-1 (cancelled, unwinding) until it lets it go.
    let unwound = false;
    const starts: string[] = [];
    const host: HostSignInHostLink = {
      status: vi.fn(),
      setApiKey: vi.fn(),
      setGitCredential: vi.fn(),
      start: vi.fn(async () => {
        const flowId = starts.length === 0 || !unwound ? "flow-1" : "flow-2";
        starts.push(flowId);
        return { flowId };
      }),
      subscribe: vi.fn(() => ({ unsubscribe: () => {} })),
      deliver: vi.fn(),
      answer: vi.fn(async () => null),
      cancel: vi.fn(async () => null),
      watchLoss: () => () => {},
    };
    const port = remoteSignInsPort(
      createHostSignInService({
        links: { linkFor: () => host },
        mac: { list: async () => [], read: async () => undefined },
        openExternal: vi.fn(),
      }),
    );
    const a: HostSignInRunEvent[] = [];
    await port.run("h", "anthropic", heard(a), "run-a");
    await vi.advanceTimersByTimeAsync(0);
    // B replaces A and runs out of retries while flow-1 unwinds.
    const b: HostSignInRunEvent[] = [];
    await port.run("h", "anthropic", heard(b), "run-b");
    await vi.advanceTimersByTimeAsync(REPLACE_RETRY_MS * REPLACE_ATTEMPTS);
    expect(b).toEqual([{ kind: "failed", message: STILL_ENDING }]);
    // The person tries again: flow-1 is still not this run's.
    const c: HostSignInRunEvent[] = [];
    await port.run("h", "anthropic", heard(c), "run-c");
    await vi.advanceTimersByTimeAsync(REPLACE_RETRY_MS * 3);
    expect(c).toEqual([]);
    expect(host.subscribe).toHaveBeenCalledTimes(1);
    unwound = true;
    await vi.advanceTimersByTimeAsync(REPLACE_RETRY_MS);
    expect(starts.at(-1)).toBe("flow-2");
    expect(host.subscribe).toHaveBeenLastCalledWith({ flowId: "flow-2" }, expect.anything());
    expect(host.cancel).toHaveBeenCalledTimes(1);
    expect(host.cancel).toHaveBeenCalledWith({ flowId: "flow-1" });
  });
});
