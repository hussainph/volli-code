/**
 * Bounded, disposable decoration, kept apart from browser screenshots and the
 * durable ledger. Reads and watches ONLY project bytes already held here.
 * Successful live reads are the sole producer of put() calls; neither
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
import type { SourceIconPersistence, StoredSourceIcon } from "./storage";

const MAX_ENTRIES = 256;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_IMAGE_BYTES = 64 * 1024;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_WATCHES = 128;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ABSENT = { data: null, mimeType: null, nextOffset: null } as const;

interface Entry extends StoredSourceIcon {
  /** Stable owner grant captured at commit, never rebound from a later account. */
  persistentAuthority: string | null;
  generation: string;
}

interface DeferredEntry extends StoredSourceIcon {
  generation: string;
  /** Cold disk rows have no live grant; temporary live rows retain theirs. */
  liveAuthority: string | null;
}

function boundedPng(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 33 || bytes.byteLength > MAX_IMAGE_BYTES) return false;
  const png = Buffer.from(bytes);
  return (
    png.subarray(0, 8).equals(PNG) &&
    png.toString("ascii", 12, 16) === "IHDR" &&
    png.readUInt32BE(16) >= 1 &&
    png.readUInt32BE(16) <= 64 &&
    png.readUInt32BE(20) >= 1 &&
    png.readUInt32BE(20) <= 64
  );
}

interface Watch {
  input: SourceIconsWatchInput;
  authority: string | null;
  /** Only a watch born without a grant may bind its first grant later. */
  restoring: boolean;
  generation: string | null;
  emit(snapshot: SourceIconsSnapshot): void;
  timer: ReturnType<typeof setTimeout> | undefined;
  last: string | undefined;
  closed: boolean;
}

export interface SourceIconCacheOptions {
  /**
   * Live, host-owned access epoch, incorporating person/workspace/Session
   * ownership. Null denies access. Definitive revocation or owner changes MUST
   * produce a different epoch, including same-account re-login. Explicitly
   * temporary uncertainty may return null, then restore that SAME grant.
   */
  authorityForSession(sessionId: string): string | null;
  /** Same known sign-in across relaunch; null disables persistence for unknown ownership. */
  persistentAuthorityForSession?(sessionId: string): string | null;
  /** Unknown startup identity is not a mismatch or revocation. No I/O here. */
  restorationPendingForSession?(sessionId: string): boolean;
  /** Irreversible, decoration-only revocation evidence; never persisted. */
  revocationGeneration?(): string;
  now?: () => number;
  createId?: () => string;
  persistence?: SourceIconPersistence;
}

export class SourceIconCache {
  private readonly entries = new Map<string, Entry>();
  private readonly watches = new Set<Watch>();
  private readonly now: () => number;
  private readonly createId: () => string;
  private byteLength = 0;
  private closed = false;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private loaded = false;
  private readonly deferred = new Map<string, DeferredEntry>();
  private restorationTimer: ReturnType<typeof setTimeout> | undefined;
  // Until the initial read finishes, remember sources changed by live work so
  // a delayed snapshot cannot resurrect the superseded record.
  private readonly liveSources = new Set<string>();
  private hydrationConflictsOverflowed = false;
  readonly hydrated: Promise<void>;

  constructor(private readonly options: SourceIconCacheOptions) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
    this.hydrated = options.persistence === undefined ? Promise.resolve() : this.hydrate();
  }

  private async hydrate(): Promise<void> {
    // Capture before load's first await, even when no row or live grant is yet
    // known. A refusal/recovery during I/O must not revive that old snapshot.
    const generation = this.generation();
    try {
      const stored = await this.options.persistence!.load();
      if (
        this.closed ||
        this.hydrationConflictsOverflowed ||
        generation === null ||
        this.generation() !== generation
      )
        return;
      for (const entry of stored
        .slice(0, MAX_ENTRIES)
        .toSorted((a, b) => a.expiresAt - b.expiresAt)) {
        if (
          !boundedPng(entry.bytes) ||
          !isCanonicalSourceOrigin(entry.origin) ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entry.id) ||
          this.entries.has(entry.id) ||
          this.liveSources.has(this.sourceKey(entry.sessionId, entry.origin)) ||
          !Number.isFinite(entry.expiresAt) ||
          entry.expiresAt <= this.now() ||
          entry.expiresAt > this.now() + MAX_AGE_MS ||
          this.entries.size + this.deferred.size >= MAX_ENTRIES ||
          this.byteLength +
            Array.from(this.deferred.values()).reduce((sum, row) => sum + row.bytes.byteLength, 0) +
            entry.bytes.byteLength >
            MAX_BYTES
        )
          continue;
        this.deferred.set(entry.id, {
          ...entry,
          bytes: Uint8Array.from(entry.bytes),
          generation,
          liveAuthority: null,
        });
      }
    } catch {
      /* An unavailable cache keeps the truthful fallback. */
    } finally {
      this.loaded = true;
      this.liveSources.clear();
      if (!this.closed) {
        this.restoreDeferred();
        this.persist();
        this.refreshWatches();
      }
    }
  }

  private generation(): string | null {
    try {
      return this.options.revocationGeneration?.() ?? "unversioned-local-host";
    } catch {
      return null;
    }
  }

  private sourceKey(sessionId: string, origin: string): string {
    return JSON.stringify([sessionId, origin]);
  }

  private restorationPending(sessionId: string): boolean {
    try {
      return this.options.restorationPendingForSession?.(sessionId) === true;
    } catch {
      return true;
    }
  }

  private restoreDeferred(): void {
    if (this.restorationTimer !== undefined) clearTimeout(this.restorationTimer);
    this.restorationTimer = undefined;
    if (this.closed) return;
    const generation = this.generation();
    for (const entry of this.deferred.values()) {
      if (entry.expiresAt <= this.now() || generation === null || entry.generation !== generation) {
        this.deferred.delete(entry.id);
        continue;
      }
      // Keep bytes inert while the host is still resolving its saved identity.
      // A known mismatch or an explicit revocation, unlike startup, drops them.
      if (this.restorationPending(entry.sessionId)) continue;
      this.deferred.delete(entry.id);
      const authority = this.authority(entry.sessionId);
      if (
        authority === null ||
        (entry.liveAuthority !== null && entry.liveAuthority !== authority) ||
        this.persistentAuthority(entry.sessionId) !== entry.authority ||
        this.entries.has(entry.id) ||
        Array.from(this.entries.values()).some(
          (live) => live.sessionId === entry.sessionId && live.origin === entry.origin,
        )
      )
        continue;
      this.entries.set(entry.id, { ...entry, authority, persistentAuthority: entry.authority });
      this.byteLength += entry.bytes.byteLength;
    }
    this.scheduleExpiry();
    if (this.deferred.size !== 0) {
      this.restorationTimer = setTimeout(() => {
        this.restorationTimer = undefined;
        const before = this.deferred.size;
        this.restoreDeferred();
        // Offline restoration may stay unresolved for a long time. Polling a
        // bounded inert set must not rewrite it (or spawn I/O) every second.
        if (before !== this.deferred.size) {
          this.persist();
          this.refreshWatches();
        }
      }, 1_000);
      this.restorationTimer.unref();
    }
  }

  private persist(): void {
    // Never publish an empty/partial replacement while the disk read is pending.
    if (this.closed || !this.loaded) return;
    try {
      const live: StoredSourceIcon[] = Array.from(this.entries.values()).flatMap((entry) =>
        entry.persistentAuthority === null
          ? []
          : [
              {
                id: entry.id,
                sessionId: entry.sessionId,
                origin: entry.origin,
                expiresAt: entry.expiresAt,
                bytes: entry.bytes,
                authority: entry.persistentAuthority,
              },
            ],
      );
      const inert: StoredSourceIcon[] = Array.from(this.deferred.values(), (entry) => ({
        id: entry.id,
        sessionId: entry.sessionId,
        origin: entry.origin,
        expiresAt: entry.expiresAt,
        bytes: entry.bytes,
        authority: entry.authority,
      }));
      this.options.persistence?.save([...live, ...inert]);
    } catch {
      /* Optional decoration. */
    }
  }

  private authority(sessionId: string): string | null {
    if (this.closed || this.generation() === null || this.restorationPending(sessionId))
      return null;
    try {
      return this.options.authorityForSession(sessionId);
    } catch {
      return null;
    }
  }

  private persistentAuthority(sessionId: string): string | null {
    if (this.closed) return null;
    try {
      return this.options.persistentAuthorityForSession === undefined
        ? this.authority(sessionId)
        : this.options.persistentAuthorityForSession(sessionId);
    } catch {
      return null;
    }
  }

  /** Capture before a foreground read first yields; recheck on acquisition/commit. */
  grant(sessionId: string): string | null {
    return this.authority(sessionId);
  }

  /** Internal refinement check. Like watch(), this never acquires anything. */
  has(sessionId: string, authority: string, origin: string): boolean {
    this.prune();
    return (
      this.authority(sessionId) === authority &&
      Array.from(this.entries.values()).some(
        (entry) =>
          entry.sessionId === sessionId && entry.authority === authority && entry.origin === origin,
      )
    );
  }

  /** Only a bounded PNG returned by the isolated decoder may be committed. */
  put(sessionId: string, authority: string, origin: string, bytes: Uint8Array): string | null {
    const generation = this.generation();
    if (
      generation === null ||
      this.closed ||
      this.authority(sessionId) !== authority ||
      !isCanonicalSourceOrigin(origin)
    )
      return null;
    if (!boundedPng(bytes)) return null;
    const png = Buffer.from(bytes);
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
      this.entries.has(id) ||
      this.deferred.has(id)
    )
      return null;
    const entry: Entry = {
      id,
      sessionId,
      authority,
      persistentAuthority: this.persistentAuthority(sessionId),
      generation,
      origin,
      expiresAt: this.now() + MAX_AGE_MS,
      bytes: Uint8Array.from(bytes),
    };
    if (
      !this.loaded &&
      !this.hydrationConflictsOverflowed &&
      this.options.persistence !== undefined
    ) {
      this.liveSources.add(this.sourceKey(sessionId, origin));
      // A bounded cache must not hide an unbounded hydration conflict journal.
      if (this.liveSources.size > MAX_ENTRIES) {
        this.hydrationConflictsOverflowed = true;
        this.liveSources.clear();
      }
    }
    for (const held of this.deferred.values()) {
      if (held.sessionId === sessionId && held.origin === origin) this.deferred.delete(held.id);
    }
    this.entries.set(id, entry);
    this.byteLength += entry.bytes.byteLength;
    while (
      this.entries.size + this.deferred.size > MAX_ENTRIES ||
      this.byteLength +
        Array.from(this.deferred.values()).reduce((sum, row) => sum + row.bytes.byteLength, 0) >
        MAX_BYTES
    ) {
      const deferred = this.deferred.keys().next().value;
      if (deferred !== undefined) {
        this.deferred.delete(deferred);
        continue;
      }
      const oldest = this.entries.values().next().value;
      if (oldest === undefined) break;
      this.remove(oldest);
    }
    this.scheduleExpiry();
    this.persist();
    this.refreshWatches();
    return id;
  }

  private remove(entry: Entry): void {
    if (!this.entries.delete(entry.id)) return;
    this.byteLength -= entry.bytes.byteLength;
  }

  private prune(): void {
    const before = this.entries.size;
    const now = this.now();
    const authorities = new Map<string, string | null>();
    const generation = this.generation();
    for (const entry of this.entries.values()) {
      if (!authorities.has(entry.sessionId))
        authorities.set(entry.sessionId, this.authority(entry.sessionId));
      if (
        entry.expiresAt <= now ||
        entry.generation !== generation ||
        authorities.get(entry.sessionId) !== entry.authority
      ) {
        this.remove(entry);
        if (
          entry.expiresAt > now &&
          entry.generation === generation &&
          this.restorationPending(entry.sessionId) &&
          entry.persistentAuthority !== null
        ) {
          // Temporary identity uncertainty closes delivery but is not evidence
          // that the saved sign-in was revoked. Keep its bounded record inert.
          this.deferred.set(entry.id, {
            ...entry,
            authority: entry.persistentAuthority,
            liveAuthority: entry.authority,
          });
        }
      }
    }
    this.restoreDeferred();
    if (before !== this.entries.size) this.persist();
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
    this.restoreDeferred();
    this.prune();
    this.persist();
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
          entry.generation === this.generation() &&
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
      restoring: this.restorationPending(input.sessionId),
      generation: this.generation(),
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
    const revoked = watch.generation === null || watch.generation !== this.generation();
    const pending = this.restorationPending(watch.input.sessionId);
    if (!revoked && watch.restoring && !pending) {
      // Only a watch born without a grant may bind its first one. A known
      // watch keeps its ORIGINAL grant across explicitly temporary uncertainty.
      watch.restoring = false;
      watch.authority = this.authority(watch.input.sessionId);
    }
    const snapshot = this.snapshot(watch.input, revoked || pending ? null : watch.authority);
    const json = JSON.stringify(snapshot);
    if (watch.last !== json) {
      watch.last = json;
      watch.emit(snapshot);
    }
    if (watch.closed) return;
    if (
      revoked ||
      (!pending &&
        (this.authority(watch.input.sessionId) !== watch.authority || watch.authority === null))
    )
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
    if (this.restorationTimer !== undefined) clearTimeout(this.restorationTimer);
    this.restorationTimer = undefined;
    this.deferred.clear();
    this.liveSources.clear();
    if (this.expiryTimer !== undefined) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    for (const watch of this.watches) this.stop(watch);
    this.entries.clear();
    this.byteLength = 0;
  }
}
