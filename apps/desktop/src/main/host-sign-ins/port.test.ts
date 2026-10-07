// @vitest-environment node
/**
 * The remote sign-in wiring (VC-702 PR 2) against a fake client link and a
 * fake service: the host's operations by path, answers checked against the
 * published schemas, the engine's link lookup, and one running sign-in per
 * host and provider, cancelled when its stream ends.
 */
import type { HostLink, HostLinkSubscriptionHandlers } from "@volli/host-protocol/client-link";
import type { HostSignInRunEvent } from "@volli/shared";
import { describe, expect, it, vi } from "vite-plus/test";

import { engineSignInLinks, hostLinkSignIns, remoteSignInsPort, signInPreflight } from "./port";
import type { HostSignInService } from "./service";
import { REFUSED_SIGN_IN_LINK, type HostSignInRun } from "./sign-in-runner";

const STATUS = { providers: [], git: [{ host: "github.com", state: "signed-in", kind: "git" }] };

function fakeLink(answers: Record<string, unknown>) {
  const calls: [string, string, unknown][] = [];
  let handlers: HostLinkSubscriptionHandlers | null = null;
  const link = {
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
  return { link, calls, handlers: () => handlers! };
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
    const bad = hostLinkSignIns(
      fakeLink({
        "signIns.status": { providers: "nope" },
        "signIns.start": {},
        "auth.callback.deliver": {},
      }).link,
    );
    await expect(bad.status()).rejects.toThrow();
    await expect(bad.start({ providerId: "xai" })).rejects.toThrow("started no sign-in");
    await expect(bad.deliver({ flowId: "f", pathAndQuery: "/cb" })).rejects.toThrow("did not say");
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
        cancel: vi.fn(async () => ended.resolve("cancelled")),
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
    const stop = await port.run("h", "xai", (event) => void heard.push(event));
    runs[0]!.onEvent({ kind: "progress", message: "Waiting" });
    expect(heard).toEqual([{ kind: "progress", message: "Waiting" }]);
    await port.answer("h", "xai", "p", "");
    expect(runs[0]!.run.answer).toHaveBeenCalledWith("p", "");
    // A second for the same provider replaces the first.
    const stopSecond = await port.run("h", "xai", () => {});
    expect(runs[0]!.run.cancel).toHaveBeenCalled();
    stop();
    expect(runs[1]!.run.cancel).not.toHaveBeenCalled();
    await port.cancel("h", "xai");
    expect(runs[1]!.run.cancel).toHaveBeenCalledOnce();
    await runs[1]!.run.ended;
    await Promise.resolve();
    await expect(port.answer("h", "xai", "p", "x")).rejects.toThrow("no longer running");
    stopSecond();
    await port.cancel("h", "none");
    // A stream that ends while its sign-in runs cancels it.
    const stopThird = await port.run("h", "anthropic", () => {});
    stopThird();
    expect(runs[2]!.run.cancel).toHaveBeenCalledOnce();
  });
});
