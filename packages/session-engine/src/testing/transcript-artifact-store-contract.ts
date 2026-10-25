/**
 * What every {@link TranscriptArtifactStore} must do, as one suite.
 *
 * session-engine runs it against the in-memory store, host-core against
 * `FileTranscriptArtifactStore`. The cases are what the ledger and the history
 * window rely on: a reference is content-addressed by the artifact's canonical
 * JSON (whatever digest the store uses), reads hand back independent values,
 * malformed or foreign references are refused, and `byteLength` reports the
 * canonical size without ever throwing.
 *
 * Durability, compression and on-disk forms stay in each store's own tests.
 */
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  canonicalJson,
  TRANSCRIPT_ARTIFACT_MEDIA_TYPE,
  type SessionTranscriptArtifact,
  type TranscriptArtifactStore,
} from "../transcript-artifacts";

export interface TranscriptArtifactStoreContractStore {
  store: TranscriptArtifactStore;
  dispose(): void | Promise<void>;
}

export type TranscriptArtifactStoreContractFactory = () =>
  | TranscriptArtifactStoreContractStore
  | Promise<TranscriptArtifactStoreContractStore>;

function artifact(text: string, overrides: Partial<SessionTranscriptArtifact> = {}) {
  return {
    version: 1,
    threadId: "thread-contract",
    branchId: "branch-contract",
    attemptId: "attempt-contract",
    turnId: "turn-contract",
    message: { id: `message-${text}`, role: "assistant", parts: [{ type: "text", text }] },
    ...overrides,
  } satisfies SessionTranscriptArtifact;
}

const utf8 = new TextEncoder();

export function describeTranscriptArtifactStoreContract(
  adapter: string,
  open: TranscriptArtifactStoreContractFactory,
): void {
  describe(`TranscriptArtifactStore contract: ${adapter}`, () => {
    let opened: TranscriptArtifactStoreContractStore[] = [];
    afterEach(async () => {
      const stores = opened;
      opened = [];
      for (const store of stores) await store.dispose();
    });
    async function fresh(): Promise<TranscriptArtifactStore> {
      const store = await open();
      opened.push(store);
      return store.store;
    }

    it("returns a self-describing reference and reads the canonical artifact back", async () => {
      const store = await fresh();
      const written = artifact("hello", {
        message: {
          id: "message-hello",
          role: "assistant",
          // An undefined property is not part of the canonical value.
          metadata: undefined,
          parts: [{ type: "text", text: "hello" }],
        },
      });
      const reference = await store.write(written);
      expect(reference).toEqual({
        id: reference.id,
        digest: reference.id,
        mediaType: TRANSCRIPT_ARTIFACT_MEDIA_TYPE,
      });
      await expect(store.read(reference)).resolves.toStrictEqual(
        JSON.parse(canonicalJson(written)),
      );
    });

    it("addresses an artifact by its canonical value, so key order never matters and content always does", async () => {
      const store = await fresh();
      const first = await store.write(artifact("same"));
      const reordered = await store.write({
        message: { parts: [{ text: "same", type: "text" }], role: "assistant", id: "message-same" },
        turnId: "turn-contract",
        attemptId: "attempt-contract",
        branchId: "branch-contract",
        threadId: "thread-contract",
        version: 1,
      });
      const different = await store.write(artifact("different"));
      const elsewhere = await store.write(artifact("same", { turnId: null }));
      expect(reordered).toEqual(first);
      expect(new Set([first.id, different.id, elsewhere.id]).size).toBe(3);
      await expect(store.read(different)).resolves.toEqual(artifact("different"));
      await expect(store.read(elsewhere)).resolves.toEqual(artifact("same", { turnId: null }));
    });

    it("settles concurrent identical writes on one reference", async () => {
      const store = await fresh();
      const references = await Promise.all([1, 2, 3].map(() => store.write(artifact("race"))));
      expect(new Set(references.map(({ id }) => id)).size).toBe(1);
      await expect(store.read(references[0]!)).resolves.toEqual(artifact("race"));
    });

    it("hands every read its own value", async () => {
      const store = await fresh();
      const reference = await store.write(artifact("independent"));
      const read = await store.read(reference);
      read.message.parts.length = 0;
      read.threadId = "changed";
      await expect(store.read(reference)).resolves.toEqual(artifact("independent"));
    });

    it("refuses a malformed reference and one this store does not hold", async () => {
      const store = await fresh();
      const reference = await store.write(artifact("held"));
      for (const refused of [
        { ...reference, mediaType: "application/json" },
        { ...reference, digest: `${reference.digest}0` },
        { id: "not-a-digest", digest: "not-a-digest", mediaType: TRANSCRIPT_ARTIFACT_MEDIA_TYPE },
      ]) {
        await expect(store.read(refused)).rejects.toThrow();
      }
      // Well formed, but written to another store.
      const other = await fresh();
      await expect(other.read(reference)).rejects.toThrow();
    });

    it("refuses an artifact that is not plain JSON data", async () => {
      const store = await fresh();
      await expect(
        store.write(
          artifact("dated", {
            message: {
              id: "message-dated",
              role: "assistant",
              parts: [{ type: "data-when", data: new Date(0) }],
            },
          }),
        ),
      ).rejects.toThrow();
    });

    it("says an artifact's canonical size, and null whenever it cannot", async () => {
      const store = await fresh();
      expect(store.byteLength).toBeTypeOf("function");
      const written = artifact("sized ✓");
      const reference = await store.write(written);
      await expect(store.byteLength!(reference)).resolves.toBe(
        utf8.encode(canonicalJson(written)).length,
      );
      const other = await fresh();
      await expect(other.byteLength!(reference)).resolves.toBeNull();
      await expect(
        store.byteLength!({ id: "not-a-digest", digest: "x", mediaType: "x" }),
      ).resolves.toBeNull();
    });
  });
}
