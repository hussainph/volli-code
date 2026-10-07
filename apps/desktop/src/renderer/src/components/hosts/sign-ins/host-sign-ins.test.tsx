// @vitest-environment jsdom
/**
 * A host's sign-in rows (VC-702) against a fake source: what each row
 * offers, the confirm before this Mac's key leaves it, a subscription
 * signing in on the host and turning signed-in by itself, the paste
 * fallback, and the expired badge's shape. No key is read from anywhere.
 */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { HostSignInStatus } from "@volli/shared";
import { describe, expect, it, vi } from "vite-plus/test";

import { fakeHostSignInSource } from "./fake-host-sign-in-source";
import { HostSignInController } from "./host-sign-in-controller";
import {
  expiredSignInsOf,
  IDLE,
  reduceSignIn,
  signInRowsOf,
  statusLine,
  trustLine,
  wantsPaste,
  type RowFlow,
} from "./host-sign-in-model";
import { HostSignInRows, SignInRow, siteOf, useHostSignIns } from "./host-sign-in-rows";

const HOST = "hetzner-1";
const BOTH = [
  { type: "api-key", label: "API key", isSubscription: false },
  { type: "oauth", label: "Claude Pro/Max", isSubscription: true },
] as const;

function status(
  overrides: Partial<Record<string, Partial<HostSignInStatus["providers"][number]>>> = {},
): HostSignInStatus {
  const row = (
    providerId: string,
    label: string,
    methods: HostSignInStatus["providers"][number]["methods"],
  ) => ({
    providerId,
    label,
    state: "missing" as const,
    kind: null,
    methods,
    ...overrides[providerId],
  });
  return {
    providers: [
      row("anthropic", "Claude", BOTH),
      row("xai", "xAI", [{ type: "oauth", label: "SuperGrok", isSubscription: true }]),
      row("openrouter", "OpenRouter", [
        { type: "api-key", label: "API key", isSubscription: false },
      ]),
    ],
    git: [{ host: "github.com", state: "signed-in", kind: "git" }],
  };
}

const settle = async () => {
  for (let index = 0; index < 10; index++) await Promise.resolve();
};

describe("the rows", () => {
  it("default by kind: subscriptions on the host, keys from this Mac when it holds one", () => {
    const rows = signInRowsOf(status(), new Set(["anthropic", "openrouter"]));
    expect(rows.map((row) => [row.key, row.source, row.macHasKey])).toEqual([
      ["provider:anthropic", "host", true],
      ["provider:xai", "host", false],
      ["provider:openrouter", "mac", true],
      ["git:github.com", "host", false],
    ]);
    // A host already holding a key for a subscription provider keeps offering keys.
    const keyed = signInRowsOf(
      status({ anthropic: { state: "signed-in", kind: "api-key" } }),
      new Set(["anthropic"]),
    );
    expect(keyed[0]).toMatchObject({ source: "mac", held: "api-key" });
  });

  it("say what each row holds and what is happening, in the host's own name", () => {
    const [claude, , openrouter, git] = signInRowsOf(
      status({
        anthropic: { state: "expired", kind: "subscription" },
        openrouter: { state: "signed-in", kind: "api-key" },
      }),
      new Set(),
    );
    expect(statusLine(claude!, IDLE, HOST)).toBe("Expired on hetzner-1");
    expect(statusLine(openrouter!, IDLE, HOST)).toBe("Signed in on hetzner-1 · API key");
    expect(statusLine(git!, IDLE, HOST)).toBe("Signed in on hetzner-1 · push access");
    const subscribed = signInRowsOf(
      status({ xai: { state: "signed-in", kind: "subscription" } }),
      new Set(),
    )[1]!;
    expect(statusLine(subscribed, IDLE, HOST)).toBe("Signed in on hetzner-1 · subscription");
    const ambient = signInRowsOf(
      status({ xai: { state: "signed-in", kind: null } }),
      new Set(),
    )[1]!;
    expect(statusLine(ambient, IDLE, HOST)).toBe("Signed in on hetzner-1");
    const anyRow = signInRowsOf(status(), new Set())[1]!;
    expect(statusLine(anyRow, IDLE, HOST)).toBe("Not signed in");
    const lines: [RowFlow, string][] = [
      [{ kind: "confirm-send" }, "Sending from this Mac"],
      [{ kind: "sending" }, "Sending from this Mac"],
      [{ kind: "key-entry" }, "Stored only on hetzner-1"],
      [{ kind: "saving" }, "Saving on hetzner-1"],
      [{ kind: "failed", message: "Nope" }, "Nope"],
      [reduceSignIn(IDLE, { kind: "progress", message: "Starting" }), "Starting"],
      [
        reduceSignIn(IDLE, {
          kind: "device-code",
          userCode: "A",
          verificationUri: "https://x.test",
          intervalSeconds: null,
          expiresInSeconds: null,
        }),
        "Enter the code on the provider's page",
      ],
      [
        reduceSignIn(IDLE, { kind: "auth-url", url: "https://claude.ai", instructions: null }),
        "Waiting for your browser",
      ],
      [
        reduceSignIn(IDLE, { kind: "relay", state: "paste" }),
        "Paste the address your browser ends on",
      ],
      [reduceSignIn(IDLE, { kind: "relay", state: "listening" }), "Signing in on hetzner-1"],
    ];
    for (const [flow, line] of lines) expect(statusLine(anyRow, flow, HOST)).toBe(line);
  });

  it("fold a flow's events, and end it on done, cancel, failure or a lost host", () => {
    const prompt = {
      promptId: "p",
      kind: "manual-code" as const,
      message: "Paste",
      placeholder: null,
      options: [],
    };
    let flow = reduceSignIn(IDLE, { kind: "prompt", prompt });
    expect(wantsPaste(flow)).toBe(true);
    flow = reduceSignIn(flow, { kind: "prompt-withdrawn", promptId: "other" });
    expect(wantsPaste(flow)).toBe(true);
    flow = reduceSignIn(flow, { kind: "prompt-withdrawn", promptId: "p" });
    expect(wantsPaste(flow)).toBe(false);
    expect(reduceSignIn(flow, { kind: "info", message: "Opening", links: [] })).toMatchObject({
      progress: "Opening",
    });
    expect(reduceSignIn(flow, { kind: "done" })).toBe(IDLE);
    expect(reduceSignIn(flow, { kind: "cancelled" })).toBe(IDLE);
    expect(reduceSignIn(flow, { kind: "failed", message: "invalid_grant\nstack" })).toEqual({
      kind: "failed",
      message: "invalid_grant",
    });
    expect(reduceSignIn(flow, { kind: "failed", message: "  " })).toEqual({
      kind: "failed",
      message: "The sign-in did not finish",
    });
    expect(reduceSignIn(flow, { kind: "lost" })).toEqual({
      kind: "failed",
      message: "The host went away before the sign-in finished",
    });
    expect(wantsPaste(IDLE)).toBe(false);
  });

  it("give the host chip's badge VC-576's HostSignIn shape", () => {
    expect(
      expiredSignInsOf(status({ anthropic: { state: "expired", kind: "subscription" } })),
    ).toEqual([{ providerId: "anthropic", name: "Claude" }]);
  });

  it("carry exactly one sentence: the trust boundary that is true", () => {
    expect(trustLine(HOST, true)).toBe("hetzner-1 keeps a copy of what this Mac sends.");
    expect(trustLine(HOST, false)).toBe("Nothing is copied from this Mac.");
    expect(siteOf("https://accounts.x.ai/device")).toBe("accounts.x.ai");
    expect(siteOf("not a url")).toBe("the provider’s page");
  });
});

describe("HostSignInController", () => {
  it("reads the host and this Mac's keys, and says when the host cannot be read", async () => {
    const source = fakeHostSignInSource({ status: status(), macKeys: ["openrouter"] });
    const controller = new HostSignInController(source, "host-1");
    let heard = 0;
    const stop = controller.subscribe(() => (heard += 1));
    expect(controller.getSnapshot().rows).toBeNull();
    await controller.refresh();
    expect(controller.getSnapshot().rows?.find((row) => row.id === "openrouter")?.macHasKey).toBe(
      true,
    );
    source.failNextStatus();
    await controller.refresh();
    expect(controller.getSnapshot()).toMatchObject({ unreachable: true });
    expect(controller.getSnapshot().rows).not.toBeNull();
    expect(heard).toBe(2);
    stop();
  });

  it("sends this Mac's key only after the confirm, and says why when it cannot", async () => {
    const signedIn = status({ openrouter: { state: "signed-in", kind: "api-key" } });
    const source = fakeHostSignInSource({
      status: status(),
      macKeys: ["openrouter"],
      send: { ok: true, status: signedIn },
    });
    const controller = new HostSignInController(source, "host-1");
    await controller.refresh();
    await controller.confirmSend("openrouter");
    expect(source.calls).not.toContain("send host-1 openrouter");
    controller.requestSend("openrouter");
    expect(controller.getSnapshot().flows["provider:openrouter"]).toEqual({ kind: "confirm-send" });
    await controller.confirmSend("openrouter");
    expect(source.calls).toContain("send host-1 openrouter");
    expect(controller.getSnapshot().flows["provider:openrouter"]).toBe(IDLE);
    expect(controller.getSnapshot().rows?.find((row) => row.id === "openrouter")?.state).toBe(
      "signed-in",
    );

    for (const [reason, line] of [
      ["no-key", "This Mac has no key for it to send"],
      ["subscription", "A subscription signs in on the host, not from this Mac"],
      ["send-failed", "The key did not reach the host"],
    ] as const) {
      const refused = new HostSignInController(
        fakeHostSignInSource({ status: status(), send: { ok: false, reason } }),
        "host-1",
      );
      refused.requestSend("anthropic");
      await refused.confirmSend("anthropic");
      expect(refused.getSnapshot().flows["provider:anthropic"]).toEqual({
        kind: "failed",
        message: line,
      });
    }
    const throwing = fakeHostSignInSource({ status: status() });
    throwing.sendFromThisMac = async () => {
      throw new Error("ipc");
    };
    const failing = new HostSignInController(throwing, "host-1");
    failing.requestSend("openrouter");
    await failing.confirmSend("openrouter");
    expect(failing.getSnapshot().flows["provider:openrouter"]).toEqual({
      kind: "failed",
      message: "The key did not reach the host",
    });
  });

  it("stores a pasted key or push token on the host, passing the value straight through", async () => {
    const source = fakeHostSignInSource({ status: status() });
    const controller = new HostSignInController(source, "host-1");
    await controller.refresh();
    const [, , openrouter, git] = controller.getSnapshot().rows!;
    controller.beginKeyEntry(openrouter!.key);
    expect(controller.getSnapshot().flows[openrouter!.key]).toEqual({ kind: "key-entry" });
    await controller.submitKey(openrouter!, "");
    await controller.submitKey(openrouter!, "sk-or-pasted");
    await controller.submitKey(git!, "ghp_pasted");
    expect(source.calls.filter((call) => call.startsWith("set"))).toEqual([
      "setApiKey host-1 openrouter (12)",
      "setGitCredential host-1 github.com (10)",
    ]);
    source.setApiKey = async () => {
      throw new Error("host-unreachable");
    };
    await controller.submitKey(openrouter!, "sk-or-again");
    expect(controller.getSnapshot().flows[openrouter!.key]).toEqual({
      kind: "failed",
      message: "OpenRouter was not saved on the host",
    });
  });

  it("adds normalized git hosts for this controller only, opening listed hosts without duplicates", async () => {
    const source = fakeHostSignInSource({ status: { providers: [], git: [] } });
    const controller = new HostSignInController(source, "host-1");
    await controller.refresh();
    const before = controller.getSnapshot();
    for (const value of [
      "",
      "   ",
      "https://github.com",
      "user@github.com",
      "github.com/owner/repo",
      "*.github.com",
      "-github.com",
      "github..com",
      "github.com:123456",
      `${"a".repeat(250)}.com`,
    ]) {
      expect(controller.addGitHost(value)).toBe(false);
      expect(controller.getSnapshot()).toBe(before);
    }
    expect(controller.addGitHost(" GitHub.com ")).toBe(true);
    expect(controller.getSnapshot().rows).toHaveLength(1);
    expect(controller.getSnapshot().flows["git:github.com"]).toEqual({ kind: "key-entry" });
    expect(controller.addGitHost(" Git.Example.com:8443 ")).toBe(true);
    const row = controller
      .getSnapshot()
      .rows!.find((candidate) => candidate.id === "git.example.com:8443")!;
    expect(row).toMatchObject({ state: "missing", held: null });
    expect(controller.getSnapshot().flows[row.key]).toEqual({ kind: "key-entry" });
    controller.cancel(row.key);
    await controller.refresh();
    expect(controller.getSnapshot().rows).toHaveLength(2);
    expect(controller.addGitHost(row.id)).toBe(true);
    expect(controller.getSnapshot().rows).toHaveLength(2);
    expect(controller.getSnapshot().flows[row.key]).toEqual({ kind: "key-entry" });
    expect(source.calls.filter((call) => call.startsWith("set"))).toEqual([]);
    const another = new HostSignInController(source, "host-1");
    await another.refresh();
    expect(another.getSnapshot().rows!.map((candidate) => candidate.id)).toEqual(["github.com"]);
  });

  it("takes the first GitHub token and a new host's token through the existing save path", async () => {
    const source = fakeHostSignInSource({ status: { providers: [], git: [] } });
    let saved: HostSignInStatus = { providers: [], git: [] };
    const credentials: { host: string; username: string; password: string }[] = [];
    source.setGitCredential = async (_hostId, credential) => {
      credentials.push(credential);
      saved = {
        ...saved,
        git: [...saved.git, { host: credential.host, state: "signed-in", kind: "git" }],
      };
      source.setStatus(saved);
      return saved;
    };
    const controller = new HostSignInController(source, "host-1");
    await controller.refresh();
    controller.beginKeyEntry("git:github.com");
    await controller.submitKey(controller.getSnapshot().rows![0]!, "first-token");
    controller.addGitHost("gitlab.com");
    await controller.submitKey(controller.getSnapshot().rows![1]!, "second-token");
    expect(credentials).toEqual([
      { host: "github.com", username: "x-access-token", password: "first-token" },
      { host: "gitlab.com", username: "x-access-token", password: "second-token" },
    ]);
    await controller.refresh();
    expect(controller.getSnapshot().rows!.map((row) => [row.id, row.state, row.held])).toEqual([
      ["github.com", "signed-in", "git"],
      ["gitlab.com", "signed-in", "git"],
    ]);
    expect(controller.getSnapshot().flows["git:gitlab.com"]).toBe(IDLE);
    expect(controller.addGitHost(" GitLab.com ")).toBe(true);
    expect(controller.getSnapshot().rows).toHaveLength(2);
    expect(controller.getSnapshot().flows["git:gitlab.com"]).toEqual({ kind: "key-entry" });
  });

  it("signs a subscription in on the host, takes a pasted redirect, and turns signed-in by itself", async () => {
    const source = fakeHostSignInSource({ status: status() });
    const controller = new HostSignInController(source, "host-1");
    await controller.refresh();
    controller.beginSignIn("anthropic");
    controller.beginSignIn("anthropic");
    expect(source.calls.filter((call) => call.startsWith("signIn"))).toEqual([
      "signIn host-1 anthropic",
    ]);
    const host = source.running.get("anthropic")!;
    host({ kind: "relay", state: "paste" });
    host({
      kind: "prompt",
      prompt: {
        promptId: "p1",
        kind: "manual-code",
        message: "Paste",
        placeholder: null,
        options: [],
      },
    });
    const flow = controller.getSnapshot().flows["provider:anthropic"];
    expect(flow).toMatchObject({ kind: "signing-in", relay: "paste", prompt: { promptId: "p1" } });
    await controller.answer("anthropic", "http://localhost:53692/callback?code=c&state=s");
    expect(source.answers).toEqual([{ providerId: "anthropic", promptId: "p1", length: 46 }]);
    // Nothing to answer once the step is taken.
    await controller.answer("anthropic", "again");
    expect(source.answers).toHaveLength(1);
    source.setStatus(status({ anthropic: { state: "signed-in", kind: "subscription" } }));
    host({ kind: "done" });
    await settle();
    expect(controller.getSnapshot().flows["provider:anthropic"]).toBe(IDLE);
    expect(controller.getSnapshot().rows?.[0]?.state).toBe("signed-in");
  });

  it("shows a device code, opens its page, cancels on the host, and cancels everything when disposed", async () => {
    const source = fakeHostSignInSource({ status: status() });
    const controller = new HostSignInController(source, "host-1");
    await controller.refresh();
    controller.beginSignIn("xai");
    source.running.get("xai")!({
      kind: "device-code",
      userCode: "WXYZ-1234",
      verificationUri: "https://accounts.x.ai/device",
      intervalSeconds: 5,
      expiresInSeconds: 900,
    });
    expect(controller.getSnapshot().flows["provider:xai"]).toMatchObject({
      deviceCode: { userCode: "WXYZ-1234" },
    });
    controller.openPage("https://accounts.x.ai/device");
    controller.cancel("provider:xai");
    expect(source.calls).toEqual(
      expect.arrayContaining(["open https://accounts.x.ai/device", "cancel xai"]),
    );
    expect(controller.getSnapshot().flows["provider:xai"]).toBe(IDLE);
    controller.beginSignIn("anthropic");
    controller.dispose();
    expect(source.calls).toContain("cancel anthropic");
  });

  it("lets a row start again after its sign-in failed or the host went away", async () => {
    const source = fakeHostSignInSource({ status: status() });
    const controller = new HostSignInController(source, "host-1");
    controller.beginSignIn("xai");
    source.running.get("xai")!({ kind: "failed", message: "denied" });
    controller.beginSignIn("xai");
    source.running.get("xai")!({ kind: "lost" });
    controller.beginSignIn("xai");
    expect(source.calls.filter((call) => call.startsWith("signIn"))).toHaveLength(3);
    // Cancelling a pasted key's field touches no host.
    controller.beginKeyEntry("provider:openrouter");
    controller.cancel("provider:openrouter");
    expect(controller.getSnapshot().flows["provider:openrouter"]).toBe(IDLE);
    expect(source.calls.filter((call) => call.startsWith("cancel"))).toEqual([]);
  });

  it("says the host did not take an answer", async () => {
    const source = fakeHostSignInSource({ status: status() });
    const original = source.signInOnHost;
    source.signInOnHost = (hostId, providerId, onEvent) => ({
      ...original(hostId, providerId, onEvent),
      answer: async () => {
        throw new Error("sign-in-conflict");
      },
    });
    const controller = new HostSignInController(source, "host-1");
    controller.beginSignIn("anthropic");
    source.running.get("anthropic")!({
      kind: "prompt",
      prompt: {
        promptId: "p",
        kind: "manual-code",
        message: "Paste",
        placeholder: null,
        options: [],
      },
    });
    await controller.answer("anthropic", "x");
    expect(controller.getSnapshot().flows["provider:anthropic"]).toEqual({
      kind: "failed",
      message: "The host did not take that answer",
    });
  });
});

describe("the rows on screen", () => {
  it("adds a host only after validation, then saves its token in the row", async () => {
    const source = fakeHostSignInSource({ status: { providers: [], git: [] } });
    const setGitCredential = source.setGitCredential;
    source.setGitCredential = async (hostId, credential) => {
      await setGitCredential(hostId, credential);
      const saved: HostSignInStatus = {
        providers: [],
        git: [{ host: credential.host, state: "signed-in", kind: "git" }],
      };
      source.setStatus(saved);
      return saved;
    };
    const controller = new HostSignInController(source, "host-1");
    function Rows() {
      const snapshot = useHostSignIns(controller);
      return <HostSignInRows hostName={HOST} snapshot={snapshot} controller={controller} />;
    }
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const input = (label: string) =>
      container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
    const click = async (name: string) => {
      const button = [...container.querySelectorAll("button")].find(
        (candidate) => candidate.textContent?.trim() === name,
      )!;
      await act(async () => button.click());
    };
    const type = async (label: string, value: string) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      await act(async () => {
        setter.call(input(label), value);
        input(label).dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    try {
      await act(async () => root.render(<Rows />));
      expect(container.querySelector('[data-row="git:github.com"]')?.textContent).toContain(
        "Not signed in",
      );
      expect(input("Git host")).toBeNull();
      await click("Add a git host…");
      expect(container.querySelectorAll("input")).toHaveLength(1);
      expect(input("Git host").type).toBe("text");
      await type("Git host", "https://gitlab.com");
      await click("Add");
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        "Enter a host name with an optional port.",
      );
      expect(input("Git host").getAttribute("aria-invalid")).toBe("true");
      expect(container.querySelectorAll("[data-row]")).toHaveLength(1);
      expect(source.calls.filter((call) => call.startsWith("set"))).toEqual([]);
      await type("Git host", " Git.Example.com:8443 ");
      expect(container.querySelector('[role="alert"]')).toBeNull();
      await click("Add");
      expect(input("Git host")).toBeNull();
      const tokenLabel = "Push token for git.example.com:8443, stored on hetzner-1";
      expect(input(tokenLabel).type).toBe("password");
      await type(tokenLabel, "pasted-token");
      await click("Save");
      expect(source.calls).toContain("setGitCredential host-1 git.example.com:8443 (12)");
      expect(container.querySelectorAll('[data-row="git:git.example.com:8443"]')).toHaveLength(1);
      expect(
        container.querySelector('[data-row="git:git.example.com:8443"]')?.textContent,
      ).toContain("Signed in on hetzner-1 · push access");
      await click("Add a git host…");
      await type("Git host", "git.example.com:8443");
      await click("Add");
      expect(controller.getSnapshot().flows["git:git.example.com:8443"]).toEqual({
        kind: "key-entry",
      });
      expect(container.querySelectorAll('[data-row="git:git.example.com:8443"]')).toHaveLength(1);
      await click("Add a git host…");
      await type("Git host", "discard.example.com");
      const form = input("Git host").closest("form")!;
      await act(async () =>
        [...form.querySelectorAll("button")]
          .find((button) => button.textContent === "Cancel")!
          .click(),
      );
      expect(input("Git host")).toBeNull();
      expect(container.querySelector('[data-row="git:discard.example.com"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      controller.dispose();
      container.remove();
      vi.unstubAllGlobals();
    }
  });

  const controller = new HostSignInController(fakeHostSignInSource({ status: status() }), "host-1");

  it("offers each row its own act, and carries the trust line", () => {
    const html = renderToStaticMarkup(
      <HostSignInRows
        hostName={HOST}
        controller={controller}
        snapshot={{
          rows: signInRowsOf(
            status({ anthropic: { state: "expired", kind: "subscription" } }),
            new Set(["anthropic", "openrouter"]),
          ),
          flows: {},
          unreachable: false,
        }}
      />,
    );
    expect(html).toContain("Sign in again");
    expect(html).toContain("Send from this Mac");
    expect(html).toContain("This Mac");
    expect(html).toContain("hetzner-1 keeps a copy of what this Mac sends.");
    expect(html).toContain("Expired on hetzner-1");
  });

  it("says when the host cannot be read before it ever answered", () => {
    expect(
      renderToStaticMarkup(
        <HostSignInRows
          hostName={HOST}
          controller={controller}
          snapshot={{ rows: null, flows: {}, unreachable: true }}
        />,
      ),
    ).toContain("hetzner-1 cannot be reached right now");
  });

  it("draws a device code, the paste field and a key field beneath their rows", () => {
    const [, xai, openrouter] = signInRowsOf(status(), new Set());
    const code = reduceSignIn(IDLE, {
      kind: "device-code",
      userCode: "WXYZ-1234",
      verificationUri: "https://accounts.x.ai/device",
      intervalSeconds: null,
      expiresInSeconds: null,
    });
    const paste = reduceSignIn(reduceSignIn(IDLE, { kind: "relay", state: "paste" }), {
      kind: "prompt",
      prompt: {
        promptId: "p",
        kind: "manual-code",
        message: "Paste the redirect",
        placeholder: null,
        options: [],
      },
    });
    const render = (flow: RowFlow, row = xai!) =>
      renderToStaticMarkup(
        <SignInRow
          row={row}
          flow={flow}
          hostName={HOST}
          source="host"
          onSource={() => {}}
          controller={controller}
        />,
      );
    expect(render(code)).toContain("WXYZ-1234");
    expect(render(code)).toContain("Open accounts.x.ai");
    expect(render(paste)).toContain("Paste the redirect");
    expect(render({ kind: "key-entry" }, openrouter)).toContain(
      "OpenRouter API key, stored on hetzner-1",
    );
    expect(render({ kind: "failed", message: "Nope" })).toContain("Dismiss");
  });
});
