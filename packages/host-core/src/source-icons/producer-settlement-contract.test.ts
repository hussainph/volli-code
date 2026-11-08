/**
 * One deterministic counterexample to a whole-pipeline readiness poll, then
 * the unchanged IPC-only delivery poll AFTER an actual started job settles.
 * Earlier failing-run evidence remains separate: this counterexample cannot
 * recover that run's uncaptured failure stage.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import * as agentRuntime from "@volli/agent-runtime";
import { createSourceIconFetch, createWorkerSourceIconDecoder } from "@volli/agent-runtime";
import type { WebRequestOptions } from "../../../agent-runtime/src/web/safe-fetch";
import { ipcContractLink } from "../../../host-protocol/src/testing/index";
import { createSessionRouter, RpcDiagnosticLog } from "../../../session-rpc/src/index";
import { createDesktopRouter } from "../../../session-rpc/src/desktop-router";
import { LOCAL_DESKTOP_CALLER } from "../../../session-rpc/src/catalog";
import type { SourceIconsSnapshot } from "@volli/shared";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { webPortsFor } from "../web/ports";
import { SourceIconCache } from "./cache";
import { SourceIconDisk } from "./storage";
import { SourceIconRefiner } from "./refiner";
import { createHostHandlers } from "../handlers/host-handlers";
import { admittedHandlers } from "../handlers/handler-map";
import { ROUTER_POLICY } from "../handlers/policies";
import type { RuntimeAutomations } from "../session-runtime/automations";

// Self-authored PNG scanlines, using the real native codec in the worker.
// The acquisition suite additionally generates all three formats with sharp.
import { crc32, deflateSync } from "node:zlib";
function chunk(name: string, bytes: Buffer): Buffer {
  const type = Buffer.from(name);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, bytes])));
  return Buffer.concat([length, type, bytes, crc]);
}
function png(): Buffer {
  const dimensions = Buffer.alloc(13);
  dimensions.writeUInt32BE(1, 0);
  dimensions.writeUInt32BE(1, 4);
  dimensions[8] = 8;
  dimensions[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", dimensions),
    chunk("IDAT", deflateSync(Buffer.from([0, 192, 122, 66, 255]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});
const AUTHORITY = "a".repeat(64);
const ORIGIN = "http://source.example.com";

async function connections(cache: SourceIconCache, root: string) {
  const handlers = admittedHandlers(
    createHostHandlers(
      {
        events: { publish: () => {} },
        attention: { deliver: () => ({ delivered: true }), focusedSessionIds: () => new Set() },
      } as never,
      {
        db: null,
        dataDir: root,
        runtime: null,
        sessions: null,
        modelAccess: null,
        experiments: null,
        automations: { kind: "degraded" } as RuntimeAutomations,
        busyWorktreeSites: async () => [],
        worktreeReads: null,
        sourceIcons: cache,
      },
    ),
    ROUTER_POLICY,
  );
  const context = () => ({
    caller: LOCAL_DESKTOP_CALLER,
    transport: "electron-ipc" as const,
    diagnostics: new RpcDiagnosticLog(),
    handlers,
  });
  const icons = await ipcContractLink({
    router: createDesktopRouter(),
    createContext: context,
  }).open(undefined);
  const pictures = await ipcContractLink({
    router: createSessionRouter(),
    createContext: context,
  }).open(undefined);
  cleanup.push(
    () => icons.close(),
    () => pictures.close(),
  );
  return { icons: icons.client, pictures: pictures.client };
}

it("distinguishes a legal gated acquisition from an IPC delivery deadline", async () => {
  const parent = fileURLToPath(new URL("../../../../.tmp/", import.meta.url));
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "source-icon-producer-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const paths: string[] = [];
  const iconRequested = Promise.withResolvers<void>();
  const releaseIcon = Promise.withResolvers<void>();
  const acquireStarted = Promise.withResolvers<number>();
  let acquireSignal: AbortSignal | undefined;
  cleanup.push(() => releaseIcon.resolve());
  const server = http.createServer((request, response) => {
    paths.push(request.url ?? "");
    if (request.url === "/doc") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        '<html><head><link rel="icon" href="/icon"></head><body><p>Readable source document.</p></body></html>',
      );
    } else {
      iconRequested.resolve();
      // Real socket, HTTP parsing and PNG bytes. Withhold ONLY the response;
      // no fake clock, decoder, authority, pinning or transport deadline.
      void releaseIcon.promise.then(() => {
        if (response.destroyed) return;
        response.writeHead(200, { "content-type": "image/png" });
        response.end(png());
      });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const { port } = server.address() as AddressInfo;
  const transport = {
    resolve: async () => [{ address: "93.184.216.34", family: 4 as const }],
    open: (_scheme: "http" | "https", options: WebRequestOptions) =>
      http.request({
        ...options,
        protocol: "http:",
        port,
        lookup: (_host, _options, answer) => answer(null, [{ address: "127.0.0.1", family: 4 }]),
      }),
  };
  const disk = new SourceIconDisk(root, () => {});
  const cache = new SourceIconCache({
    persistence: disk,
    authorityForSession: (id) => (id === "session" ? AUTHORITY : null),
  });
  cleanup.push(() => cache.close());
  await cache.hydrated;
  const acquireActual = createSourceIconFetch(transport);
  const refiner = new SourceIconRefiner({
    cache,
    acquire: (candidate, signal, stillAuthorized) => {
      // drain() reaches acquisition only after its initial hydration await.
      // Its running Promise is therefore installed before this signal fires.
      acquireSignal = signal;
      acquireStarted.resolve(performance.now());
      return acquireActual(candidate, signal, stillAuthorized);
    },
    decode: createWorkerSourceIconDecoder(
      new URL("../../../agent-runtime/src/web/source-icon-worker.ts", import.meta.url),
    ),
    log: () => {},
  });
  cleanup.push(async () => {
    refiner.close();
    await refiner.settled();
  });
  const current = await connections(cache, root);
  const snapshots: SourceIconsSnapshot[] = [];
  const subscription = current.icons.sourceIcons.watch.subscribe(
    { sessionId: "session", origins: [ORIGIN] },
    { onData: (snapshot) => snapshots.push(snapshot) },
  );
  cleanup.push(() => subscription.unsubscribe());
  await expect.poll(() => snapshots.length).toBe(1);
  const attachment = new AbortController();
  const originalFetch = agentRuntime.createSafeWebFetch;
  vi.spyOn(agentRuntime, "createSafeWebFetch").mockImplementation((options = {}) =>
    originalFetch({ ...options, ...transport }),
  );
  cleanup.push(() => {
    vi.restoreAllMocks();
  });
  // The production host port, with only DNS/socket destination supplied by the
  // test. Admission/redirect policy and HTTP parsing are not mocked.
  const read = webPortsFor(
    { configured: true, provider: "brave", apiKey: "fixture-only" },
    undefined,
    () => refiner.beginRead("session", attachment.signal),
  );
  expect(await read.webFetch!({ url: `${ORIGIN}/doc`, signal: attachment.signal })).toEqual({
    requestedUrl: `${ORIGIN}/doc`,
    finalUrl: `${ORIGIN}/doc`,
    origin: ORIGIN,
    contentType: "markdown",
    text: "Readable source document.",
    truncated: false,
  });
  // One admitted candidate/job only. Seeing its actual request proves it is
  // running, rather than merely sitting behind schedule()/setImmediate().
  await iconRequested.promise;
  const startedAt = await acquireStarted.promise;
  expect(paths).toEqual(["/doc", "/icon"]);
  const wholePipelinePoll = expect.poll(() => snapshots.at(-1)?.icons[0]?.pictureId).toBeTruthy();
  await expect(wholePipelinePoll).rejects.toThrow(); // ORIGINAL default one-second observation
  expect(acquireSignal).toBeDefined();
  expect(acquireSignal!.aborted).toBe(false);
  expect(cache.grant("session")).toBe(AUTHORITY);
  const acquisitionAgeAtRelease = performance.now() - startedAt;
  releaseIcon.resolve();
  // This mirrors, and never widens, the existing fixed acquisition budget.
  // If the host missed it, keep that genuine failure rather than retrying.
  expect(acquisitionAgeAtRelease).toBeLessThan(3_000);
  await refiner.settled(); // safe NOW: this exact, single job was proven started
  // An omission/decoder deadline is not allowed to masquerade as IPC lag.
  expect(cache.has("session", AUTHORITY, ORIGIN)).toBe(true);
  await expect.poll(() => snapshots.at(-1)?.icons[0]?.pictureId).toBeTruthy(); // unchanged 1s IPC-only poll
  const id = snapshots.at(-1)!.icons[0]!.pictureId!;
  const picture = await current.pictures.session.picture.query({
    sessionId: "session",
    pictureId: id,
  });
  expect(picture.mimeType).toBe("image/png");
  expect(picture.data).not.toBeNull();
  expect(
    (await current.pictures.session.picture.query({ sessionId: "other-session", pictureId: id }))
      .data,
  ).toBeNull();
  expect(paths).toEqual(["/doc", "/icon"]);
  await disk.settled();
  subscription.unsubscribe();
  attachment.abort();
  refiner.close();
  cache.close();

  const replayDisk = new SourceIconDisk(root, () => {});
  const replay = new SourceIconCache({
    persistence: replayDisk,
    authorityForSession: (sessionId) => (sessionId === "session" ? AUTHORITY : null),
  });
  cleanup.push(() => replay.close());
  await replay.hydrated;
  const again = await connections(replay, root);
  expect(
    await again.pictures.session.picture.query({ sessionId: "session", pictureId: id }),
  ).toEqual(picture);
  expect(paths).toEqual(["/doc", "/icon"]); // no replay backfill, provider visit or icon refetch
  await replayDisk.settled();
});
