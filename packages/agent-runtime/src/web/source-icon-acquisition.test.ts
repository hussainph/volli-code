/** Real HTTP parsing, shared pinned transport and real decoder workers. */
import http from "node:http";
import type { AddressInfo } from "node:net";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createSafeWebFetch,
  createSourceIconFetch,
  type ReadSourceIconCandidate,
  type WebFetchAddress,
  type WebRequestOptions,
} from "./safe-fetch";
import { createWorkerSourceIconDecoder } from "./source-icon-decoder";

const PUBLIC: WebFetchAddress[] = [{ address: "93.184.216.34", family: 4 }];
const servers: http.Server[] = [];
const live = () => new AbortController().signal;
const allowed = () => true;
const page =
  '<html><head><base href="https://unrelated.example/"><link rel="shortcut ICON" href="/icon"></head><body><p>Readable source document.</p></body></html>';

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function fixture(handler: http.RequestListener) {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const sent: WebRequestOptions[] = [];
  const resolve = vi.fn(async (_hostname: string) => PUBLIC);
  const open = vi.fn((_scheme: "http" | "https", options: WebRequestOptions) => {
    sent.push(options);
    return http.request({
      ...options,
      protocol: "http:",
      port,
      lookup: (_host, _options, answer) => answer(null, [{ address: "127.0.0.1", family: 4 }]),
    });
  });
  const candidates: ReadSourceIconCandidate[] = [];
  const transport = { resolve, open };
  const read = createSafeWebFetch({
    ...transport,
    onSourceIcon: (candidate) => {
      candidates.push(candidate);
    },
  });
  return { read, candidates, sent, transport, icons: createSourceIconFetch(transport) };
}

async function png(): Promise<Buffer> {
  return sharp({ create: { width: 128, height: 64, channels: 4, background: "#c07a42" } })
    .png()
    .toBuffer();
}

describe("successful-read source icon acquisition", () => {
  it("mints one ephemeral receipt without changing the page, ignores base, and decodes only local-safe bytes", async () => {
    const pixels = await png();
    const f = await fixture((request, response) => {
      if (request.url?.startsWith("/doc")) {
        response.writeHead(200, { "content-type": "text/html", "set-cookie": "private=secret" });
        response.end(page);
      } else {
        response.writeHead(200, { "content-type": "image/png" });
        response.end(pixels);
      }
    });
    const input = { url: "http://source.example/doc?private=query", signal: live() };
    const document = await f.read.fetch(input);
    const unchanged = await createSafeWebFetch(f.transport).fetch(input);
    expect(document).toEqual(unchanged);
    expect(f.candidates).toEqual([
      { origin: "http://source.example", url: "http://source.example/icon" },
    ]);
    const raster = await f.icons(f.candidates[0]!, live(), allowed);
    expect(raster?.mime).toBe("image/png");
    const decoder = createWorkerSourceIconDecoder(
      new URL("./source-icon-worker.ts", import.meta.url),
    );
    const decoded = await decoder(raster!, live());
    expect(decoded).not.toBeNull();
    expect(await sharp(decoded!).metadata()).toMatchObject({
      format: "png",
      width: 64,
      height: 32,
    });
    const headers = f.sent.at(-1)!.headers;
    expect(headers).toMatchObject({
      accept: "image/png, image/jpeg, image/webp",
      "accept-encoding": "identity",
    });
    expect(JSON.stringify(headers)).not.toMatch(/cookie|authorization|referer|private=query/i);
    expect(f.sent.at(-1)!.path).toBe("/icon");
  });

  it("cannot acquire from an arbitrary URL, a replayed/serialized shape, or a reused receipt", async () => {
    const pixels = await png();
    const f = await fixture((request, response) => {
      response.writeHead(200, {
        "content-type": request.url === "/doc" ? "text/html" : "image/png",
      });
      response.end(request.url === "/doc" ? page : pixels);
    });
    expect(
      await f.icons(
        { origin: "http://source.example", url: "http://source.example/icon" },
        live(),
        allowed,
      ),
    ).toBeNull();
    expect(f.transport.open).not.toHaveBeenCalled();
    await f.read.fetch({ url: "http://source.example/doc", signal: live() });
    const candidate = f.candidates[0]!;
    expect(await f.icons({ ...candidate }, live(), allowed)).toBeNull();
    expect(await f.icons(candidate, live(), allowed)).not.toBeNull();
    const requests = f.sent.length;
    expect(await f.icons(candidate, live(), allowed)).toBeNull();
    expect(f.sent).toHaveLength(requests);
  });

  it("refused, empty and non-HTML reads never authorize icons", async () => {
    const f = await fixture((request, response) => {
      if (request.url === "/refused") response.writeHead(403, { "content-type": "text/html" });
      else
        response.writeHead(200, {
          "content-type": request.url === "/plain" ? "text/plain" : "text/html",
        });
      response.end(request.url === "/empty" ? '<head><link rel="icon" href="/icon"></head>' : page);
    });
    await expect(
      f.read.fetch({ url: "http://source.example/refused", signal: live() }),
    ).rejects.toMatchObject({ rule: "fetch.status" });
    await expect(
      f.read.fetch({ url: "http://source.example/empty", signal: live() }),
    ).rejects.toMatchObject({ rule: "fetch.unreadable" });
    await f.read.fetch({ url: "http://source.example/plain", signal: live() });
    expect(f.candidates).toEqual([]);
  });

  it.each([
    "https://other.example/icon",
    "http://169.254.169.254/icon",
    "http://source.example/icon?token=secret",
    "http://user:secret@source.example/icon",
    "file:///icon",
  ])("does not follow an icon redirect to %s", async (location) => {
    const f = await fixture((request, response) => {
      if (request.url === "/doc") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(page);
      } else {
        response.writeHead(302, { location });
        response.end();
      }
    });
    await f.read.fetch({ url: "http://source.example/doc", signal: live() });
    expect(await f.icons(f.candidates[0]!, live(), allowed)).toBeNull();
    expect(f.sent).toHaveLength(2);
    expect(f.transport.resolve.mock.calls.every((args) => args[0] === "source.example")).toBe(true);
  });

  it("re-admits every same-origin redirect and enforces two hops", async () => {
    const pixels = await png();
    const f = await fixture((request, response) => {
      if (request.url === "/doc") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(page);
      } else if (request.url === "/icon") {
        response.writeHead(302, { location: "/next" });
        response.end();
      } else if (request.url === "/next") {
        response.writeHead(302, { location: "/last" });
        response.end();
      } else {
        response.writeHead(200, { "content-type": "image/png" });
        response.end(pixels);
      }
    });
    await f.read.fetch({ url: "http://source.example/doc", signal: live() });
    expect(await f.icons(f.candidates[0]!, live(), allowed)).not.toBeNull();
    expect(f.sent.map((request) => request.path)).toEqual(["/doc", "/icon", "/next", "/last"]);
    expect(f.transport.resolve).toHaveBeenCalledTimes(4);
  });

  it("does not make a third redirect hop or accept an HTTPS downgrade", async () => {
    const f = await fixture((request, response) => {
      if (request.url === "/doc") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(page);
      } else {
        const next = request.url === "/icon" ? "/one" : request.url === "/one" ? "/two" : "/three";
        response.writeHead(302, { location: next });
        response.end();
      }
    });
    await f.read.fetch({ url: "https://source.example/doc", signal: live() });
    expect(await f.icons(f.candidates[0]!, live(), allowed)).toBeNull();
    expect(f.sent.map((request) => request.path)).toEqual(["/doc", "/icon", "/one", "/two"]);
    const secure = await fixture((request, response) => {
      if (request.url === "/doc") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(page);
      } else {
        response.writeHead(302, { location: "http://source.example/icon" });
        response.end();
      }
    });
    await secure.read.fetch({ url: "https://source.example/doc", signal: live() });
    expect(await secure.icons(secure.candidates[0]!, live(), allowed)).toBeNull();
    expect(secure.sent).toHaveLength(2);
  });

  it("counts streamed body bytes even without a length header", async () => {
    const f = await fixture((request, response) => {
      if (request.url === "/doc") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(page);
      } else {
        response.writeHead(200, { "content-type": "image/png", "transfer-encoding": "chunked" });
        response.write(Buffer.alloc(128 * 1024));
        response.write(Buffer.alloc(128 * 1024));
        response.end(Buffer.from([0]));
      }
    });
    await f.read.fetch({ url: "http://source.example/doc", signal: live() });
    expect(await f.icons(f.candidates[0]!, live(), allowed)).toBeNull();
  });

  it("rejects any private DNS answer before opening an icon socket", async () => {
    const f = await fixture((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(page);
    });
    await f.read.fetch({ url: "http://source.example/doc", signal: live() });
    f.transport.resolve.mockResolvedValue([...PUBLIC, { address: "169.254.169.254", family: 4 }]);
    expect(await f.icons(f.candidates[0]!, live(), allowed)).toBeNull();
    expect(f.sent).toHaveLength(1);
  });

  it("cancels while DNS is pending, then refuses a late connection or changed owner", async () => {
    const f = await fixture((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(page);
    });
    await f.read.fetch({ url: "http://source.example/doc", signal: live() });
    const resolving = Promise.withResolvers<WebFetchAddress[]>();
    const open = vi.fn((scheme: "http" | "https", options: WebRequestOptions) =>
      f.transport.open(scheme, options),
    );
    const acquire = createSourceIconFetch({ resolve: () => resolving.promise, open });
    const abort = new AbortController();
    const reading = acquire(f.candidates[0]!, abort.signal, allowed);
    abort.abort();
    expect(await reading).toBeNull();
    resolving.resolve(PUBLIC);
    await Promise.resolve();
    await Promise.resolve();
    expect(open).not.toHaveBeenCalled();
    await f.read.fetch({ url: "http://source.example/doc", signal: live() });
    expect(await f.icons(f.candidates[1]!, live(), () => false)).toBeNull();
    expect(f.sent).toHaveLength(2);
  });

  it("keeps one outstanding native DNS lookup after a cancelled caller", async () => {
    const f = await fixture((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(page);
    });
    await f.read.fetch({ url: "http://source.example/doc", signal: live() });
    const pending = Promise.withResolvers<WebFetchAddress[]>();
    const resolve = vi.fn((_host: string) => pending.promise);
    const open = vi.fn((scheme: "http" | "https", options: WebRequestOptions) =>
      f.transport.open(scheme, options),
    );
    const acquire = createSourceIconFetch({ resolve, open });
    const abort = new AbortController();
    const first = acquire(f.candidates[0]!, abort.signal, allowed);
    abort.abort();
    expect(await first).toBeNull();
    await f.read.fetch({ url: "http://source.example/doc", signal: live() });
    expect(await acquire(f.candidates[1]!, live(), allowed)).toBeNull();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
    pending.resolve(PUBLIC);
  });

  it.each([
    { "content-type": "image/svg+xml" },
    { "content-type": "image/png", "content-encoding": "gzip" },
    { "content-type": "image/png", "content-length": "262145" },
  ])("rejects unsupported or unbounded responses independently of filename", async (headers) => {
    const f = await fixture((request, response) => {
      if (request.url === "/doc") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(page);
      } else {
        response.writeHead(200, headers);
        response.end("not a raster");
      }
    });
    await f.read.fetch({ url: "http://source.example/doc", signal: live() });
    expect(await f.icons(f.candidates[0]!, live(), allowed)).toBeNull();
  });
});
