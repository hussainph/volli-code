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
 */

export const BROWSER_PICTURE_LIVE_LIMIT = 48;

export type BrowserPictureMime = "image/jpeg" | "image/png";

export interface BrowserPicturePersistence {
  write(id: string, bytes: Uint8Array, mime: BrowserPictureMime): void;
  read(id: string): { bytes: Uint8Array; mime: BrowserPictureMime } | null;
}

export interface BrowserPictureStoreDependencies {
  createId: () => string;
  now: () => number;
  /** Absent means nothing outlives the live set — every test and a build with no disk. */
  persist?: BrowserPicturePersistence;
  liveLimit?: number;
}

export interface BrowserPictureInput {
  tabId: string;
  generation: number;
  mime: BrowserPictureMime;
  bytes: Uint8Array;
  /** Whether this picture should survive the live set — a screenshot the model asked for. */
  persist: boolean;
}

interface LivePicture {
  tabId: string;
  generation: number;
  capturedAt: number;
  mime: BrowserPictureMime;
  bytes: Uint8Array;
}

/**
 * Ids are minted here and only here, and a read checks the id was ours before
 * it goes anywhere near the persistence sink — the same discipline the Blob
 * store keeps with its hashes, so no renderer string can name a file.
 */
export class BrowserPictureStore {
  private readonly live = new Map<string, LivePicture>();
  private readonly minted = new Map<
    string,
    { tabId: string; generation: number; capturedAt: number; persisted: boolean }
  >();
  private readonly liveLimit: number;

  constructor(private readonly deps: BrowserPictureStoreDependencies) {
    this.liveLimit = deps.liveLimit ?? BROWSER_PICTURE_LIVE_LIMIT;
  }

  put(input: BrowserPictureInput): string {
    const id = this.deps.createId();
    const capturedAt = this.deps.now();
    const persisted = input.persist && this.deps.persist !== undefined;
    if (persisted) this.deps.persist!.write(id, input.bytes, input.mime);
    this.minted.set(id, {
      tabId: input.tabId,
      generation: input.generation,
      capturedAt,
      persisted,
    });
    this.live.set(id, {
      tabId: input.tabId,
      generation: input.generation,
      capturedAt,
      mime: input.mime,
      bytes: input.bytes,
    });
    // Insertion order is age: a Map iterates oldest-first, so the first key is
    // the one the bound lets go of.
    while (this.live.size > this.liveLimit) {
      const oldest = this.live.keys().next().value;
      if (oldest === undefined) break;
      this.live.delete(oldest);
    }
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
  describe(id: string): { tabId: string; generation: number; capturedAt: number } | null {
    const record = this.minted.get(id);
    return record === null || record === undefined
      ? null
      : { tabId: record.tabId, generation: record.generation, capturedAt: record.capturedAt };
  }

  /** Drops every live picture; persisted ones still answer from disk. */
  forgetLive(): void {
    this.live.clear();
  }
}

function encode(bytes: Uint8Array, mime: BrowserPictureMime): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
}
