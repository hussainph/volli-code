/**
 * The key-id format of the typed credential inventory (VC-642;
 * `docs/plans/sealed-credential-store.md` §3, §7).
 *
 * `credentialKeyId(key)` is the first {@link CREDENTIAL_KEY_ID_BYTES} bytes of
 * SHA-256 over a fixed label and the key, as lowercase hex. 128 bits, where
 * the legacy `VSF1` envelope's id is 64: ids are compared across every key a
 * keyring will ever hold, rotation's included. The label differs from
 * `VSF1`'s, so one key file's two ids cannot be matched to each other.
 *
 * The id selects a key; it proves nothing (the AES-GCM tag does) and it is
 * not an epoch. Changing the label or the length makes every sealed inventory
 * read as sealed by an unknown key, so both are durable format.
 */
import { createHash, timingSafeEqual } from "node:crypto";

/** Durable format: see this module's comment. */
const LABEL = "volli-credential-key-id:v2\0";
export const CREDENTIAL_KEY_ID_BYTES = 16;
const ID_TEXT = /^[0-9a-f]{32}$/;

/** The id of `key`, as 32 lowercase hex digits. */
export function credentialKeyId(key: Buffer): string {
  return createHash("sha256")
    .update(LABEL)
    .update(key)
    .digest()
    .subarray(0, CREDENTIAL_KEY_ID_BYTES)
    .toString("hex");
}

/** Whether `text` is a well-formed key id. */
export function isCredentialKeyId(text: unknown): text is string {
  return typeof text === "string" && ID_TEXT.test(text);
}

/**
 * The keys a keyring holds, by id, refusing a collision: two different keys
 * with one id is never resolved to either. `idOf` is replaceable so the
 * refusal can be tested; production uses {@link credentialKeyId}.
 */
export class CredentialKeySet {
  readonly #keys = new Map<string, Buffer>();
  /** Ids two different keys claimed: resolved to neither, ever, in this set. */
  readonly #collided = new Set<string>();
  readonly #idOf: (key: Buffer) => string;

  constructor(idOf: (key: Buffer) => string = credentialKeyId) {
    this.#idOf = idOf;
  }

  /** Adds `key` and answers its id; a different key with the same id throws. */
  add(key: Buffer): string {
    const id = this.#idOf(key);
    const held = this.#keys.get(id);
    if (
      this.#collided.has(id) ||
      (held !== undefined && !(held.length === key.length && timingSafeEqual(held, key)))
    ) {
      this.#keys.delete(id);
      this.#collided.add(id);
      throw new Error("Two credential keys share one key id; neither is used.");
    }
    this.#keys.set(id, key);
    return id;
  }

  get(id: string): Buffer | undefined {
    return this.#keys.get(id);
  }

  /** Drops every key, zeroing the bytes. */
  clear(): void {
    for (const key of this.#keys.values()) key.fill(0);
    this.#keys.clear();
  }
}
