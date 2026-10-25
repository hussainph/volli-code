/** Runner-produced bodies reach staging before the facts that make them visible. */
import {
  canonicalJson,
  type SessionEngine,
  type TranscriptArtifactStore,
} from "@volli/session-engine";
import type { SessionEvent } from "@volli/shared";
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
import { TranscriptSpool, type SpoolRedaction } from "../transcript-spool/transcript-spool";

interface ProducerConnection {
  link: BackendLink;
  runnerId: string;
  runnerToken?: () => Promise<string | null>;
}

/** Uses the durable local file store unchanged; no new on-disk format or weaker flush. */
export function createCloudTranscriptPublisher(options: {
  current(): ProducerConnection | null;
  artifacts(): TranscriptArtifactStore | null;
  engine: Pick<SessionEngine, "getBaseSession">;
  ledger: DrainLedger;
  cursors: DrainCursorStore;
  redaction: SpoolRedaction;
  backendUrl: string;
}): AcceptCall {
  const functions = createCloudFunctionsClient({ url: options.backendUrl });
  const current = () => {
    const live = options.current();
    if (live === null || live.link.status.state !== "connected") {
      throw new CloudOfflineError("link_down", "This runner is offline.", "not_sent");
    }
    return live;
  };
  const spools = new WeakMap<ProducerConnection, TranscriptSpool>();
  const spoolFor = (live: ProducerConnection) => {
    const held = spools.get(live);
    if (held !== undefined) return held;
    const connected = () => {
      if (options.current() !== live) {
        throw new CloudOfflineError("link_down", "This runner's connection changed.", "not_sent");
      }
      return current();
    };
    const spool = new TranscriptSpool({
      artifacts: {
        async readCanonicalBytes(reference) {
          const artifacts = options.artifacts();
          if (artifacts === null) throw new Error("Session history storage is not ready.");
          return Buffer.from(canonicalJson(await artifacts.read(reference)), "utf8");
        },
        // FileTranscriptArtifactStore syncs the body and directory before write
        // returns, unlike the spool's optional batched-durability store.
        flush: async () => {},
      },
      objects: new PresignedObjectStore({
        async presignPut(input) {
          const producer = connected();
          const token = await producer.runnerToken?.();
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
          return (await link.query("transcripts:head", { ...input })) as SessionUploadHead;
        },
        stageArtifacts: (input) =>
          connected().link.mutate("transcripts:stageArtifacts", { ...input }),
        commitSegment: async (input) =>
          (await connected().link.mutate("transcripts:commitSegment", {
            ...input,
          })) as SegmentCommitResult,
        commitPiLogSegment: async (input) =>
          (await connected().link.mutate("transcripts:commitPiLogSegment", {
            ...input,
          })) as SegmentCommitResult,
      },
      events: {
        acceptedThrough: (sessionId) => options.cursors.get(sessionId)?.acceptedThrough ?? 0,
        eventsAfter: (sessionId, afterSequence, limit) =>
          options.ledger.listEvents({ sessionId, afterSequence, limit }),
      },
      redaction: options.redaction,
    });
    spools.set(live, spool);
    return spool;
  };

  return async (args, callOptions) => {
    const live = current();
    const events = args.events.map((event) => JSON.parse(event) as SessionEvent);
    const firstBody = events.findIndex((event) => event.payload.kind === "transcript.referenced");
    if (firstBody < 0) return acceptOverLink(live.link)(args, callOptions);
    const session = await options.engine.getBaseSession({ sessionId: args.sessionId });
    const cursor = options.cursors.get(args.sessionId);
    if (session === null || cursor === null || cursor.generation !== args.generation) {
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
}
