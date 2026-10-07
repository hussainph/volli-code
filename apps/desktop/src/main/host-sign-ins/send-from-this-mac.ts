/**
 * "Send from this Mac" for an API key (VC-702, owner decision 2).
 *
 * At the person's request, after the confirm "<host> keeps a copy of what this
 * Mac sends" and main's native Send/Cancel dialog, main reads this Mac's own
 * Pi credential for one provider and
 * sends the key to the host with `signIns.setApiKey`. The key goes from this
 * Mac's credential store straight onto the authenticated host link: it never
 * crosses into the renderer, and nothing here keeps or logs it.
 *
 * **Keys only.** A subscription login (an OAuth credential) is never sent:
 * two machines refreshing one grant sign one of them out when the provider
 * rotates refresh tokens, so a subscription signs in on the host instead
 * (`signIns.start`). A key that lives only in an environment variable is not
 * stored here, so there is nothing to send.
 *
 * The store is a port (`CredentialStore.read`), so tests use a fake and never
 * touch a real `auth.json`.
 */

import type { HostSignInSendRefusal } from "@volli/shared";
import type { BrowserWindow, MessageBoxOptions } from "electron";

/** The one read this needs from Pi's credential store. */
export interface MacCredentialReader {
  read(providerId: string): Promise<MacStoredCredential | undefined>;
}

/** Pi's stored credential, as far as this module looks at it. */
export type MacStoredCredential =
  | { readonly type: "api_key"; readonly key?: string }
  | { readonly type: "oauth" };

/** Whether this Mac holds a key it could send, and why not. Never the key. */
export type MacKeyAvailability =
  | { readonly kind: "key" }
  | { readonly kind: "none" }
  /** A subscription login: signs in on the host instead. */
  | { readonly kind: "subscription" };

/** Availability only: what a row may say about this Mac's sign-in, before anyone asks to send it. */
export async function macKeyAvailability(
  store: MacCredentialReader,
  providerId: string,
): Promise<MacKeyAvailability> {
  const credential = await store.read(providerId);
  if (credential === undefined) return { kind: "none" };
  if (credential.type === "oauth") return { kind: "subscription" };
  return typeof credential.key === "string" && credential.key.length > 0
    ? { kind: "key" }
    : { kind: "none" };
}

/** Main-owned names, resolved locally, never from the renderer or a host's status. */
export interface SendConfirmationLabels {
  readonly providerLabel: string;
  readonly hostName: string;
  readonly hostTarget: string;
}

/** Approval belongs to the window/document that showed the native dialog. */
export interface NativeSendApproval {
  isCurrent(): boolean;
  dispose(): void;
}

/** Electron adapter with an injected dialog/window seam: no Electron runs in tests. */
export function createNativeSendConfirmation(options: {
  readonly getWindow: () => BrowserWindow | null;
  readonly showMessageBox: (
    window: BrowserWindow,
    options: MessageBoxOptions,
  ) => Promise<{ response: number }>;
}): (labels: SendConfirmationLabels) => Promise<NativeSendApproval | "cancelled" | null> {
  return async (labels) => {
    const window = options.getWindow();
    if (window === null || window.isDestroyed() || window.webContents.isDestroyed()) return null;
    let gone = false;
    const invalidate = (): void => {
      gone = true;
    };
    window.on("closed", invalidate);
    window.webContents.on("did-start-navigation", invalidate);
    window.webContents.on("render-process-gone", invalidate);
    const approval: NativeSendApproval = {
      isCurrent: () =>
        !gone &&
        options.getWindow() === window &&
        !window.isDestroyed() &&
        !window.webContents.isDestroyed(),
      dispose: () => {
        window.removeListener("closed", invalidate);
        window.webContents.removeListener("did-start-navigation", invalidate);
        window.webContents.removeListener("render-process-gone", invalidate);
      },
    };
    try {
      const answer = await options.showMessageBox(window, {
        type: "warning",
        message: `Send your ${labels.providerLabel} key to ${labels.hostName}?`,
        detail: `${labels.hostTarget}\n${labels.hostName} keeps a copy of what this Mac sends.`,
        buttons: ["Send", "Cancel"],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      if (approval.isCurrent()) {
        if (answer.response === 0) return approval;
        if (answer.response === 1) {
          approval.dispose();
          return "cancelled";
        }
      }
    } catch {
      // A failed dialog is never consent; do not repeat platform error text.
    }
    approval.dispose();
    return null;
  };
}

/** Where the key goes: the host link's `signIns.setApiKey`. */
export type SetHostApiKey<Status> = (input: { providerId: string; key: string }) => Promise<Status>;

/** Main-internal outcome; native cancellation is projected to status before crossing IPC. */
export type SendFromThisMacResult<Status> =
  | { readonly ok: true; readonly status: Status }
  | { readonly ok: false; readonly reason: HostSignInSendRefusal | "cancelled" };

/**
 * Renderer confirmation is only the first step. Main must obtain native
 * approval before reading the key, and the window and connection must still
 * own that approval after the asynchronous read.
 */
export async function sendApiKeyFromThisMac<Status>(input: {
  readonly providerId: string;
  readonly confirmed: true;
  readonly store: MacCredentialReader;
  readonly setApiKey: SetHostApiKey<Status>;
  readonly confirm: () => Promise<NativeSendApproval | "cancelled" | null>;
  readonly isCurrent: () => boolean;
}): Promise<SendFromThisMacResult<Status>> {
  if (input.confirmed !== true) return { ok: false, reason: "no-key" };
  let approval: NativeSendApproval | null = null;
  try {
    const confirmation = await input.confirm?.();
    if (confirmation === "cancelled") return { ok: false, reason: "cancelled" };
    approval = confirmation ?? null;
    // Missing or failed native confirmation is never consent.
    if (approval == null || !approval.isCurrent() || !input.isCurrent()) {
      return { ok: false, reason: "send-failed" };
    }
    const credential = await input.store.read(input.providerId);
    if (!approval.isCurrent() || !input.isCurrent()) return { ok: false, reason: "send-failed" };
    if (credential?.type === "oauth") return { ok: false, reason: "subscription" };
    const key = credential?.type === "api_key" ? credential.key : undefined;
    if (key === undefined || key.length === 0) return { ok: false, reason: "no-key" };
    return { ok: true, status: await input.setApiKey({ providerId: input.providerId, key }) };
  } catch {
    // Neither a credential-store error nor a link failure may echo the key.
    return { ok: false, reason: "send-failed" };
  } finally {
    approval?.dispose();
  }
}
