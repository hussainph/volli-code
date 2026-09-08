import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

const LEGACY_NATIVE_OBSERVATION_PREFIX = "native-event:";
const COMPACT_NATIVE_OBSERVATION_PREFIX = "native-event:v2:";
const COMPACT_NATIVE_OBSERVATION_ID = /^native-event:v2:[a-f0-9]{32}$/;

/**
 * Compacts the legacy native-observation identity without needing to parse it.
 *
 * The legacy string is itself the canonical, deterministic encoding of the
 * adapter, Session, attachment and observation identities. Hashing those exact
 * UTF-8 bytes lets migration 42 and the runtime share one function even though
 * observation ids may contain arbitrary colons. The first 128 SHA-256 bits keep
 * the complete id at 48 characters; SQLite still collision-checks the migrated
 * set and every future ledger insert checks global id uniqueness.
 */
export function compactNativeObservationEventId(id: string): string {
  if (COMPACT_NATIVE_OBSERVATION_ID.test(id)) return id;
  if (!id.startsWith(LEGACY_NATIVE_OBSERVATION_PREFIX)) return id;
  const digest = bytesToHex(sha256(utf8ToBytes(id))).slice(0, 32);
  return `${COMPACT_NATIVE_OBSERVATION_PREFIX}${digest}`;
}

/** The stable native observation event id written by the Session runtime. */
export function nativeObservationEventId(
  adapterId: string,
  sessionId: string,
  attachmentId: string,
  observationId: string,
): string {
  const legacyId = `${LEGACY_NATIVE_OBSERVATION_PREFIX}${adapterId}:${sessionId}:${attachmentId}:${observationId}`;
  return compactNativeObservationEventId(legacyId);
}
