/** Runner-produced bodies reach staging before the facts that make them visible. */
import {
  canonicalJson,
  type SessionEngine,
  type TranscriptArtifactStore,
} from "@volli/session-engine";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { LOCAL_RUNNER, type SessionEvent } from "@volli/shared";
import { STRUCTURED_ADAPTER_ID } from "../session-runtime/sessions";
import type {
  SessionUploadGrant,
  SessionUploadHead,
  SegmentCommitResult,
} from "@volli/shared/cloud";
import type { BackendLink } from "../cloud-runner/backend-link";
import type { AcceptCall, DrainCursorStore, DrainLedger } from "../cloud-runner/drain";
import { acceptOverLink } from "../cloud-runner/sync";
import { createCloudFunctionsClient, CloudOfflineError } from "../cloud-agent/functions-client";
import { PresignedObjectStore } from "../transcript-spool/object-store";
import {
  TranscriptSpool,
  SpoolRedactionUnavailableError,
  piFileIdOf,
  type PiLogFile,
  type SpoolRedaction,
} from "../transcript-spool/transcript-spool";

interface ProducerConnection {
  link: BackendLink;
  runnerId: string;
  runnerToken?: () => Promise<string | null>;
}

type PackReport = Awaited<ReturnType<TranscriptSpool["packTurn"]>>;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Stop waiting on a link call when its producer closes; its eventual ack is harmless. */
function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return work;
  return new Promise<T>((complete, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    work.then(complete, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

/** Uses the durable local file store unchanged; no new on-disk format or weaker flush. */
export function createCloudTranscriptPublisher(options: {
  current(): ProducerConnection | null;
  artifacts(): TranscriptArtifactStore | null;
  engine: Pick<SessionEngine, "getBaseSession" | "getSession">;
  ownerUserId: string;
  piDirectory(): string;
  ledger: DrainLedger;
  cursors: DrainCursorStore;
  redaction: SpoolRedaction;
  backendUrl: string;
}): AcceptCall & { pack(sessionId: string, signal: AbortSignal): Promise<PackReport> } {
  const current = () => {
    const live = options.current();
    if (live === null || live.link.status.state !== "connected") {
      throw new CloudOfflineError("link_down", "This runner is offline.", "not_sent");
    }
    return live;
  };
  const spools = new WeakMap<ProducerConnection, TranscriptSpool>();
  const spoolFor = (
    live: ProducerConnection,
    signal?: AbortSignal,
    sessionId?: string,
    generation?: number,
  ) => {
    signal?.throwIfAborted();
    const held = signal === undefined ? spools.get(live) : undefined;
    if (held !== undefined) return held;
    const functions = createCloudFunctionsClient({
      url: options.backendUrl,
      fetch: (url, init) =>
        fetch(url, {
          ...init,
          ...(signal === undefined
            ? {}
            : {
                signal: AbortSignal.any([signal, ...(init.signal ? [init.signal] : [])]),
              }),
        }),
    });
    const connected = () => {
      signal?.throwIfAborted();
      if (!options.redaction.complete()) throw new SpoolRedactionUnavailableError();
      if (sessionId !== undefined) {
        const cursor = options.cursors.get(sessionId);
        if (
          cursor?.ownerUserId !== options.ownerUserId ||
          cursor.blocked !== null ||
          cursor.generation !== generation
        ) {
          throw new Error("This runner no longer holds the Session's local claim.");
        }
      }
      if (options.current() !== live) {
        throw new CloudOfflineError("link_down", "This runner's connection changed.", "not_sent");
      }
      return current();
    };
    const spool = new TranscriptSpool({
      artifacts: {
        async readCanonicalBytes(reference) {
          connected();
          const artifacts = options.artifacts();
          if (artifacts === null) throw new Error("Session history storage is not ready.");
          const body = await artifacts.read(reference);
          connected();
          return Buffer.from(canonicalJson(body), "utf8");
        },
        // FileTranscriptArtifactStore syncs the body and directory before write
        // returns, unlike the spool's optional batched-durability store.
        flush: async () => {},
      },
      objects: new PresignedObjectStore({
        fetch: (url, init) => {
          connected();
          return fetch(url, {
            ...init,
            ...(signal === undefined
              ? {}
              : {
                  signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]),
                }),
          });
        },
        async presignPut(input) {
          const producer = connected();
          const token = await abortable(producer.runnerToken?.() ?? Promise.resolve(null), signal);
          connected();
          if (token == null || options.current() !== producer) {
            throw new CloudOfflineError("link_down", "This runner is not linked.", "not_sent");
          }
          return (await functions.call(
            "action",
            "files:presignPut",
            input,
            token,
          )) as SessionUploadGrant;
        },
      }),
      backend: {
        async head(input) {
          const { link } = connected();
          if (link.query === undefined) throw new Error("Session history reads are unavailable.");
          return (await abortable(
            link.query("transcripts:head", { ...input }),
            signal,
          )) as SessionUploadHead;
        },
        stageArtifacts: (input) =>
          connected().link.mutate("transcripts:stageArtifacts", { ...input }),
        commitSegment: async (input) =>
          (await abortable(
            connected().link.mutate(
              "transcripts:commitSegment",
              {
                ...input,
              },
              { priority: "backlog" },
            ),
            signal,
          )) as SegmentCommitResult,
        commitPiLogSegment: async (input) =>
          (await abortable(
            connected().link.mutate(
              "transcripts:commitPiLogSegment",
              {
                ...input,
              },
              { priority: "backlog" },
            ),
            signal,
          )) as SegmentCommitResult,
      },
      events: {
        acceptedThrough: (id) => {
          connected();
          return options.cursors.get(id)?.acceptedThrough ?? 0;
        },
        eventsAfter: (id, afterSequence, limit) => {
          connected();
          return options.ledger.listEvents({ sessionId: id, afterSequence, limit });
        },
      },
      redaction: options.redaction,
    });
    if (signal === undefined) spools.set(live, spool);
    return spool;
  };

  const accept: AcceptCall = async (args, callOptions) => {
    const live = current();
    const events = args.events.map((event) => JSON.parse(event) as SessionEvent);
    const firstBody = events.findIndex((event) => event.payload.kind === "transcript.referenced");
    if (firstBody < 0) return acceptOverLink(live.link)(args, callOptions);
    const session = await options.engine.getBaseSession({ sessionId: args.sessionId });
    const cursor = options.cursors.get(args.sessionId);
    if (
      session === null ||
      cursor === null ||
      cursor.ownerUserId !== options.ownerUserId ||
      cursor.generation !== args.generation
    ) {
      throw new Error("This runner no longer holds the Session's local claim.");
    }
    // An offline birth can share a backlog batch with its first reply. The
    // producer API requires a registered Session and claim, so publish the
    // prefix first. If staging fails, the reference remains unsent; a retry
    // safely replays that already accepted prefix.
    let prefix: Awaited<ReturnType<AcceptCall>> | null = null;
    if (firstBody > 0) {
      prefix = await acceptOverLink(live.link)(
        { ...args, events: args.events.slice(0, firstBody) },
        callOptions,
      );
    }
    try {
      await spoolFor(live).stage(
        {
          sessionId: args.sessionId,
          projectId: session.projectId,
          claim: { runnerId: live.runnerId, generation: args.generation },
        },
        events.slice(firstBody),
      );
    } catch (error) {
      // A lost producer claim is not a network retry. Use the drain's existing
      // fenced stop; a later explicit adoption of a new generation clears it.
      const code = (error as { data?: { code?: unknown } } | null)?.data?.code;
      if (code === "stale_claim" || code === "not_claimed") {
        throw Object.assign(new Error("This runner no longer holds the Session's claim."), {
          data: { code: "fenced", message: "This runner no longer holds the Session's claim." },
        });
      }
      throw error;
    }
    if (options.current() !== live) {
      throw new CloudOfflineError("link_down", "This runner's connection changed.", "not_sent");
    }
    const result = await acceptOverLink(live.link)(
      { ...args, events: args.events.slice(firstBody) },
      callOptions,
    );
    return {
      ...result,
      duplicates: result.duplicates + (prefix?.duplicates ?? 0),
      quarantined: result.quarantined + (prefix?.quarantined ?? 0),
    };
  };
  return Object.assign(accept, {
    async pack(sessionId: string, signal: AbortSignal): Promise<PackReport> {
      signal.throwIfAborted();
      const live = current();
      const cursor = options.cursors.get(sessionId);
      if (cursor === null || cursor.ownerUserId !== options.ownerUserId || cursor.blocked !== null)
        throw new Error("This runner no longer holds the Session's local claim.");
      const session = await abortable(options.engine.getSession({ sessionId }), signal);
      if (session === null || session.session.ownerUserId !== options.ownerUserId)
        throw new Error("This runner does not own the Session.");
      const files: PiLogFile[] = [];
      const seen = new Set<string>();
      for (const attachment of session.attachments) {
        signal.throwIfAborted();
        if (
          attachment.adapterId !== STRUCTURED_ADAPTER_ID ||
          (attachment.venue.id !== live.runnerId &&
            !(
              attachment.venue.id === LOCAL_RUNNER.id && attachment.venue.kind === LOCAL_RUNNER.kind
            ))
        )
          continue;
        const detail = attachment.native?.detail;
        if (!record(detail) || detail.kind !== "volli.native-binding.v1") continue;
        const locator = detail.locator;
        if (
          !record(locator) ||
          locator.runtime !== "pi" ||
          typeof locator.sessionId !== "string" ||
          locator.sessionId.length === 0 ||
          locator.sessionId !== attachment.native?.id ||
          typeof locator.sessionFilePath !== "string"
        )
          continue;
        // Read only Pi's runner-owned directory, never a path supplied by a tool.
        // Keep the original path: the spool's descriptor open refuses symlinks.
        const lexicalRoot = resolve(options.piDirectory());
        const within = relative(lexicalRoot, resolve(locator.sessionFilePath));
        const parts = within.split(sep);
        if (
          !isAbsolute(locator.sessionFilePath) ||
          parts.length !== 2 ||
          !parts[0]!.startsWith("--") ||
          !parts[0]!.endsWith("--") ||
          !parts[1]!.endsWith(".jsonl")
        )
          throw new Error("A Pi session file is outside the runner's history layout.");
        let root: string;
        try {
          root = await realpath(lexicalRoot);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          root = lexicalRoot; // missing history is reported without blocking transcript packs
        }
        try {
          if ((await lstat(dirname(locator.sessionFilePath))).isSymbolicLink())
            throw new Error("A Pi history directory is a symbolic link.");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        let path: string;
        try {
          path = await realpath(locator.sessionFilePath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          path = resolve(root, within); // the spool reports a missing file
        }
        const inside = relative(root, path);
        if (
          !isAbsolute(locator.sessionFilePath) ||
          inside === ".." ||
          inside.startsWith(`..${sep}`) ||
          isAbsolute(inside)
        )
          throw new Error("A Pi session file is outside the runner's history directory.");
        const fileId = piFileIdOf(path);
        if (seen.has(fileId)) continue;
        seen.add(fileId);
        files.push({ attachmentId: attachment.id, path: locator.sessionFilePath });
      }
      signal.throwIfAborted();
      return spoolFor(live, signal, sessionId, cursor.generation).packTurn(
        {
          sessionId,
          projectId: session.session.projectId,
          claim: { runnerId: live.runnerId, generation: cursor.generation },
        },
        files,
      );
    },
  });
}
