// @vitest-environment jsdom
/**
 * Settings → Account (VC-884) over a stand-in for main's `account.*` tier:
 * what each account state draws, and which command each control sends.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { AccountGithubSnapshot, AccountSnapshot } from "@volli/shared";

import { LOCAL_LAUNCH, PREVIEW_ENROLLMENT_AGREEMENT_VERSION } from "@volli/shared";

import { useExperimentsStore } from "@renderer/stores/experiments";
import { adoptLaunch } from "@renderer/stores/launch";
import { AccountPane } from "./account-pane";
import type { AccountRpc } from "./use-account";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The toast itself is callable (the restart offer); its methods stay sonner's.
vi.mock("sonner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("sonner")>();
  return { ...actual, toast: Object.assign(vi.fn(), actual.toast) };
});

const SIGNED_OUT: AccountSnapshot = {
  state: "signed-out",
  provider: "dev",
  signingInWith: null,
  account: null,
  failure: null,
};

const SIGNED_IN: AccountSnapshot = {
  state: "signed-in",
  provider: "dev",
  signingInWith: null,
  account: {
    displayName: "Dana",
    email: "dana@example.com",
    userId: "6b4c3a1e-2a9f-4c3e-9d1b-0f8e7d6c5b4a",
    deletionPurgeAfter: null,
    backend: "synced",
  },
  failure: null,
};

const GITHUB_NONE: AccountGithubSnapshot = {
  state: "ready",
  connection: null,
  installations: null,
  waiting: null,
  requested: false,
  failure: null,
};

const GITHUB_ACTIVE: AccountGithubSnapshot = {
  ...GITHUB_NONE,
  connection: { status: "active", login: "dana", name: "Dana Doe" },
  installations: [
    {
      installationId: "42",
      accountLogin: "acme",
      accountType: "org",
      repositorySelection: "selected",
      suspended: false,
      configureUrl: "https://github.com/organizations/acme/settings/installations/42",
    },
    {
      installationId: "43",
      accountLogin: "dana",
      accountType: "user",
      repositorySelection: "all",
      suspended: false,
      configureUrl: "https://github.com/settings/installations/43",
    },
  ],
};

function standIn() {
  let handlers: { onData(data: AccountSnapshot): void; onError(error: unknown): void } | null =
    null;
  let github: {
    onData(data: AccountGithubSnapshot): void;
    onError(error: unknown): void;
  } | null = null;
  const unsubscribe = vi.fn();
  const githubUnsubscribe = vi.fn();
  const rpc = {
    account: {
      subscribe: {
        subscribe: vi.fn((_input: undefined, next: NonNullable<typeof handlers>) => {
          handlers = next;
          return { unsubscribe };
        }),
      },
      signIn: { mutate: vi.fn(async () => null) },
      cancelSignIn: { mutate: vi.fn(async () => null) },
      signOut: { mutate: vi.fn(async () => null) },
      requestDeletion: { mutate: vi.fn(async () => null) },
      cancelDeletion: { mutate: vi.fn(async () => null) },
      githubSubscribe: {
        subscribe: vi.fn((_input: undefined, next: NonNullable<typeof github>) => {
          github = next;
          return { unsubscribe: githubUnsubscribe };
        }),
      },
      githubConnect: { mutate: vi.fn(async () => null) },
      githubInstall: { mutate: vi.fn(async () => null) },
      githubCancel: { mutate: vi.fn(async () => null) },
      githubDisconnect: { mutate: vi.fn(async () => null) },
    },
    cloud: { relaunch: { mutate: vi.fn(async () => null) } },
  } satisfies AccountRpc;
  return {
    rpc,
    unsubscribe,
    githubUnsubscribe,
    push: (snapshot: AccountSnapshot) => act(() => handlers!.onData(snapshot)),
    fail: (error: unknown) => act(() => handlers!.onError(error)),
    github: (snapshot: AccountGithubSnapshot) => act(() => github!.onData(snapshot)),
    githubFail: (error: unknown) => act(() => github!.onError(error)),
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  useExperimentsStore.setState({ snapshot: { cloud: { enabled: true, source: "storage" } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useExperimentsStore.setState({ snapshot: null });
});

const acceptAgreement = () =>
  act(() =>
    container.querySelector<HTMLButtonElement>('[aria-label="Accept Preview Agreement"]')!.click(),
  );

const button = (label: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll("button")].find((node) =>
    node.textContent?.includes(label),
  );
  if (found === undefined) throw new Error(`no button "${label}" in ${document.body.textContent}`);
  return found;
};

describe("Settings → Account", () => {
  it("checks first, then offers GitHub and Google, and sends the one pressed", async () => {
    const tier = standIn();
    act(() => root.render(<AccountPane rpc={tier.rpc} />));
    expect(container.textContent).toContain("Checking your sign-in…");
    tier.push(SIGNED_OUT);
    expect(container.textContent).toContain("Continue with GitHub");
    acceptAgreement();
    act(() => button("Continue with Google").click());
    expect(tier.rpc.account.signIn.mutate).toHaveBeenCalledWith({
      connection: "google",
      acceptedAgreementVersion: PREVIEW_ENROLLMENT_AGREEMENT_VERSION,
    });

    tier.push({ ...SIGNED_OUT, state: "signing-in", signingInWith: "google" });
    expect(container.textContent).toContain("Waiting for the browser…");
    expect(button("Continue with GitHub").disabled).toBe(true);
    act(() => button("Cancel").click());
    expect(tier.rpc.account.cancelSignIn.mutate).toHaveBeenCalledOnce();

    tier.push({ ...SIGNED_OUT, failure: "Sign-in was declined in the browser." });
    expect(container.querySelector("[role=alert]")?.textContent).toBe(
      "Sign-in was declined in the browser.",
    );
  });

  it("shows the signed-in person, signs out, and deletes only after the confirm", async () => {
    const tier = standIn();
    act(() => root.render(<AccountPane rpc={tier.rpc} />));
    tier.push(SIGNED_IN);
    expect(container.textContent).toContain("Dana");
    expect(container.textContent).toContain("dana@example.com");
    expect(container.textContent).toContain("Connected");

    act(() => button("Sign out").click());
    expect(tier.rpc.account.signOut.mutate).toHaveBeenCalledOnce();

    act(() => button("Delete account…").click());
    expect(tier.rpc.account.requestDeletion.mutate).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Your account is deleted in 30 days.");
    const confirm = [...document.querySelectorAll("[role=alertdialog] button")].find(
      (node) => node.textContent === "Delete account",
    ) as HTMLButtonElement;
    act(() => confirm.click());
    expect(tier.rpc.account.requestDeletion.mutate).toHaveBeenCalledOnce();

    tier.push({
      ...SIGNED_IN,
      account: { ...SIGNED_IN.account!, deletionPurgeAfter: Date.UTC(2026, 10, 24) },
    });
    expect(container.textContent).toContain("Scheduled");
    expect(container.textContent).toContain(
      new Date(Date.UTC(2026, 10, 24)).getFullYear().toString(),
    );
    act(() => button("Restore account").click());
    expect(tier.rpc.account.cancelDeletion.mutate).toHaveBeenCalledOnce();
  });

  it("says when the backend is unreachable, and offers no deletion without one", async () => {
    const tier = standIn();
    act(() => root.render(<AccountPane rpc={tier.rpc} />));
    tier.push({
      ...SIGNED_IN,
      account: { ...SIGNED_IN.account!, backend: "unreachable", userId: null },
      failure: "Couldn't reach Volli Cloud. Your sign-in is kept.",
    });
    expect(container.textContent).toContain("Offline");
    expect(container.querySelector("[role=alert]")).toBeNull();
    expect(button("Delete account…").disabled).toBe(true);

    tier.push({
      ...SIGNED_IN,
      account: { ...SIGNED_IN.account!, backend: "refused" },
      failure: "Volli Cloud didn't accept this sign-in. Sign out and sign in again.",
    });
    expect(container.textContent).toContain("Not accepted");
    expect(container.querySelector("[role=alert]")?.textContent).toBe(
      "Volli Cloud didn't accept this sign-in. Sign out and sign in again.",
    );

    tier.push({ ...SIGNED_IN, account: { ...SIGNED_IN.account!, backend: "none", email: null } });
    expect(container.textContent).not.toContain("Delete account");
    expect(container.textContent).not.toContain("Deletion");
    expect(container.textContent).not.toContain("Email");
  });

  it("says when this build has no sign-in, and recovers a failed stream on retry", async () => {
    const tier = standIn();
    act(() => root.render(<AccountPane rpc={tier.rpc} />));
    tier.push({ ...SIGNED_OUT, state: "unconfigured", provider: null });
    expect(container.textContent).toContain("This build has no Volli Cloud sign-in.");

    tier.fail(new Error("The subscription's source failed"));
    expect(container.textContent).toContain("The subscription's source failed");
    act(() => button("Retry").click());
    expect(tier.rpc.account.subscribe.subscribe).toHaveBeenCalledTimes(2);
    expect(tier.unsubscribe).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Checking your sign-in…");
  });

  it("surfaces a command that failed", async () => {
    const tier = standIn();
    tier.rpc.account.signOut.mutate.mockRejectedValueOnce(new Error("Disk full."));
    const { toast } = await import("sonner");
    const error = vi.spyOn(toast, "error");
    act(() => root.render(<AccountPane rpc={tier.rpc} />));
    tier.push(SIGNED_IN);
    await act(async () => button("Sign out").click());
    expect(error).toHaveBeenCalledWith("Disk full.", expect.anything());
  });
});

// VC-889: signing in or out restarts Volli into the other product store.
describe("Settings → Account and the launch", () => {
  afterEach(() => adoptLaunch(LOCAL_LAUNCH));

  it("offers the restart into Volli Cloud once a sign-in completes in a local launch", async () => {
    const { toast } = await import("sonner");
    const shown = vi.mocked(toast as unknown as (...args: unknown[]) => void);
    shown.mockClear();
    const tier = standIn();
    act(() => root.render(<AccountPane rpc={tier.rpc} />));
    tier.push({ ...SIGNED_OUT, state: "signing-in", signingInWith: "github" });
    tier.push(SIGNED_IN);
    expect(shown).toHaveBeenCalledOnce();
    const [message, options] = shown.mock.calls[0] as [
      string,
      { action: { label: string; onClick(): void }; cancel: { label: string; onClick(): void } },
    ];
    expect(message).toBe("Restart to open Volli Cloud");
    expect(options.action.label).toBe("Restart now");
    expect(options.cancel.label).toBe("Later");
    options.cancel.onClick();
    expect(tier.rpc.cloud.relaunch.mutate).not.toHaveBeenCalled();
    options.action.onClick();
    expect(tier.rpc.cloud.relaunch.mutate).toHaveBeenCalledOnce();
    // The same account again offers nothing new; the row stays until the restart.
    tier.push({ ...SIGNED_IN });
    expect(shown).toHaveBeenCalledOnce();
    act(() => button("Restart to open Volli Cloud").click());
    expect(tier.rpc.cloud.relaunch.mutate).toHaveBeenCalledTimes(2);
  });

  it("in a cloud launch, signs out only after the confirm, then restarts", async () => {
    adoptLaunch({ store: "cloud", userId: "u", backendUrl: "http://127.0.0.1:1" });
    const tier = standIn();
    act(() => root.render(<AccountPane rpc={tier.rpc} />));
    tier.push(SIGNED_IN);
    expect(container.textContent).not.toContain("Restart to open Volli Cloud");
    act(() => button("Sign out").click());
    expect(tier.rpc.account.signOut.mutate).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Sign out and restart Volli?");
    const confirm = [...document.querySelectorAll("[role=alertdialog] button")].find(
      (node) => node.textContent === "Sign out and restart",
    ) as HTMLButtonElement;
    await act(async () => confirm.click());
    expect(tier.rpc.account.signOut.mutate).toHaveBeenCalledOnce();
    expect(tier.rpc.cloud.relaunch.mutate).toHaveBeenCalledOnce();
  });
});

describe("Settings → Account → GitHub", () => {
  it("draws nothing until main knows, and nothing where the deployment has no GitHub App", () => {
    const tier = standIn();
    act(() => root.render(<AccountPane rpc={tier.rpc} />));
    tier.push(SIGNED_IN);
    expect(tier.rpc.account.githubSubscribe.subscribe).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain("GitHub");
    tier.github({ ...GITHUB_NONE, state: "unavailable" });
    expect(container.textContent).not.toContain("GitHub");
  });

  it("does not read GitHub while the backend has not answered for the sign-in", () => {
    const tier = standIn();
    act(() => root.render(<AccountPane rpc={tier.rpc} />));
    tier.push({ ...SIGNED_IN, account: { ...SIGNED_IN.account!, backend: "unreachable" } });
    expect(tier.rpc.account.githubSubscribe.subscribe).not.toHaveBeenCalled();
  });

  it("not connected: Connect, waiting with a Cancel, and the reason a flow failed", () => {
    const tier = standIn();
    act(() => root.render(<AccountPane rpc={tier.rpc} />));
    tier.push(SIGNED_IN);
    tier.github(GITHUB_NONE);
    expect(container.textContent).not.toContain("GitHub accounts");
    expect(container.textContent).not.toContain("Disconnect");
    act(() => button("Connect").click());
    expect(tier.rpc.account.githubConnect.mutate).toHaveBeenCalledOnce();

    tier.github({ ...GITHUB_NONE, waiting: "connect" });
    expect(button("Waiting for the browser…").disabled).toBe(true);
    act(() => button("Cancel").click());
    expect(tier.rpc.account.githubCancel.mutate).toHaveBeenCalledOnce();

    tier.github({
      ...GITHUB_NONE,
      failure: "This GitHub account is connected to another Volli account.",
    });
    expect(container.querySelector("[role=alert]")?.textContent).toBe(
      "This GitHub account is connected to another Volli account.",
    );
  });

  it("active: who is connected, Disconnect, the accounts, Configure and Install", () => {
    const tier = standIn();
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    act(() => root.render(<AccountPane rpc={tier.rpc} />));
    tier.push(SIGNED_IN);
    tier.github(GITHUB_ACTIVE);
    expect(container.textContent).toContain("@dana");
    expect(container.textContent).toContain("Dana Doe");
    expect([...container.querySelectorAll("button")].map((node) => node.textContent)).not.toContain(
      "Connect",
    );
    const rows = container.querySelector("[data-testid=github-installations]")!.textContent;
    expect(rows).toContain("acme");
    expect(rows).toContain("Selected repositories");
    expect(rows).toContain("All repositories");

    act(() => button("Disconnect").click());
    expect(tier.rpc.account.githubDisconnect.mutate).toHaveBeenCalledOnce();
    act(() => button("Configure on GitHub").click());
    expect(open).toHaveBeenCalledWith(
      "https://github.com/organizations/acme/settings/installations/42",
      "_blank",
      "noopener",
    );
    act(() => button("Install on an account").click());
    expect(tier.rpc.account.githubInstall.mutate).toHaveBeenCalledOnce();

    // The control says it is waiting; no sentence under the list does.
    tier.github({ ...GITHUB_ACTIVE, waiting: "install" });
    expect(button("Waiting for the browser…").disabled).toBe(true);
    expect(container.querySelector("[role=status]")).toBeNull();
    act(() => button("Cancel").click());
    expect(tier.rpc.account.githubCancel.mutate).toHaveBeenCalledOnce();

    tier.github({ ...GITHUB_ACTIVE, requested: true });
    expect(container.querySelector("[role=status]")?.textContent).toBe(
      "If you asked an organization owner to approve, Volli will show the account here once they do.",
    );
    expect(button("Install on an account").disabled).toBe(false);
    tier.github({ ...GITHUB_ACTIVE, installations: [] });
    expect(container.textContent).toContain("No GitHub accounts yet.");
    open.mockRestore();
  });

  it("marks a suspended installation", () => {
    const tier = standIn();
    act(() => root.render(<AccountPane rpc={tier.rpc} />));
    tier.push(SIGNED_IN);
    tier.github({
      ...GITHUB_ACTIVE,
      installations: [{ ...GITHUB_ACTIVE.installations![0]!, suspended: true }],
    });
    expect(container.querySelector("[data-testid=github-installations]")!.textContent).toContain(
      "Selected repositories · Suspended",
    );
  });

  it("hides GitHub while a deletion is pending, and reads it afresh on a restore", () => {
    const tier = standIn();
    act(() => root.render(<AccountPane rpc={tier.rpc} />));
    tier.push(SIGNED_IN);
    tier.github(GITHUB_ACTIVE);
    expect(container.textContent).toContain("@dana");

    const pending = {
      ...SIGNED_IN,
      account: { ...SIGNED_IN.account!, deletionPurgeAfter: Date.UTC(2026, 10, 24) },
    };
    tier.push(pending);
    expect(container.textContent).toContain("Restore account");
    expect(container.textContent).not.toContain("GitHub");
    expect(tier.githubUnsubscribe).toHaveBeenCalledOnce();

    tier.push(SIGNED_IN);
    expect(tier.rpc.account.githubSubscribe.subscribe).toHaveBeenCalledTimes(2);
  });

  it("says when the GitHub stream itself failed, and subscribes again on Retry", () => {
    const tier = standIn();
    act(() => root.render(<AccountPane rpc={tier.rpc} />));
    tier.push(SIGNED_IN);
    tier.githubFail(new Error("The GitHub stream closed."));
    expect(container.textContent).toContain("The GitHub stream closed.");
    act(() => button("Retry").click());
    expect(tier.rpc.account.githubSubscribe.subscribe).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain("The GitHub stream closed.");

    tier.githubFail("not an error");
    expect(container.textContent).toContain("Couldn't read your GitHub connection.");
  });

  it("needs a reconnect: the one action is Reconnect", () => {
    const tier = standIn();
    act(() => root.render(<AccountPane rpc={tier.rpc} />));
    tier.push(SIGNED_IN);
    tier.github({
      ...GITHUB_NONE,
      connection: { status: "needs_reconnect", login: "dana", name: null },
    });
    expect(container.textContent).toContain("@dana");
    expect(container.textContent).not.toContain("Disconnect");
    expect(container.textContent).not.toContain("GitHub accounts");
    act(() => button("Reconnect").click());
    expect(tier.rpc.account.githubConnect.mutate).toHaveBeenCalledOnce();

    // An install still waiting does not lock Reconnect: a start replaces it.
    tier.github({
      ...GITHUB_NONE,
      connection: { status: "needs_reconnect", login: "dana", name: null },
      waiting: "install",
    });
    expect(button("Reconnect").disabled).toBe(false);
  });

  it("says when GitHub could not be read, retries, and toasts a refused command", async () => {
    const tier = standIn();
    tier.rpc.account.githubDisconnect.mutate.mockRejectedValueOnce(
      new Error("GitHub is unavailable. Try again."),
    );
    const { toast } = await import("sonner");
    const error = vi.spyOn(toast, "error");
    act(() => root.render(<AccountPane rpc={tier.rpc} />));
    tier.push(SIGNED_IN);
    tier.github({ ...GITHUB_NONE, state: "failed", failure: "Couldn't reach Volli Cloud." });
    expect(container.textContent).toContain("Couldn't reach Volli Cloud.");
    act(() => button("Retry").click());
    expect(tier.rpc.account.githubSubscribe.subscribe).toHaveBeenCalledTimes(2);

    tier.github(GITHUB_ACTIVE);
    await act(async () => button("Disconnect").click());
    expect(error).toHaveBeenCalledWith("GitHub is unavailable. Try again.", expect.anything());
  });
});

it("sends the optional preview invite code and leaves a waitlisted sign-in without a restart offer", () => {
  const tier = standIn();
  act(() => root.render(<AccountPane rpc={tier.rpc} />));
  tier.push(SIGNED_OUT);
  const input = container.querySelector<HTMLInputElement>(
    'input[aria-label="Preview invite code"]',
  )!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "preview-code-123456",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  acceptAgreement();
  act(() => button("Continue with GitHub").click());
  expect(tier.rpc.account.signIn.mutate).toHaveBeenCalledWith({
    connection: "github",
    inviteCode: "preview-code-123456",
    acceptedAgreementVersion: PREVIEW_ENROLLMENT_AGREEMENT_VERSION,
  });
  tier.push({
    ...SIGNED_IN,
    account: { ...SIGNED_IN.account!, backend: "refused" },
    failure:
      "Volli Cloud is invite-only. You're on the waitlist; your local projects are unchanged.",
  });
  expect(container.textContent).toContain("waitlist");
  expect(container.textContent).not.toContain("Restart to open");
});

it("does not read GitHub before stable enrollment restarts into cloud", () => {
  useExperimentsStore.setState({
    snapshot: { cloud: { enabled: false, source: "default", visible: false, enrollment: true } },
  });
  const tier = standIn();
  act(() => root.render(<AccountPane rpc={tier.rpc} />));
  tier.push(SIGNED_IN);
  expect(container.textContent).toContain("Restart to open Volli Cloud");
  expect(tier.rpc.account.githubSubscribe.subscribe).not.toHaveBeenCalled();
});

it("explains a short invite code before making an RPC call", () => {
  const tier = standIn();
  act(() => root.render(<AccountPane rpc={tier.rpc} />));
  tier.push(SIGNED_OUT);
  const input = container.querySelector<HTMLInputElement>(
    'input[aria-label="Preview invite code"]',
  )!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "short");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  acceptAgreement();
  act(() => button("Continue with GitHub").click());
  expect(tier.rpc.account.signIn.mutate).not.toHaveBeenCalled();
});

it("requires explicit agreement acceptance and links the legal pages before sign-in", () => {
  const tier = standIn();
  act(() => root.render(<AccountPane rpc={tier.rpc} />));
  tier.push(SIGNED_OUT);
  expect(button("Continue with GitHub").disabled).toBe(true);
  expect(container.querySelector('a[href="https://volli.app/legal/preview/"]')).not.toBeNull();
  expect(container.querySelector('a[href="https://volli.app/legal/privacy/"]')).not.toBeNull();
  acceptAgreement();
  expect(button("Continue with GitHub").disabled).toBe(false);
});
