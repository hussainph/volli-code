// @vitest-environment jsdom
/**
 * The sign-in rows' real source over a fake `hostSignIns.*` tier (VC-702 PR 2),
 * and the sheet that frames the rows for one host. Nothing secret comes back
 * through the tier; "Send from this Mac" names only the provider.
 */
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { HostSignInRunEvent } from "@volli/shared";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { fakeHostSignInSource } from "./fake-host-sign-in-source";
import { HostSignInController } from "./host-sign-in-controller";
import { HostSignInSheet } from "./host-sign-in-sheet";
import {
  remoteHostSignInSource,
  useHostSignInSheet,
  type HostSignInsRpc,
} from "./remote-host-sign-in-source";

const STATUS = {
  providers: [
    {
      providerId: "xai",
      label: "xAI",
      state: "missing" as const,
      kind: null,
      methods: [{ type: "oauth" as const, label: "SuperGrok", isSubscription: true }],
    },
  ],
  git: [],
};

/** A pasted-code step, as the host asks it. */
const prompt = (promptId: string) => ({
  kind: "prompt" as const,
  prompt: {
    promptId,
    kind: "manual-code" as const,
    message: "Paste",
    placeholder: null,
    options: [],
  },
});

function fakeTier() {
  const calls: [string, unknown][] = [];
  let handlers: {
    onData(event: HostSignInRunEvent): void;
    onError(error: unknown): void;
    onComplete(): void;
  } | null = null;
  const unsubscribed = vi.fn();
  let refuseCancel = false;
  const call =
    (name: string, answer: unknown = STATUS) =>
    async (input?: unknown) => {
      calls.push([name, input]);
      if (name === "cancel" && refuseCancel) throw new Error("gone");
      return answer;
    };
  const rpc = {
    hostSignIns: {
      status: { query: call("status") },
      macKeys: { query: call("macKeys", ["openrouter"]) },
      sendFromThisMac: { mutate: call("sendFromThisMac", { ok: true, status: STATUS }) },
      setApiKey: { mutate: call("setApiKey") },
      setGitCredential: { mutate: call("setGitCredential") },
      run: {
        subscribe: (input: unknown, next: NonNullable<typeof handlers>) => {
          calls.push(["run", input]);
          handlers = next;
          return { unsubscribe: unsubscribed };
        },
      },
      answer: { mutate: call("answer", null) },
      cancel: { mutate: call("cancel", null) },
    },
  } as unknown as HostSignInsRpc;
  return {
    rpc,
    calls,
    unsubscribed,
    handlers: () => handlers!,
    refuseCancel: () => {
      refuseCancel = true;
    },
  };
}

describe("remoteHostSignInSource", () => {
  it("asks the tier for each read and write, with the confirm on a send", async () => {
    const tier = fakeTier();
    const opened: string[] = [];
    const source = remoteHostSignInSource(tier.rpc, (url) => opened.push(url));
    await source.status("h");
    expect(await source.macKeys()).toEqual(["openrouter"]);
    await source.sendFromThisMac("h", "openrouter");
    await source.setApiKey("h", "openrouter", "k");
    await source.setGitCredential("h", { host: "github.com", username: "u", password: "t" });
    source.openExternal("https://example.com/device");
    expect(tier.calls).toEqual([
      ["status", { hostId: "h" }],
      ["macKeys", undefined],
      ["sendFromThisMac", { hostId: "h", providerId: "openrouter", confirmed: true }],
      ["setApiKey", { hostId: "h", providerId: "openrouter", key: "k" }],
      ["setGitCredential", { hostId: "h", host: "github.com", username: "u", password: "t" }],
    ]);
    expect(opened).toEqual(["https://example.com/device"]);
  });

  it("follows a run to its end once, and reads a broken stream as lost", async () => {
    const tier = fakeTier();
    let runs = 0;
    const source = remoteHostSignInSource(
      tier.rpc,
      () => {},
      () => `run-${++runs}`,
    );
    const heard: HostSignInRunEvent[] = [];
    const run = source.signInOnHost("h", "xai", (event) => heard.push(event));
    expect(tier.calls).toContainEqual(["run", { hostId: "h", providerId: "xai", runId: "run-1" }]);
    tier.handlers().onData({ kind: "progress", message: "Waiting" });
    await run.answer("prompt-1", "https://localhost/cb?code=c");
    tier.handlers().onData({ kind: "done" });
    tier.handlers().onData({ kind: "progress", message: "late" });
    tier.handlers().onComplete();
    expect(heard).toEqual([{ kind: "progress", message: "Waiting" }, { kind: "done" }]);
    expect(tier.calls).toContainEqual([
      "answer",
      {
        hostId: "h",
        providerId: "xai",
        promptId: "prompt-1",
        value: "https://localhost/cb?code=c",
        runId: "run-1",
      },
    ]);

    const lost: HostSignInRunEvent[] = [];
    source.signInOnHost("h", "xai", (event) => lost.push(event));
    tier.handlers().onError(new Error("main went away"));
    tier.handlers().onComplete();
    expect(lost).toEqual([{ kind: "lost" }]);

    const quiet: HostSignInRunEvent[] = [];
    source.signInOnHost("h", "xai", (event) => quiet.push(event));
    tier.handlers().onComplete();
    expect(quiet).toEqual([{ kind: "lost" }]);
  });

  it("cancels quietly: the stream ends, the host is told, and nothing more is said", async () => {
    const tier = fakeTier();
    const source = remoteHostSignInSource(tier.rpc, () => {});
    const heard: HostSignInRunEvent[] = [];
    const run = source.signInOnHost("h", "xai", (event) => heard.push(event));
    tier.refuseCancel();
    await run.cancel();
    tier.handlers().onData({ kind: "cancelled" });
    expect(tier.unsubscribed).toHaveBeenCalledOnce();
    // The cancel names this run: main lets it reach no newer one.
    const [, input] = tier.calls.find(([name]) => name === "run")! as [string, { runId: string }];
    expect(input.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(tier.calls).toContainEqual([
      "cancel",
      { hostId: "h", providerId: "xai", runId: input.runId },
    ]);
    expect(heard).toEqual([]);
  });
});

describe("the host sign-in sheet", () => {
  afterEach(() => {
    act(() => useHostSignInSheet.getState().close());
  });

  it("shows one host's rows, starts a recovery's sign-in, and cancels it on close", async () => {
    const source = fakeHostSignInSource({ status: STATUS });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<HostSignInSheet source={source} />));
    expect(document.body.textContent).not.toContain("Sign-ins on");
    await act(async () =>
      useHostSignInSheet.getState().open({ hostId: "h", hostName: "Hetzner", providerId: "xai" }),
    );
    expect(document.body.textContent).toContain("Sign-ins on Hetzner");
    expect(document.body.textContent).toContain("xAI");
    expect(source.calls).toContain("signIn h xai");
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(useHostSignInSheet.getState().target).toBeNull();
    expect(source.calls).toContain("cancel xai");
    await act(async () =>
      useHostSignInSheet.getState().open({ hostId: "h", hostName: "Hetzner", providerId: null }),
    );
    expect(source.calls.filter((call) => call === "signIn h xai")).toHaveLength(1);
    await act(async () => root.unmount());
    container.remove();
  });
});

describe("a replaced or cancelled run", () => {
  it("has no say over the row once the surface moved on", async () => {
    const source = fakeHostSignInSource({ status: STATUS });
    const controller = new HostSignInController(source, "h");
    await controller.refresh();
    controller.beginSignIn("xai");
    const first = source.running.get("xai")!;
    controller.cancel("provider:xai");
    controller.beginSignIn("xai");
    first({ kind: "failed", message: "old news" });
    expect(controller.getSnapshot().flows["provider:xai"]?.kind).toBe("signing-in");
  });

  it("an old answer failing late leaves the newer run's row alone (VC-702 review B5)", async () => {
    const source = fakeHostSignInSource({ status: STATUS });
    const held = Promise.withResolvers<unknown>();
    const signInOnHost = source.signInOnHost;
    let started = 0;
    source.signInOnHost = (hostId, providerId, onEvent) => {
      const handle = signInOnHost(hostId, providerId, onEvent);
      started += 1;
      return started === 1 ? { ...handle, answer: () => held.promise } : handle;
    };
    const controller = new HostSignInController(source, "h");
    await controller.refresh();
    controller.beginSignIn("xai");
    source.running.get("xai")!(prompt("old"));
    const answering = controller.answer("xai", "http://localhost:1/cb?code=old");
    controller.cancel("provider:xai");
    controller.beginSignIn("xai");
    source.running.get("xai")!(prompt("new"));
    source.running.get("xai")!({ kind: "progress", message: "new run" });
    const before = controller.getSnapshot().flows["provider:xai"];
    held.reject(new Error("sign-in-conflict"));
    await answering;
    expect(controller.getSnapshot().flows["provider:xai"]).toBe(before);
    expect(before).toMatchObject({ kind: "signing-in", progress: "new run" });
  });

  it("a send or a save that answers after the row moved on, or the surface went, changes nothing", async () => {
    const source = fakeHostSignInSource({ status: STATUS });
    const sent = Promise.withResolvers<{ ok: false; reason: "send-failed" }>();
    const saved = Promise.withResolvers<typeof STATUS>();
    const controller = new HostSignInController(
      {
        ...source,
        sendFromThisMac: () => sent.promise,
        setApiKey: () => saved.promise,
      },
      "h",
    );
    await controller.refresh();
    controller.requestSend("openrouter");
    const sending = controller.confirmSend("openrouter");
    controller.cancel("provider:openrouter");
    controller.beginKeyEntry("provider:anthropic");
    const saving = controller.submitKey(
      { key: "provider:anthropic", kind: "provider", id: "anthropic", label: "Claude" } as never,
      "sk-pasted",
    );
    controller.cancel("provider:anthropic");
    sent.resolve({ ok: false, reason: "send-failed" });
    saved.reject(new Error("refused"));
    await Promise.all([sending, saving]);
    expect(controller.getSnapshot().flows).toEqual({
      "provider:openrouter": { kind: "idle" },
      "provider:anthropic": { kind: "idle" },
    });

    // A save the host took, after the person moved on: the row stays as they left it.
    const git = Promise.withResolvers<typeof STATUS>();
    const pushing = new HostSignInController(
      { ...source, setGitCredential: () => git.promise },
      "h",
    );
    const saving2 = pushing.submitKey(
      { key: "git:github.com", kind: "git", id: "github.com", label: "GitHub" } as never,
      "ghp_token",
    );
    pushing.cancel("git:github.com");
    git.resolve(STATUS);
    await saving2;
    expect(pushing.getSnapshot().flows).toEqual({ "git:github.com": { kind: "idle" } });

    // Gone: a read that answers after the surface was disposed is not published.
    for (const answer of ["resolve", "reject"] as const) {
      const read = Promise.withResolvers<typeof STATUS>();
      const reading = new HostSignInController({ ...source, status: () => read.promise }, "h");
      const heard = vi.fn();
      reading.subscribe(heard);
      const refreshing = reading.refresh();
      reading.dispose();
      reading.subscribe(heard);
      if (answer === "resolve") read.resolve(STATUS);
      else read.reject(new Error("host-unreachable"));
      await refreshing;
      expect(heard).not.toHaveBeenCalled();
      expect(reading.getSnapshot()).toEqual({ rows: null, flows: {}, unreachable: false });
    }
  });
});
