// @vitest-environment jsdom
/**
 * A connected account under the two arrivals that name it (VC-1236): the
 * ordinary deep link starts nothing there, and a stopped chat's sign-in-again
 * request starts exactly the method it named. Cancelling that writes nothing.
 */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";
import type { ModelAccessProvider, ModelAccessSignInType } from "@volli/shared";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import {
  ModelAccessProvider as ModelAccessClientProvider,
  type ModelAccessClient,
} from "@renderer/lib/model-access-client";
import { ModelAccessAccounts } from "./provider-accounts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A subscription login that still reads as connected: its dead credential is stored. */
const CONNECTED: ModelAccessProvider = {
  id: "anthropic",
  label: "Anthropic",
  state: "available",
  accountLabel: null,
  billingSource: "subscription",
  recovery: null,
  hasStoredCredential: true,
  signIn: [
    { type: "api-key", label: "API key", isSubscription: false },
    { type: "oauth", label: "Claude Pro/Max", isSubscription: true },
  ],
};

async function arrive(request: {
  autoSignInProviderId?: string;
  reauthenticate?: ModelAccessSignInType;
}) {
  const cancel = vi.fn(async () => undefined);
  const beginSignIn = vi.fn(async () => ({ attemptId: "a1", respond: vi.fn(), cancel }));
  const signOut = vi.fn();
  const client = { beginSignIn, signOut } as unknown as ModelAccessClient;
  const onChanged = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <ModelAccessClientProvider client={client}>
        <TooltipProvider>
          <ModelAccessAccounts
            providers={[CONNECTED]}
            {...request}
            onRecover={vi.fn()}
            onChanged={onChanged}
          />
        </TooltipProvider>
      </ModelAccessClientProvider>,
    ),
  );
  return {
    beginSignIn,
    cancel,
    signOut,
    onChanged,
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

describe("a connected account, by the intent that names it", () => {
  it("the ordinary deep link never starts a fresh auth flow there", async () => {
    const view = await arrive({ autoSignInProviderId: "anthropic" });
    try {
      expect(view.beginSignIn).not.toHaveBeenCalled();
    } finally {
      await view.unmount();
    }
  });

  it.each(["oauth", "api-key"] as const)(
    "a stopped chat's sign-in-again request starts the %s method, and only that",
    async (method) => {
      const view = await arrive({ autoSignInProviderId: "anthropic", reauthenticate: method });
      try {
        expect(view.beginSignIn).toHaveBeenCalledExactlyOnceWith(
          "anthropic",
          method,
          expect.any(Function),
        );
        // Nothing is signed out to make room: the login replaces in place.
        expect(view.signOut).not.toHaveBeenCalled();
      } finally {
        await view.unmount();
      }
    },
  );

  it("cancelling leaves the account as it was: nothing signed out, nothing reloaded", async () => {
    const view = await arrive({ autoSignInProviderId: "anthropic", reauthenticate: "oauth" });
    try {
      const cancel = [...view.container.querySelectorAll("button")].find(
        (button) => button.textContent === "Cancel",
      );
      expect(cancel).toBeDefined();
      await act(async () => cancel!.click());
      expect(view.cancel).toHaveBeenCalledOnce();
      expect(view.signOut).not.toHaveBeenCalled();
      expect(view.onChanged).not.toHaveBeenCalled();
      // The row is back to what it offered before: Sign out, and no attempt.
      const labels = [...view.container.querySelectorAll("button")].map((b) => b.textContent);
      expect(labels).toContain("Sign out");
      expect(labels).not.toContain("Cancel");
    } finally {
      await view.unmount();
    }
  });
});
