// @vitest-environment node
/**
 * A sign-in on a host driven from this Mac, against a fake host link and a
 * fake relay bind: the order (bind, then open the browser), the paste
 * fallback, and that the relay ends with the flow.
 */
import type { HostSignInUpdate } from "@volli/shared";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { RelayBinding, RelayOutcome } from "./relay-client";
import {
  CANCEL_WAIT_MS,
  HostFlowLedger,
  isOpenableSignInUrl,
  MAX_SIGN_IN_URL_LENGTH,
  REFUSED_SIGN_IN_LINK,
  REPLACE_ATTEMPTS,
  REPLACE_RETRY_MS,
  RUN_DEADLINE_MS,
  RUN_TIMED_OUT,
  runHostSignIn,
  STILL_ENDING,
  type HostSignInLink,
  type HostSignInRunEvent,
} from "./sign-in-runner";

// The global main-test cleanup imports broadcast; never load a real Electron binary.
vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] } }));

function fakeLink(options: { startFails?: boolean } = {}) {
  let observer: Parameters<HostSignInLink["subscribe"]>[1] | null = null;
  const unsubscribe = vi.fn();
  let lost: (() => void) | null = null;
  const stopWatching = vi.fn();
  const link = {
    start: vi.fn(async (_input: { providerId: string; type?: string }) => {
      if (options.startFails === true) throw new Error("sign-in-conflict");
      return { flowId: "flow-1" };
    }),
    subscribe: vi.fn((_flow: { flowId: string }, next: NonNullable<typeof observer>) => {
      observer = next;
      return { unsubscribe };
    }),
    deliver: vi.fn(async () => ({ status: 200 })),
    answer: vi.fn(async () => null),
    cancel: vi.fn(async (_flow: { flowId: string }): Promise<unknown> => null),
    watchLoss: vi.fn((listener: () => void) => {
      lost = listener;
      return stopWatching;
    }),
  } satisfies HostSignInLink;
  return {
    link,
    emit: (update: HostSignInUpdate) => observer!.onData(update),
    error: () => observer!.onError(new Error("host-unreachable")),
    complete: () => observer!.onComplete(),
    subscribed: () => observer !== null,
    unsubscribe,
    /** The link's connection went: dropped, retired or closed. */
    drop: () => lost!(),
    stopWatching,
  };
}

/** Whether `promise` has settled yet, after the microtasks queued so far ran. */
async function settledYet<T>(promise: Promise<T>): Promise<T | "pending"> {
  return Promise.race([promise, settle().then(() => "pending" as const)]);
}

async function settle(): Promise<void> {
  for (let index = 0; index < 10; index++) await Promise.resolve();
}

function fakeBind(result: "bound" | "port-taken") {
  const outcome = Promise.withResolvers<RelayOutcome>();
  const close = vi.fn(() => outcome.resolve({ kind: "closed" }));
  const order: string[] = [];
  const bind = vi.fn(
    async (redirectUri: string, deliver: (pathAndQuery: string) => Promise<{ status: number }>) => {
      order.push(`bind ${redirectUri}`);
      if (result === "port-taken") {
        return { kind: "unavailable", reason: "port-taken" } as RelayBinding;
      }
      return {
        kind: "bound",
        outcome: outcome.promise,
        close,
        deliverForTest: deliver,
      } as unknown as RelayBinding;
    },
  );
  return { bind, outcome, close, order };
}

/** A run being replaced: its cancel says whether the host was asked in time. */
function replaced(asked: boolean) {
  return {
    flowId: Promise.resolve("flow-1"),
    ended: Promise.resolve("cancelled" as const),
    answer: vi.fn(),
    cancel: vi.fn(async () => asked),
  };
}

/** The host and provider's ledger, still holding the replaced run's unwinding flow-1. */
function holdingFlowOne(): HostFlowLedger {
  const ledger = new HostFlowLedger();
  ledger.started("flow-1");
  return ledger;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("runHostSignIn", () => {
  it("binds the relay before opening the browser, and closes it when the flow ends", async () => {
    const host = fakeLink();
    const relay = fakeBind("bound");
    const events: HostSignInRunEvent[] = [];
    const openExternal = vi.fn((url: string) => {
      relay.order.push(`open ${url}`);
    });
    const run = runHostSignIn({
      link: host.link,
      providerId: "anthropic",
      openExternal,
      onEvent: (event) => events.push(event),
      bind: relay.bind,
    });
    expect(await run.flowId).toBe("flow-1");
    expect(host.link.start).toHaveBeenCalledWith({ providerId: "anthropic" });
    host.emit({
      kind: "auth-callback",
      flowId: "flow-1",
      redirectUri: "http://localhost:53692/callback",
    });
    host.emit({ kind: "auth-url", url: "https://claude.ai/oauth/authorize", instructions: null });
    await settle();
    expect(relay.order).toEqual([
      "bind http://localhost:53692/callback",
      "open https://claude.ai/oauth/authorize",
    ]);
    // The relay delivers through the host link, under this flow.
    const deliver = relay.bind.mock.calls[0]![1] as (p: string) => Promise<{ status: number }>;
    await deliver("/callback?code=c&state=s");
    expect(host.link.deliver).toHaveBeenCalledWith({
      flowId: "flow-1",
      pathAndQuery: "/callback?code=c&state=s",
    });
    relay.outcome.resolve({ kind: "delivered", status: 200 });
    await settle();
    host.emit({ kind: "done" });
    expect(await run.ended).toBe("done");
    expect(relay.close).toHaveBeenCalled();
    expect(
      events.map((event) => (event.kind === "relay" ? `relay:${event.state}` : event.kind)),
    ).toEqual(["relay:listening", "auth-url", "relay:delivered", "done"]);
  });

  it("falls back to paste when the port is taken: the row answers the flow's own step", async () => {
    const host = fakeLink();
    const relay = fakeBind("port-taken");
    const events: HostSignInRunEvent[] = [];
    const run = runHostSignIn({
      link: host.link,
      providerId: "anthropic",
      openExternal: vi.fn(),
      onEvent: (event) => events.push(event),
      bind: relay.bind,
    });
    await run.flowId;
    host.emit({ kind: "auth-callback", flowId: "flow-1", redirectUri: "http://localhost:1/cb" });
    host.emit({
      kind: "prompt",
      prompt: {
        promptId: "p1",
        kind: "manual-code",
        message: "Paste",
        placeholder: null,
        options: [],
      },
    });
    await settle();
    expect(events.map((event) => event.kind)).toEqual(["relay", "prompt"]);
    expect(events[0]).toEqual({ kind: "relay", state: "paste" });
    await run.answer("p1", "http://localhost:1/cb?code=c&state=s");
    expect(host.link.answer).toHaveBeenCalledWith({
      flowId: "flow-1",
      promptId: "p1",
      value: "http://localhost:1/cb?code=c&state=s",
    });
    host.emit({ kind: "failed", message: "invalid_grant" });
    expect(await run.ended).toBe("failed");
  });

  it("reports a delivery the host refused, so the row offers paste", async () => {
    const host = fakeLink();
    const relay = fakeBind("bound");
    const events: HostSignInRunEvent[] = [];
    const run = runHostSignIn({
      link: host.link,
      providerId: "anthropic",
      openExternal: vi.fn(),
      onEvent: (event) => events.push(event),
      bind: relay.bind,
    });
    await run.flowId;
    host.emit({ kind: "auth-callback", flowId: "flow-1", redirectUri: "http://localhost:1/cb" });
    await settle();
    relay.outcome.resolve({ kind: "delivered", status: 400 });
    await settle();
    expect(events.at(-1)).toEqual({ kind: "relay", state: "failed" });
    host.emit({ kind: "cancelled" });
    expect(await run.ended).toBe("cancelled");
  });

  it("passes a device code and every other step through, and cancels on the host", async () => {
    const host = fakeLink();
    const events: HostSignInRunEvent[] = [];
    const run = runHostSignIn({
      link: host.link,
      providerId: "xai",
      type: "oauth",
      openExternal: vi.fn(),
      onEvent: (event) => events.push(event),
      bind: fakeBind("bound").bind,
    });
    await run.flowId;
    expect(host.link.start).toHaveBeenCalledWith({ providerId: "xai", type: "oauth" });
    host.emit({
      kind: "device-code",
      userCode: "WXYZ-1234",
      verificationUri: "https://accounts.x.ai/device",
      intervalSeconds: 5,
      expiresInSeconds: 900,
    });
    host.emit({ kind: "progress", message: "Waiting" });
    await settle();
    expect(events.map((event) => event.kind)).toEqual(["device-code", "progress"]);
    await run.cancel();
    expect(host.link.cancel).toHaveBeenCalledWith({ flowId: "flow-1" });
    host.emit({ kind: "cancelled" });
    expect(await run.ended).toBe("cancelled");
    // Nothing more after the end, and nothing to cancel.
    host.emit({ kind: "progress", message: "late" });
    await run.cancel();
    expect(host.link.cancel).toHaveBeenCalledOnce();
    expect(events.at(-1)).toEqual({ kind: "cancelled" });
  });

  it("opens only a plain web page the host names; anything else ends the sign-in, here and there", async () => {
    for (const url of [
      "file:///System/Applications/Calculator.app",
      "shortcuts://run-shortcut?name=x",
      "ssh://attacker@example.com",
      "not a url",
      `https://example.com/${"a".repeat(MAX_SIGN_IN_URL_LENGTH)}`,
    ]) {
      const host = fakeLink();
      // The host may refuse the cancel too; the row's end stands.
      host.link.cancel.mockRejectedValueOnce(new Error("gone"));
      const events: HostSignInRunEvent[] = [];
      const openExternal = vi.fn();
      const run = runHostSignIn({
        link: host.link,
        providerId: "anthropic",
        openExternal,
        onEvent: (event) => events.push(event),
        bind: fakeBind("bound").bind,
      });
      await run.flowId;
      host.emit({ kind: "auth-url", url, instructions: null });
      expect(await run.ended).toBe("failed");
      expect(openExternal).not.toHaveBeenCalled();
      expect(host.link.cancel).toHaveBeenCalledWith({ flowId: "flow-1" });
      expect(events).toEqual([{ kind: "failed", message: REFUSED_SIGN_IN_LINK }]);
    }
    const host = fakeLink();
    const events: HostSignInRunEvent[] = [];
    const run = runHostSignIn({
      link: host.link,
      providerId: "xai",
      openExternal: vi.fn(),
      onEvent: (event) => events.push(event),
      bind: fakeBind("bound").bind,
    });
    await run.flowId;
    host.emit({
      kind: "device-code",
      userCode: "WXYZ-1234",
      verificationUri: "shortcuts://run-shortcut",
      intervalSeconds: null,
      expiresInSeconds: null,
    });
    expect(await run.ended).toBe("failed");
    expect(events).toEqual([{ kind: "failed", message: REFUSED_SIGN_IN_LINK }]);
    expect(isOpenableSignInUrl("https://claude.ai/oauth/authorize?code=true", "anthropic")).toBe(
      true,
    );
    expect(isOpenableSignInUrl("http://localhost:1455/start", "anthropic")).toBe(false);
  });

  it.each(["https://phishing.example/login", "http://claude.ai/login"])(
    "shows %s as a manual link without opening or ending the flow",
    async (url) => {
      const host = fakeLink();
      const events: HostSignInRunEvent[] = [];
      const openExternal = vi.fn();
      const run = runHostSignIn({
        link: host.link,
        providerId: "anthropic",
        openExternal,
        onEvent: (event) => events.push(event),
      });
      await run.flowId;
      const browser = { kind: "auth-url", url, instructions: null } as const;
      const device = {
        kind: "device-code",
        userCode: "WXYZ",
        verificationUri: "https://phishing.example/device",
        intervalSeconds: null,
        expiresInSeconds: null,
      } as const;
      host.emit(browser);
      host.emit(device);
      await settle();
      expect(events).toEqual([browser, device]);
      expect(openExternal).not.toHaveBeenCalled();
      expect(host.link.cancel).not.toHaveBeenCalled();
      await run.cancel();
    },
  );

  it("auto-opens only the selected provider's exact authorization host", () => {
    for (const [provider, url] of [
      ["anthropic", "https://claude.ai/oauth/authorize"],
      ["openai", "https://auth.openai.com/authorize"],
      ["openai-codex", "https://auth.openai.com/device"],
      ["github-copilot", "https://github.com/login/device"],
      ["openrouter", "https://openrouter.ai/auth"],
      ["xai", "https://accounts.x.ai/device"],
      ["xai", "https://auth.x.ai/device"],
      ["kimi-coding", "https://auth.kimi.com/device"],
      ["meta", "https://auth.meta.com/device"],
    ] as const)
      expect(isOpenableSignInUrl(url, provider)).toBe(true);
    expect(isOpenableSignInUrl("http://claude.ai/login", "anthropic")).toBe(false);
    expect(isOpenableSignInUrl("https://CLAUDE.AI:443/login", "anthropic")).toBe(true);
    for (const url of [
      "https://claude.ai.attacker.example/login",
      "https://attacker.example/claude.ai",
      "https://claude.ai@attacker.example/login",
      "https://attacker@claude.ai/login",
      "https://:password@claude.ai/login",
      "https://sub.claude.ai/login",
      "https://claude.ai./login",
      "https://claude.ai:444/login",
      "https://clаude.ai/login",
      "not a url",
      "file:///claude.ai",
      `https://claude.ai/${"a".repeat(MAX_SIGN_IN_URL_LENGTH)}`,
    ])
      expect(isOpenableSignInUrl(url, "anthropic")).toBe(false);
    for (const provider of ["openai", "unknown", "radius", "toString", "__proto__"]) {
      expect(isOpenableSignInUrl("https://claude.ai/login", provider)).toBe(false);
    }
  });

  it("falls back to paste when the relay waited long enough", async () => {
    const host = fakeLink();
    const relay = fakeBind("bound");
    const events: HostSignInRunEvent[] = [];
    const run = runHostSignIn({
      link: host.link,
      providerId: "anthropic",
      openExternal: vi.fn(),
      onEvent: (event) => events.push(event),
      bind: relay.bind,
    });
    await run.flowId;
    host.emit({ kind: "auth-callback", flowId: "flow-1", redirectUri: "http://localhost:1/cb" });
    await settle();
    relay.outcome.resolve({ kind: "timed-out" });
    await settle();
    expect(events).toEqual([
      { kind: "relay", state: "listening" },
      { kind: "relay", state: "paste" },
    ]);
  });

  it("says the flow was lost when the host goes away mid-flow", async () => {
    for (const end of ["error", "complete"] as const) {
      const host = fakeLink();
      const events: HostSignInRunEvent[] = [];
      const run = runHostSignIn({
        link: host.link,
        providerId: "xai",
        openExternal: vi.fn(),
        onEvent: (event) => events.push(event),
      });
      await run.flowId;
      if (end === "error") host.error();
      else host.complete();
      expect(await run.ended).toBe("lost");
      expect(events).toEqual([{ kind: "lost" }]);
    }
  });

  it("says the host could not start it, without the host's words", async () => {
    const host = fakeLink({ startFails: true });
    const events: HostSignInRunEvent[] = [];
    const run = runHostSignIn({
      link: host.link,
      providerId: "xai",
      openExternal: vi.fn(),
      onEvent: (event) => events.push(event),
    });
    expect(await run.ended).toBe("failed");
    expect(events).toEqual([{ kind: "failed", message: "This host could not start the sign-in." }]);
    await run.cancel();
    expect(host.link.cancel).not.toHaveBeenCalled();
    expect(host.subscribed()).toBe(false);
  });

  it("closes a relay that bound slowly once the flow ends", async () => {
    const host = fakeLink();
    const late = Promise.withResolvers<RelayBinding>();
    const close = vi.fn();
    const run = runHostSignIn({
      link: host.link,
      providerId: "anthropic",
      openExternal: vi.fn(),
      onEvent: () => {},
      bind: vi.fn(() => late.promise),
    });
    await run.flowId;
    host.emit({ kind: "auth-callback", flowId: "flow-1", redirectUri: "http://localhost:1/cb" });
    await settle();
    host.error();
    host.drop();
    late.resolve({ kind: "bound", outcome: new Promise(() => {}), close });
    await settle();
    expect(await run.ended).toBe("lost");
    expect(close).toHaveBeenCalled();
  });

  it("replaces a grant with the next, ignores what a closed relay or an ended flow says", async () => {
    const host = fakeLink();
    const outcomes = [Promise.withResolvers<RelayOutcome>(), Promise.withResolvers<RelayOutcome>()];
    const closes = [vi.fn(), vi.fn()];
    let calls = 0;
    const events: HostSignInRunEvent[] = [];
    const run = runHostSignIn({
      link: host.link,
      providerId: "anthropic",
      openExternal: vi.fn(),
      onEvent: (event) => events.push(event),
      bind: vi.fn(async () => {
        const index = calls++;
        return {
          kind: "bound",
          outcome: outcomes[index]!.promise,
          close: closes[index]!,
        } as RelayBinding;
      }),
    });
    await run.flowId;
    host.emit({ kind: "auth-callback", flowId: "flow-1", redirectUri: "http://localhost:1/a" });
    host.emit({ kind: "auth-callback", flowId: "flow-1", redirectUri: "http://localhost:2/b" });
    await settle();
    expect(closes[0]).toHaveBeenCalledOnce();
    outcomes[0]!.resolve({ kind: "closed" });
    outcomes[1]!.resolve({ kind: "failed" });
    await settle();
    expect(events.filter((event) => event.kind === "relay")).toEqual([
      { kind: "relay", state: "listening" },
      { kind: "relay", state: "listening" },
      { kind: "relay", state: "failed" },
    ]);
    host.emit({ kind: "done" });
    await settle();
    host.emit({ kind: "progress", message: "after the end" });
    host.error();
    await settle();
    expect(events.at(-1)).toEqual({ kind: "done" });
    expect(closes[1]).toHaveBeenCalled();
  });

  it("keeps the order across a slow bind, and drops a relay's outcome after the end", async () => {
    const host = fakeLink();
    const late = Promise.withResolvers<RelayBinding>();
    const events: HostSignInRunEvent[] = [];
    const run = runHostSignIn({
      link: host.link,
      providerId: "anthropic",
      openExternal: vi.fn(),
      onEvent: (event) => events.push(event),
      bind: vi.fn(() => late.promise),
    });
    await run.flowId;
    host.emit({ kind: "auth-callback", flowId: "flow-1", redirectUri: "http://localhost:1/cb" });
    await settle();
    host.error();
    late.resolve({ kind: "unavailable", reason: "port-taken" });
    expect(await run.ended).toBe("lost");
    await settle();
    // The grant was handled before the loss that followed it.
    expect(events).toEqual([{ kind: "relay", state: "paste" }, { kind: "lost" }]);

    const second = fakeLink();
    const outcome = Promise.withResolvers<RelayOutcome>();
    const secondEvents: HostSignInRunEvent[] = [];
    const secondRun = runHostSignIn({
      link: second.link,
      providerId: "anthropic",
      openExternal: vi.fn(),
      onEvent: (event) => secondEvents.push(event),
      bind: vi.fn(
        async () => ({ kind: "bound", outcome: outcome.promise, close: vi.fn() }) as RelayBinding,
      ),
    });
    await secondRun.flowId;
    second.emit({ kind: "auth-callback", flowId: "flow-1", redirectUri: "http://localhost:1/cb" });
    await settle();
    second.emit({ kind: "cancelled" });
    await secondRun.ended;
    outcome.resolve({ kind: "delivered", status: 200 });
    await settle();
    expect(secondEvents.map((event) => event.kind)).toEqual(["relay", "cancelled"]);
  });

  it("carries on past a browser that would not open, and a cancel the host refused", async () => {
    const host = fakeLink();
    host.link.cancel.mockRejectedValueOnce(new Error("sign-in-unknown"));
    const events: HostSignInRunEvent[] = [];
    const run = runHostSignIn({
      link: host.link,
      providerId: "anthropic",
      openExternal: () => {
        throw new Error("no browser");
      },
      onEvent: (event) => events.push(event),
    });
    await run.flowId;
    host.emit({ kind: "auth-url", url: "https://claude.ai/oauth/authorize", instructions: null });
    host.emit({ kind: "progress", message: "Waiting" });
    await settle();
    expect(events.map((event) => event.kind)).toEqual(["auth-url", "progress"]);
    await expect(run.cancel()).resolves.toBe(true);
    host.emit({ kind: "done" });
    expect(await run.ended).toBe("cancelled");
  });
  describe("cancelling here (VC-702 review B1)", () => {
    it("ends the run at once, with no word from the host, and lets go of everything it held", async () => {
      for (const host of ["silent", "refuses"] as const) {
        const link = fakeLink();
        if (host === "silent") link.link.cancel.mockReturnValue(new Promise(() => {}));
        else link.link.cancel.mockRejectedValue(new Error("host-unreachable"));
        const relay = fakeBind("bound");
        const events: HostSignInRunEvent[] = [];
        const run = runHostSignIn({
          link: link.link,
          providerId: "anthropic",
          openExternal: vi.fn(),
          onEvent: (event) => events.push(event),
          bind: relay.bind,
        });
        await run.flowId;
        link.emit({
          kind: "auth-callback",
          flowId: "flow-1",
          redirectUri: "http://localhost:1/cb",
        });
        await settle();
        void run.cancel();
        expect(await settledYet(run.ended)).toBe("cancelled");
        expect(relay.close).toHaveBeenCalledOnce();
        expect(link.unsubscribe).toHaveBeenCalledOnce();
        expect(link.link.cancel).toHaveBeenCalledWith({ flowId: "flow-1" });
        expect(events.at(-1)).toEqual({ kind: "cancelled" });
        // What the host says after is not heard, and a second cancel asks nothing more.
        link.emit({ kind: "progress", message: "late" });
        void run.cancel();
        await settle();
        expect(events.at(-1)).toEqual({ kind: "cancelled" });
        expect(link.link.cancel).toHaveBeenCalledOnce();
      }
    });

    it("cancelled while the host starts it: never subscribes, and cancels the flow once it is known", async () => {
      const link = fakeLink();
      const started = Promise.withResolvers<{ flowId: string }>();
      link.link.start.mockReturnValueOnce(started.promise);
      const events: HostSignInRunEvent[] = [];
      const run = runHostSignIn({
        link: link.link,
        providerId: "anthropic",
        openExternal: vi.fn(),
        onEvent: (event) => events.push(event),
        bind: fakeBind("bound").bind,
      });
      const cancelled = run.cancel();
      expect(await settledYet(run.ended)).toBe("cancelled");
      started.resolve({ flowId: "flow-1" });
      await cancelled;
      expect(link.link.subscribe).not.toHaveBeenCalled();
      expect(link.link.cancel).toHaveBeenCalledWith({ flowId: "flow-1" });
      expect(events).toEqual([{ kind: "cancelled" }]);
    });

    it("cancelled while the relay binds: the late listener closes, and the page after it never opens", async () => {
      const link = fakeLink();
      const late = Promise.withResolvers<RelayBinding>();
      const close = vi.fn();
      const openExternal = vi.fn();
      const run = runHostSignIn({
        link: link.link,
        providerId: "anthropic",
        openExternal,
        onEvent: () => {},
        bind: vi.fn(() => late.promise),
      });
      await run.flowId;
      link.emit({ kind: "auth-callback", flowId: "flow-1", redirectUri: "http://localhost:1/cb" });
      link.emit({ kind: "auth-url", url: "https://claude.ai/oauth/authorize", instructions: null });
      await settle();
      void run.cancel();
      expect(await settledYet(run.ended)).toBe("cancelled");
      late.resolve({ kind: "bound", outcome: new Promise(() => {}), close });
      await settle();
      expect(close).toHaveBeenCalledOnce();
      expect(openExternal).not.toHaveBeenCalled();
    });

    it("cancelled while the relay fails to bind: says nothing more", async () => {
      const link = fakeLink();
      const late = Promise.withResolvers<RelayBinding>();
      const events: HostSignInRunEvent[] = [];
      const run = runHostSignIn({
        link: link.link,
        providerId: "anthropic",
        openExternal: vi.fn(),
        onEvent: (event) => events.push(event),
        bind: vi.fn(() => late.promise),
      });
      await run.flowId;
      link.emit({ kind: "auth-callback", flowId: "flow-1", redirectUri: "http://localhost:1/cb" });
      await settle();
      void run.cancel();
      late.resolve({ kind: "unavailable", reason: "port-taken" });
      await settle();
      expect(events).toEqual([{ kind: "cancelled" }]);
    });
  });
  describe("the link's connection going (VC-702 review B2)", () => {
    it("ends lost at once, closes the relay and withdraws the stream, whatever the stream says after", async () => {
      const host = fakeLink();
      const relay = fakeBind("bound");
      const events: HostSignInRunEvent[] = [];
      const ledger = new HostFlowLedger();
      const run = runHostSignIn({
        link: host.link,
        providerId: "anthropic",
        openExternal: vi.fn(),
        onEvent: (event) => events.push(event),
        bind: relay.bind,
        ledger,
      });
      await run.flowId;
      host.emit({ kind: "auth-callback", flowId: "flow-1", redirectUri: "http://localhost:1/cb" });
      await settle();
      expect(ledger.holds("flow-1")).toBe(true);
      host.drop();
      expect(await settledYet(run.ended)).toBe("lost");
      // Its connection gone, the host ended its flow with it.
      expect(ledger.holds("flow-1")).toBe(false);
      expect(relay.close).toHaveBeenCalledOnce();
      expect(host.unsubscribe).toHaveBeenCalledOnce();
      expect(host.stopWatching).toHaveBeenCalledOnce();
      host.error();
      host.drop();
      await settle();
      expect(events).toEqual([{ kind: "relay", state: "listening" }, { kind: "lost" }]);
      // Nothing is left on the host to cancel from here, and nothing is answered.
      expect(await run.cancel()).toBe(true);
      expect(host.link.cancel).not.toHaveBeenCalled();
      await expect(run.answer("p", "x")).rejects.toThrow("no longer running");
    });

    it("never starts on a link that was already gone", async () => {
      const host = fakeLink();
      host.link.watchLoss.mockImplementationOnce((lost: () => void) => {
        lost();
        return host.stopWatching;
      });
      const events: HostSignInRunEvent[] = [];
      const run = runHostSignIn({
        link: host.link,
        providerId: "anthropic",
        openExternal: vi.fn(),
        onEvent: (event) => events.push(event),
      });
      expect(await run.ended).toBe("lost");
      await expect(run.flowId).rejects.toThrow("cancelled");
      expect(host.link.start).not.toHaveBeenCalled();
      expect(host.stopWatching).toHaveBeenCalledOnce();
      expect(events).toEqual([{ kind: "lost" }]);
      expect(await run.cancel()).toBe(true);
    });
  });

  describe("replacing a run (VC-702 review B3)", () => {
    it("starts once the old run's flow is over, asking again while the host still holds it", async () => {
      vi.useFakeTimers();
      const host = fakeLink();
      host.link.start
        .mockResolvedValueOnce({ flowId: "flow-1" })
        .mockResolvedValueOnce({ flowId: "flow-1" })
        .mockResolvedValueOnce({ flowId: "flow-2" });
      const old = replaced(true);
      const ledger = holdingFlowOne();
      const run = runHostSignIn({
        link: host.link,
        providerId: "anthropic",
        openExternal: vi.fn(),
        onEvent: () => {},
        replaces: old,
        ledger,
      });
      await vi.advanceTimersByTimeAsync(REPLACE_RETRY_MS * 2);
      expect(await run.flowId).toBe("flow-2");
      // A fresh flow tells that the host holds no other: flow-1 is over.
      expect(ledger.holds("flow-1")).toBe(false);
      expect(ledger.holds("flow-2")).toBe(true);
      expect(old.cancel).toHaveBeenCalledOnce();
      expect(host.link.start).toHaveBeenCalledTimes(3);
      expect(host.link.subscribe).toHaveBeenCalledWith({ flowId: "flow-2" }, expect.anything());
    });

    it("fails, saying so, when the old flow never ends or the host never answered its cancel", async () => {
      vi.useFakeTimers();
      for (const asked of [true, false]) {
        const host = fakeLink();
        const events: HostSignInRunEvent[] = [];
        const ledger = holdingFlowOne();
        const run = runHostSignIn({
          link: host.link,
          providerId: "anthropic",
          openExternal: vi.fn(),
          onEvent: (event) => events.push(event),
          replaces: replaced(asked),
          ledger,
        });
        await vi.advanceTimersByTimeAsync(REPLACE_RETRY_MS * REPLACE_ATTEMPTS);
        expect(await run.ended).toBe("failed");
        expect(events).toEqual([{ kind: "failed", message: STILL_ENDING }]);
        expect(host.link.start).toHaveBeenCalledTimes(asked ? REPLACE_ATTEMPTS : 0);
        expect(host.link.subscribe).not.toHaveBeenCalled();
        // Giving up says nothing about the old flow: it is still the host's.
        expect(ledger.holds("flow-1")).toBe(true);
      }
    });

    it("stops asking once it is cancelled itself, and never cancels the old run's flow", async () => {
      vi.useFakeTimers();
      const host = fakeLink();
      const run = runHostSignIn({
        link: host.link,
        providerId: "anthropic",
        openExternal: vi.fn(),
        onEvent: () => {},
        replaces: replaced(true),
        ledger: holdingFlowOne(),
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(host.link.start).toHaveBeenCalledOnce();
      // Mid-wait: the cancel wakes it at once, with no timer left behind.
      expect(await run.cancel()).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      expect(host.link.start).toHaveBeenCalledOnce();
      expect(host.link.cancel).not.toHaveBeenCalled();
    });
  });

  describe("bounded in time (VC-702 review B4)", () => {
    it("ends the run, here and on the host, at its deadline, and lets go of the relay", async () => {
      vi.useFakeTimers();
      const host = fakeLink();
      const relay = fakeBind("bound");
      const events: HostSignInRunEvent[] = [];
      const run = runHostSignIn({
        link: host.link,
        providerId: "anthropic",
        openExternal: vi.fn(),
        onEvent: (event) => events.push(event),
        bind: relay.bind,
      });
      await vi.advanceTimersByTimeAsync(0);
      host.emit({ kind: "auth-callback", flowId: "flow-1", redirectUri: "http://localhost:1/cb" });
      await vi.advanceTimersByTimeAsync(RUN_DEADLINE_MS - 1);
      expect(await settledYet(run.ended)).toBe("pending");
      await vi.advanceTimersByTimeAsync(1);
      expect(await run.ended).toBe("failed");
      expect(relay.close).toHaveBeenCalledOnce();
      expect(host.unsubscribe).toHaveBeenCalledOnce();
      expect(host.link.cancel).toHaveBeenCalledWith({ flowId: "flow-1" });
      expect(events.at(-1)).toEqual({ kind: "failed", message: RUN_TIMED_OUT });
      expect(vi.getTimerCount()).toBe(0);
    });

    it("clears its deadline on every end", async () => {
      vi.useFakeTimers();
      const host = fakeLink();
      const ledger = new HostFlowLedger();
      const run = runHostSignIn({
        link: host.link,
        providerId: "xai",
        openExternal: vi.fn(),
        onEvent: () => {},
        ledger,
      });
      await vi.advanceTimersByTimeAsync(0);
      host.emit({ kind: "done" });
      expect(await run.ended).toBe("done");
      expect(ledger.holds("flow-1")).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("stops waiting on a host that never answers the start or the cancel", async () => {
      vi.useFakeTimers();
      const host = fakeLink();
      host.link.start.mockReturnValueOnce(new Promise(() => {}));
      const run = runHostSignIn({
        link: host.link,
        providerId: "xai",
        openExternal: vi.fn(),
        onEvent: () => {},
      });
      const left = run.cancel();
      expect(await settledYet(run.ended)).toBe("cancelled");
      await vi.advanceTimersByTimeAsync(CANCEL_WAIT_MS);
      expect(await left).toBe(false);
    });
  });
});
