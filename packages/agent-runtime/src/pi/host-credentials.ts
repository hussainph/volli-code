/**
 * The host's Pi auth storage as a sign-in key provider sees it (VC-702).
 *
 * Two things a host-protocol sign-in needs from Pi's credential store, and
 * nothing more: write a model API key a Client sent, and say which providers
 * hold a credential of which kind, with an OAuth credential's expiry. Neither
 * hands a value back: `stored()` reads the record under Pi's store and
 * returns only its provider, type and expiry, so a status read never holds a
 * secret beyond this function.
 *
 * Writes go through `CredentialStore.modify`, the same per-file write chain
 * `Models.login` persists through, so a key sent here and a login running
 * beside it cannot lose each other's entry.
 */
import type { CredentialStore } from "@earendil-works/pi-ai";

/** One stored credential, as availability: never its value. */
export interface PiStoredCredential {
  providerId: string;
  type: "api-key" | "oauth";
  /** An OAuth access token's expiry (ms since epoch), or null for a key. */
  expiresAt: number | null;
}

export interface PiHostCredentials {
  /** Stores a provider API key, replacing whatever that provider held. */
  setApiKey(providerId: string, key: string): Promise<void>;
  /** Every stored credential's provider, kind and expiry. */
  stored(): Promise<readonly PiStoredCredential[]>;
}

export function piHostCredentials(
  store: Pick<CredentialStore, "list" | "read" | "modify">,
): PiHostCredentials {
  return {
    setApiKey: async (providerId, key) => {
      await store.modify(providerId, async () => ({ type: "api_key", key }));
    },
    stored: async () => {
      const listed = await store.list();
      return Promise.all(
        listed.map(async ({ providerId, type }): Promise<PiStoredCredential> => {
          if (type !== "oauth") return { providerId, type: "api-key", expiresAt: null };
          const credential = await store.read(providerId);
          const expires =
            credential?.type === "oauth" && Number.isFinite(credential.expires)
              ? credential.expires
              : null;
          return { providerId, type: "oauth", expiresAt: expires };
        }),
      );
    },
  };
}
