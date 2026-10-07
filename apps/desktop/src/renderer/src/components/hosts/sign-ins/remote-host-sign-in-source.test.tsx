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
    const source = remoteHostSignInSource(tier.rpc, () => {});
    const heard: HostSignInRunEvent[] = [];
    const run = source.signInOnHost("h", "xai", (event) => heard.push(event));
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
    expect(tier.calls).toContainEqual(["cancel", { hostId: "h", providerId: "xai" }]);
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
});
