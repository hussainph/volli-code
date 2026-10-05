/**
 * The keys that seal the typed credential inventory (VC-642;
 * `docs/plans/sealed-credential-store.md` §3, §7).
 *
 * The legacy {@link SecretKeyPort} seals and opens a whole document and holds
 * one key per launch. A keyring instead names its keys: every sealed
 * inventory's header carries the id of the key that sealed it, and the
 * inventory asks the keyring for exactly that key. So rotation (VC-649) is
 * additive, a second key beside the first, and a process that cached one key
 * notices on its next locked read that the file now names another.
 *
 * A key id is the first 16 bytes of a labelled SHA-256 of the key, written as
 * 32 lowercase hex digits (`credential-key-id.ts`). It selects a key; it is
 * not proof of anything, and never an epoch. An id the keyring does not hold
 * is "unavailable", never "empty".
 *
 * Today one backend exists: `file`, the headless key file
 * (`fileCredentialKeyring` in `@volli/host-core/secrets`). A keychain-wrapped
 * keyring for desktop is added when the first desktop family moves in; its
 * header byte is reserved now so its envelopes are told apart rather than
 * mistaken for corrupt ones.
 */
/** Where a keyring keeps its keys. Each has a byte in the envelope header. */
export type CredentialKeyBackend = "file" | "keychain";

/** One data key and its id. Callers must not keep or log the key bytes. */
export interface CredentialKey {
  readonly id: string;
  readonly key: Buffer;
}

export interface CredentialKeyring {
  readonly backend: CredentialKeyBackend;
  /**
   * Checks the backend now, cheaply: a key file is read again, a keychain is
   * not asked (that may prompt). Throws the `SecretKeyUnavailableError`
   * a later resolve would: a key this keyring opened with and the backend no
   * longer holds is `missing` or `wrong-key`, noticed mid-run.
   */
  probe(): void;
  /**
   * The key named `id`, read from a sealed header. Never creates one. An id
   * it does not hold is a `SecretKeyUnavailableError`.
   */
  resolve(id: string): Buffer;
  /** The key new seals use, made the first time when the backend has none. */
  active(): CredentialKey;
}
