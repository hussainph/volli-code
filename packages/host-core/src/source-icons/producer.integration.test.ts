/** Successful live read -> real worker -> real handler/IPC -> Session picture. */
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

it("delivers an authorized icon through the actual bridge and replays only from disk", async () => {
  const parent = fileURLToPath(new URL("../../../../.tmp/", import.meta.url));
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "source-icon-producer-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const paths: string[] = [];
  const server = http.createServer((request, response) => {
    paths.push(request.url ?? "");
    if (request.url === "/doc") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        '<html><head><link rel="icon" href="/icon"></head><body><p>Readable source document.</p></body></html>',
      );
    } else {
      response.writeHead(200, { "content-type": "image/png" });
      response.end(png());
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
  const acquisitionStarted = Promise.withResolvers<void>();
  const acquire = createSourceIconFetch(transport);
  const refiner = new SourceIconRefiner({
    cache,
    acquire: (...args) => {
      acquisitionStarted.resolve();
      return acquire(...args);
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
  // drain() has yielded for hydration before entering acquisition, so this
  // single job's running Promise is installed before the signal resolves.
  // Do not spend the IPC-only poll on deferred network/codec work, and do not
  // mistake a genuine producer omission after settlement for delivery lag.
  await acquisitionStarted.promise;
  await refiner.settled();
  expect(cache.has("session", AUTHORITY, ORIGIN)).toBe(true);
  await expect.poll(() => snapshots.at(-1)?.icons[0]?.pictureId).toBeTruthy();
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

it.each(["account", "session"] as const)(
  "keeps foreground text but refuses icon acquisition when %s authority changes during HTML transport",
  async (kind) => {
    const held = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const paths: string[] = [];
    const server = http.createServer((request, response) => {
      paths.push(request.url ?? "");
      if (request.url === "/doc") {
        started.resolve();
        void held.promise.then(() => {
          response.writeHead(200, { "content-type": "text/html" });
          response.end(
            '<html><head><link rel="icon" href="/icon"></head><body><p>Foreground text survives.</p></body></html>',
          );
        });
      } else {
        response.writeHead(200, { "content-type": "image/png" });
        response.end(png());
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(async () => {
      held.resolve();
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
    let account = "account-a";
    let session = "session-a";
    const cache = new SourceIconCache({
      authorityForSession: () => JSON.stringify([account, session]),
    });
    cleanup.push(() => cache.close());
    const acquire = vi.fn(createSourceIconFetch(transport));
    const refiner = new SourceIconRefiner({
      cache,
      acquire,
      decode: createWorkerSourceIconDecoder(
        new URL("../../../agent-runtime/src/web/source-icon-worker.ts", import.meta.url),
      ),
      log: () => {},
    });
    cleanup.push(async () => {
      refiner.close();
      await refiner.settled();
    });
    const originalFetch = agentRuntime.createSafeWebFetch;
    vi.spyOn(agentRuntime, "createSafeWebFetch").mockImplementation((options = {}) =>
      originalFetch({ ...options, ...transport }),
    );
    cleanup.push(() => {
      vi.restoreAllMocks();
    });
    const attachment = new AbortController();
    const ports = webPortsFor(
      { configured: true, provider: "brave", apiKey: "fixture-only" },
      undefined,
      () => refiner.beginRead("session", attachment.signal),
    );
    const reading = ports.webFetch!({ url: `${ORIGIN}/doc`, signal: attachment.signal });
    await started.promise;
    if (kind === "account") account = "account-b";
    else session = "session-b";
    held.resolve();
    expect(await reading).toMatchObject({
      text: "Foreground text survives.",
      finalUrl: `${ORIGIN}/doc`,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(acquire).not.toHaveBeenCalled();
    expect(paths).toEqual(["/doc"]);
    // A later foreground read on the SAME attachment captures its own current grant.
    expect(
      await ports.webFetch!({ url: `${ORIGIN}/doc`, signal: attachment.signal }),
    ).toMatchObject({ text: "Foreground text survives." });
    await expect
      .poll(() => cache.has("session", JSON.stringify([account, session]), ORIGIN))
      .toBe(true);
    expect(acquire).toHaveBeenCalledOnce();
    expect(paths).toEqual(["/doc", "/doc", "/icon"]);
  },
);
