/**
 * "Send from this Mac" for an API key (VC-702, owner decision 2).
 *
 * At the person's request, after the confirm "<host> keeps a copy of what this
 * Mac sends", main reads this Mac's own Pi credential for one provider and
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

/** Where the key goes: the host link's `signIns.setApiKey`. */
export type SetHostApiKey<Status> = (input: { providerId: string; key: string }) => Promise<Status>;

export type SendFromThisMacResult<Status> =
  | { readonly ok: true; readonly status: Status }
  | { readonly ok: false; readonly reason: "no-key" | "subscription" | "send-failed" };

/**
 * Sends this Mac's key for one provider to a host. `confirmed` is the
 * person's answer to the confirm and must be `true`: the read happens only
 * at the person's request, never ahead of it.
 */
export async function sendApiKeyFromThisMac<Status>(input: {
  readonly providerId: string;
  readonly confirmed: true;
  readonly store: MacCredentialReader;
  readonly setApiKey: SetHostApiKey<Status>;
}): Promise<SendFromThisMacResult<Status>> {
  if (input.confirmed !== true) return { ok: false, reason: "no-key" };
  const credential = await input.store.read(input.providerId);
  if (credential?.type === "oauth") return { ok: false, reason: "subscription" };
  const key = credential?.type === "api_key" ? credential.key : undefined;
  if (key === undefined || key.length === 0) return { ok: false, reason: "no-key" };
  try {
    return { ok: true, status: await input.setApiKey({ providerId: input.providerId, key }) };
  } catch {
    // The link's own failure is not repeated: it is not ours to vouch that it
    // does not quote the request it failed to send.
    return { ok: false, reason: "send-failed" };
  }
}
