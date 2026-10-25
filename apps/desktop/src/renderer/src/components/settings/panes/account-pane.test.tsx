// @vitest-environment jsdom
/**
 * Settings → Account (VC-884) over a stand-in for main's `account.*` tier:
 * what each account state draws, and which command each control sends.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { AccountSnapshot } from "@volli/shared";

import { AccountPane } from "./account-pane";
import type { AccountRpc } from "./use-account";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

function standIn() {
  let handlers: { onData(data: AccountSnapshot): void; onError(error: unknown): void } | null =
    null;
  const unsubscribe = vi.fn();
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
    },
  } satisfies AccountRpc;
  return {
    rpc,
    unsubscribe,
    push: (snapshot: AccountSnapshot) => act(() => handlers!.onData(snapshot)),
    fail: (error: unknown) => act(() => handlers!.onError(error)),
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

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
    act(() => button("Continue with Google").click());
    expect(tier.rpc.account.signIn.mutate).toHaveBeenCalledWith({ connection: "google" });

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
    expect(container.textContent).toContain("Deletion scheduled for");
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
    expect(container.textContent).toContain("Couldn't reach Volli Cloud. Your sign-in is kept.");
    expect(button("Delete account…").disabled).toBe(true);

    tier.push({ ...SIGNED_IN, account: { ...SIGNED_IN.account!, backend: "none", email: null } });
    expect(container.textContent).not.toContain("Delete account");
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
