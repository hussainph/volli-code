/**
 * Bounded, disposable decoration, kept apart from browser screenshots and the
 * durable ledger. Reads and watches ONLY project bytes already held here.
 * Successful live reads are the sole future producer of put() calls; neither
 * a renderer's origin nor knowledge of a picture UUID confers a read grant.
 */
import { randomUUID } from "node:crypto";
import {
  SOURCE_ICON_ORIGIN_LIMIT,
  isCanonicalSourceOrigin,
  type SourceIconsSnapshot,
  type SourceIconsWatchInput,
} from "@volli/shared";
import { registrableDomainForOrigin } from "./domain";

const MAX_ENTRIES = 256;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_IMAGE_BYTES = 64 * 1024;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_WATCHES = 128;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ABSENT = { data: null, mimeType: null, nextOffset: null } as const;

interface Entry {
  id: string;
  sessionId: string;
  authority: string;
  origin: string;
  expiresAt: number;
  bytes: Uint8Array;
}

interface Watch {
  input: SourceIconsWatchInput;
  authority: string | null;
  emit(snapshot: SourceIconsSnapshot): void;
  timer: ReturnType<typeof setTimeout> | undefined;
  last: string | undefined;
  closed: boolean;
}

export interface SourceIconCacheOptions {
  /**
   * Live, host-owned access epoch, incorporating person/workspace/Session
   * ownership. Null denies access. Changes MUST produce a different epoch,
   * including revocation and signing back into the same account. Never a token.
   */
  authorityForSession(sessionId: string): string | null;
  now?: () => number;
  createId?: () => string;
}

export class SourceIconCache {
  private readonly entries = new Map<string, Entry>();
  private readonly watches = new Set<Watch>();
  private readonly now: () => number;
  private readonly createId: () => string;
  private byteLength = 0;
  private closed = false;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: SourceIconCacheOptions) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
  }

  private authority(sessionId: string): string | null {
    if (this.closed) return null;
    try {
      return this.options.authorityForSession(sessionId);
    } catch {
      return null;
    }
  }

  /** Capture before a successful-read refinement is queued; recheck on commit. */
  grant(sessionId: string): string | null {
    return this.authority(sessionId);
  }

  /** Only a bounded PNG returned by the isolated decoder may be committed. */
  put(sessionId: string, authority: string, origin: string, bytes: Uint8Array): string | null {
    if (this.closed || this.authority(sessionId) !== authority || !isCanonicalSourceOrigin(origin))
      return null;
    if (bytes.byteLength < 33 || bytes.byteLength > MAX_IMAGE_BYTES) return null;
    const png = Buffer.from(bytes);
    if (!png.subarray(0, 8).equals(PNG) || png.toString("ascii", 12, 16) !== "IHDR") return null;
    if (
      png.readUInt32BE(16) < 1 ||
      png.readUInt32BE(16) > 64 ||
      png.readUInt32BE(20) < 1 ||
      png.readUInt32BE(20) > 64
    )
      return null;
    this.prune();
    for (const entry of this.entries.values()) {
      if (
        entry.sessionId === sessionId &&
        entry.authority === authority &&
        entry.origin === origin
      ) {
        if (Buffer.from(entry.bytes).equals(png)) return entry.id;
        this.remove(entry);
      }
    }
    const id = this.createId();
    // Host-minted namespace only; never accept a filename or renderer id.
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ||
      this.entries.has(id)
    )
      return null;
    const entry: Entry = {
      id,
      sessionId,
      authority,
      origin,
      expiresAt: this.now() + MAX_AGE_MS,
      bytes: Uint8Array.from(bytes),
    };
    this.entries.set(id, entry);
    this.byteLength += entry.bytes.byteLength;
    while (this.entries.size > MAX_ENTRIES || this.byteLength > MAX_BYTES) {
      const oldest = this.entries.values().next().value;
      if (oldest === undefined) break;
      this.remove(oldest);
    }
    this.scheduleExpiry();
    this.refreshWatches();
    return id;
  }

  private remove(entry: Entry): void {
    if (!this.entries.delete(entry.id)) return;
    this.byteLength -= entry.bytes.byteLength;
  }

  private prune(): void {
    const now = this.now();
    const authorities = new Map<string, string | null>();
    for (const entry of this.entries.values()) {
      if (!authorities.has(entry.sessionId))
        authorities.set(entry.sessionId, this.authority(entry.sessionId));
      if (entry.expiresAt <= now || authorities.get(entry.sessionId) !== entry.authority)
        this.remove(entry);
    }
    this.scheduleExpiry();
  }

  private scheduleExpiry(): void {
    if (this.expiryTimer !== undefined) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    if (this.closed || this.entries.size === 0) return;
    const firstExpiry = Math.min(...Array.from(this.entries.values(), (entry) => entry.expiresAt));
    this.expiryTimer = setTimeout(
      () => {
        this.expiryTimer = undefined;
        this.prune();
        this.refreshWatches();
      },
      Math.max(1, firstExpiry - this.now()),
    );
    this.expiryTimer.unref();
  }

  /** Also called on a host authority transition; never renews or fetches data. */
  invalidate(): void {
    this.prune();
    this.refreshWatches();
  }

  private snapshot(input: SourceIconsWatchInput, authority: string | null): SourceIconsSnapshot {
    const current = this.authority(input.sessionId);
    const pictures = new Map<string, string>();
    const now = this.now();
    if (authority !== null && current === authority) {
      for (const entry of this.entries.values()) {
        if (
          entry.sessionId === input.sessionId &&
          entry.authority === authority &&
          entry.expiresAt > now
        )
          pictures.set(entry.origin, entry.id);
      }
    }
    return {
      icons: input.origins.map((origin) => ({
        origin,
        registrableDomain: registrableDomainForOrigin(origin),
        pictureId: pictures.get(origin) ?? null,
      })),
    };
  }

  /** Session-bound image delivery uses the existing nullable picture shape. */
  picture(
    sessionId: string,
    pictureId: string,
    offset = 0,
  ): {
    data: string | null;
    mimeType: string | null;
    nextOffset: number | null;
  } {
    this.prune();
    const entry = this.entries.get(pictureId);
    if (
      entry === undefined ||
      entry.sessionId !== sessionId ||
      this.authority(sessionId) !== entry.authority ||
      offset !== 0
    )
      return ABSENT;
    return {
      data: Buffer.from(entry.bytes).toString("base64"),
      mimeType: "image/png",
      nextOffset: null,
    };
  }

  /** Initial snapshot + cache changes/expiry only; no acquisition port exists here. */
  watch(input: SourceIconsWatchInput, emit: (snapshot: SourceIconsSnapshot) => void): () => void {
    if (this.closed || this.watches.size >= MAX_WATCHES)
      throw new Error("Source icon cache unavailable");
    if (
      input.origins.length > SOURCE_ICON_ORIGIN_LIMIT ||
      !input.origins.every(isCanonicalSourceOrigin)
    )
      throw new Error("Invalid source origins");
    const watch: Watch = {
      input: { sessionId: input.sessionId, origins: [...new Set(input.origins)] },
      authority: this.authority(input.sessionId),
      emit,
      timer: undefined,
      last: undefined,
      closed: false,
    };
    this.watches.add(watch);
    try {
      this.refresh(watch);
    } catch (error) {
      this.stop(watch);
      throw error;
    }
    return () => this.stop(watch);
  }

  private stop(watch: Watch): void {
    watch.closed = true;
    if (watch.timer !== undefined) clearTimeout(watch.timer);
    watch.timer = undefined;
    this.watches.delete(watch);
  }

  private refresh(watch: Watch): void {
    if (watch.closed) return;
    if (watch.timer !== undefined) clearTimeout(watch.timer);
    watch.timer = undefined;
    const snapshot = this.snapshot(watch.input, watch.authority);
    const json = JSON.stringify(snapshot);
    if (watch.last !== json) {
      watch.last = json;
      watch.emit(snapshot);
    }
    if (watch.closed) return;
    if (this.authority(watch.input.sessionId) !== watch.authority || watch.authority === null)
      return this.stop(watch);
    // A bounded watch also catches revocation if a host missed an explicit
    // invalidation. Every byte read independently checks the live epoch.
    watch.timer = setTimeout(() => {
      try {
        this.refresh(watch);
      } catch {
        this.stop(watch);
      }
    }, 1_000);
    watch.timer.unref();
  }

  private refreshWatches(): void {
    // A listener may reenter watch(); new subscriptions are not part of this emission.
    for (const watch of Array.from(this.watches)) {
      try {
        this.refresh(watch);
      } catch {
        this.stop(watch);
      }
    }
  }

  close(): void {
    this.closed = true;
    if (this.expiryTimer !== undefined) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    for (const watch of this.watches) this.stop(watch);
    this.entries.clear();
    this.byteLength = 0;
  }
}
