/**
 * Where a Browser Tab's pictures live between the host that captured them and
 * the card that shows them (VC-238).
 *
 * Pictures never ride the activity payload: it is bounded at 32 KB per string,
 * which is why the person used to see a cut-off base64 string where the tool
 * description promised them a picture. The bytes stay here in main, keyed by
 * the tab and generation they were taken at, and the transcript carries only
 * the id this store minted. The renderer resolves an id through one IPC read
 * and gets a data URL back; nothing about the page but its pixels crosses.
 *
 * Two lifetimes, one door. A capture taken after every navigate and act is
 * live evidence — it shows the person what the agent just did — and is held in
 * a small bounded set that forgets the oldest first. A `browser_screenshot`
 * the model asked for is a picture the person may want later, so it is also
 * written through the injected `persist` sink (a directory under userData in
 * production) and read back from there once the live set has moved on. The
 * two answer the same question the same way, so a card never has to know
 * which kind it is holding.
 *
 * A persisted picture outlives the process, so the index of what was minted
 * has to as well: the store REHYDRATES from the sink at construction, and a
 * transcript reopened after a relaunch resolves its screenshots instead of
 * saying they are unavailable while the bytes sit on disk. Rehydrating is also
 * what makes the disk bounded — every persisted picture carries its own
 * record (which tab, which Session, when), and construction sweeps the ones
 * past the age or count bound rather than leaving an unowned pile forever.
 */

export const BROWSER_PICTURE_LIVE_LIMIT = 48;

/**
 * How long a `browser_screenshot` the model asked for stays on disk, and how
 * many are kept at once. Long enough that reopening last week's chat still
 * shows its pictures; bounded because nothing else ever deletes them — the
 * transcript that names them is durable and the pixels are not the transcript.
 */
export const BROWSER_PICTURE_PERSIST_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
export const BROWSER_PICTURE_PERSIST_LIMIT = 400;

export type BrowserPictureMime = "image/jpeg" | "image/png";

/** What a persisted picture is of, kept beside its bytes so the sink is self-describing. */
export interface BrowserPictureRecord {
  id: string;
  tabId: string;
  generation: number;
  capturedAt: number;
  /** The Session whose tab it was taken from, or null for a person's tab. */
  ownerSessionId: string | null;
  mime: BrowserPictureMime;
}

export interface BrowserPicturePersistence {
  write(bytes: Uint8Array, record: BrowserPictureRecord): void;
  read(id: string): { bytes: Uint8Array; mime: BrowserPictureMime } | null;
  /** Every picture the sink still holds, for rehydration and the sweep. */
  list(): readonly BrowserPictureRecord[];
  remove(id: string): void;
}

export interface BrowserPictureStoreDependencies {
  createId: () => string;
  now: () => number;
  /** Absent means nothing outlives the live set — every test and a build with no disk. */
  persist?: BrowserPicturePersistence;
  liveLimit?: number;
  persistLimit?: number;
  persistMaxAgeMs?: number;
}

export interface BrowserPictureInput {
  tabId: string;
  generation: number;
  mime: BrowserPictureMime;
  bytes: Uint8Array;
  /** The Session that owns the tab this was taken from; null for a person's. */
  ownerSessionId: string | null;
  /** Whether this picture should survive the live set — a screenshot the model asked for. */
  persist: boolean;
}

interface LivePicture {
  mime: BrowserPictureMime;
  bytes: Uint8Array;
}

/**
 * Ids are minted here and only here, and a read checks the id was ours before
 * it goes anywhere near the persistence sink — the same discipline the Blob
 * store keeps with its hashes, so no renderer string can name a file. "Ours"
 * includes the ids a previous launch minted, which is exactly what rehydration
 * establishes.
 */
export class BrowserPictureStore {
  private readonly live = new Map<string, LivePicture>();
  private readonly minted = new Map<string, BrowserPictureRecord & { persisted: boolean }>();
  private readonly liveLimit: number;
  private readonly persistLimit: number;
  private readonly persistMaxAgeMs: number;

  constructor(private readonly deps: BrowserPictureStoreDependencies) {
    this.liveLimit = deps.liveLimit ?? BROWSER_PICTURE_LIVE_LIMIT;
    this.persistLimit = deps.persistLimit ?? BROWSER_PICTURE_PERSIST_LIMIT;
    this.persistMaxAgeMs = deps.persistMaxAgeMs ?? BROWSER_PICTURE_PERSIST_MAX_AGE_MS;
    for (const record of deps.persist?.list() ?? []) {
      this.minted.set(record.id, { ...record, persisted: true });
    }
    this.sweepPersisted();
  }

  put(input: BrowserPictureInput): string {
    const id = this.deps.createId();
    const persisted = input.persist && this.deps.persist !== undefined;
    const record: BrowserPictureRecord = {
      id,
      tabId: input.tabId,
      generation: input.generation,
      capturedAt: this.deps.now(),
      ownerSessionId: input.ownerSessionId,
      mime: input.mime,
    };
    if (persisted) this.deps.persist?.write(input.bytes, record);
    this.minted.set(id, { ...record, persisted });
    this.live.set(id, { mime: input.mime, bytes: input.bytes });
    // Insertion order is age: a Map iterates oldest-first, so the first key is
    // the one the bound lets go of. A live picture the bound drops leaves its
    // record behind — a persisted one still answers from disk, and a live one
    // answers null the same way it would for an id from a previous launch.
    while (this.live.size > this.liveLimit) {
      const oldest = this.live.keys().next().value;
      if (oldest === undefined) break;
      this.live.delete(oldest);
      if (this.minted.get(oldest)?.persisted !== true) this.minted.delete(oldest);
    }
    if (persisted) this.sweepPersisted();
    return id;
  }

  /** The picture as an `<img src>`, or null when nothing here or on disk answers to the id. */
  dataUrl(id: string): string | null {
    const record = this.minted.get(id);
    if (record === undefined) return null;
    const held = this.live.get(id);
    if (held !== undefined) return encode(held.bytes, held.mime);
    if (!record.persisted) return null;
    const stored = this.deps.persist?.read(id) ?? null;
    return stored === null ? null : encode(stored.bytes, stored.mime);
  }

  /** What a picture is of, for a card that only holds the id. */
  describe(id: string): BrowserPictureRecord | null {
    const record = this.minted.get(id);
    if (record === undefined) return null;
    const { persisted: _persisted, ...fact } = record;
    return fact;
  }

  /**
   * Drops persisted pictures past the age or count bound, newest kept. Run at
   * construction (so a launch pays for the last one's excess) and after each
   * persisted write (so a long-running app cannot outgrow the bound either).
   */
  private sweepPersisted(): void {
    const sink = this.deps.persist;
    if (sink === undefined) return;
    const kept = [...this.minted.values()]
      .filter((record) => record.persisted)
      .toSorted((left, right) => right.capturedAt - left.capturedAt);
    const cutoff = this.deps.now() - this.persistMaxAgeMs;
    for (const [index, record] of kept.entries()) {
      if (index < this.persistLimit && record.capturedAt >= cutoff) continue;
      sink.remove(record.id);
      this.minted.delete(record.id);
      this.live.delete(record.id);
    }
  }
}

function encode(bytes: Uint8Array, mime: BrowserPictureMime): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
}
