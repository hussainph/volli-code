// @vitest-environment node
/**
 * A sign-in on a host driven from this Mac, against a fake host link and a
 * fake relay bind: the order (bind, then open the browser), the paste
 * fallback, and that the relay ends with the flow.
 */
import type { HostSignInUpdate } from "@volli/shared";
import { describe, expect, it, vi } from "vite-plus/test";

import type { RelayBinding, RelayOutcome } from "./relay-client";
import {
  isOpenableSignInUrl,
  MAX_SIGN_IN_URL_LENGTH,
  REFUSED_SIGN_IN_LINK,
  runHostSignIn,
  type HostSignInLink,
  type HostSignInRunEvent,
} from "./sign-in-runner";

function fakeLink(options: { startFails?: boolean } = {}) {
  let observer: Parameters<HostSignInLink["subscribe"]>[1] | null = null;
  const link = {
    start: vi.fn(async () => {
      if (options.startFails === true) throw new Error("sign-in-conflict");
      return { flowId: "flow-1" };
    }),
    subscribe: vi.fn((_flow: { flowId: string }, next: NonNullable<typeof observer>) => {
      observer = next;
      return { unsubscribe: vi.fn() };
    }),
    deliver: vi.fn(async () => ({ status: 200 })),
    answer: vi.fn(async () => null),
    cancel: vi.fn(async () => null),
  } satisfies HostSignInLink;
  return {
    link,
    emit: (update: HostSignInUpdate) => observer!.onData(update),
    error: () => observer!.onError(new Error("host-unreachable")),
    complete: () => observer!.onComplete(),
    subscribed: () => observer !== null,
  };
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
    expect(isOpenableSignInUrl("https://claude.ai/oauth/authorize?code=true")).toBe(true);
    expect(isOpenableSignInUrl("http://localhost:1455/start")).toBe(true);
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
    await run.cancel();
    host.error();
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
    await expect(run.cancel()).resolves.toBeUndefined();
    host.emit({ kind: "done" });
    expect(await run.ended).toBe("done");
  });
});
