import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, createServer, resolveConfig, type ViteDevServer } from "vite-plus";
import { afterAll, beforeAll, describe, expect, it, vi, type MockInstance } from "vite-plus/test";
import {
  LAB_AUTO_SELECT_PATH,
  LAB_BODY_MAX_BYTES,
  labAutoSelectPlugin,
  type LabDecisionOutcome,
} from "./auto-select-plugin";

const desktop = fileURLToPath(new URL("..", import.meta.url));
const configFile = join(desktop, "vite.config.ts");
const nonLoopback = Object.values(networkInterfaces())
  .flat()
  .find((address) => address?.family === "IPv4" && !address.internal)?.address;
const request = {
  state: { prompt: "Fix the typo" },
  questions: {
    pick: { type: "choice", instructions: "Pick a model", criteria: { a: "Small", b: "Large" } },
  },
};
const outcome: LabDecisionOutcome = {
  ok: true,
  result: {
    answers: {
      pick: { type: "choice", choice: "a", probabilities: { a: 0.9, b: 0.1 }, confidence: 0.8 },
    },
    model: { where: "cloud", providerId: "typesafe", modelId: "jev-latest" },
    elapsedMs: 5,
  },
  usage: [
    {
      cause: "decision",
      providerId: "typesafe",
      modelId: "jev-latest",
      inputTokens: 5,
      outputTokens: 1,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      costUsd: 0.0001,
      costBasis: "catalog-estimate",
    },
  ],
  elapsedMs: 6,
};

async function filesUnder(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory()
          ? filesUnder(join(path, entry.name))
          : Promise.resolve([join(path, entry.name)]),
      ),
    )
  ).flat();
}

describe("live lab HTTP door", () => {
  let server: ViteDevServer;
  let root: string;
  let origin: string;
  const decide = vi.fn(async (): Promise<LabDecisionOutcome> => outcome);
  let load: MockInstance<ViteDevServer["ssrLoadModule"]>;

  beforeAll(async () => {
    root = await mkdtemp(join(desktop, "lab-server/.http-test-"));
    await writeFile(join(root, "index.html"), "<h1>Fixture</h1>");
    server = await createServer({
      configFile,
      root,
      mode: "lab",
      server: { host: "127.0.0.1", port: 0, strictPort: false },
      optimizeDeps: { noDiscovery: true, include: [] },
      logLevel: "silent",
    });
    load = vi.spyOn(server, "ssrLoadModule").mockResolvedValue({ decide });
    await server.listen();
    origin = new URL(server.resolvedUrls!.local[0]!).origin;
  });

  afterAll(async () => {
    await server?.close();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  async function post(
    options: {
      method?: string;
      headers?: Record<string, string | undefined>;
      raw?: string;
      chunked?: boolean;
    } = {},
  ) {
    const headers: Record<string, string> = {
      Origin: origin,
      "X-Volli-Lab": "1",
      "Content-Type": "application/json",
    };
    for (const [key, value] of Object.entries(options.headers ?? {})) {
      if (value === undefined) delete headers[key];
      else headers[key] = value;
    }
    const raw = options.raw ?? JSON.stringify({ request });
    if (!options.chunked) headers["Content-Length"] = String(Buffer.byteLength(raw));
    return await new Promise<{
      status: number;
      headers: import("node:http").IncomingHttpHeaders;
      text: string;
    }>((resolve, reject) => {
      const call = httpRequest(
        `${origin}${LAB_AUTO_SELECT_PATH}`,
        { method: options.method ?? "POST", headers },
        (response) => {
          let text = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            text += chunk;
          });
          response.on("end", () =>
            resolve({ status: response.statusCode!, headers: response.headers, text }),
          );
        },
      );
      call.on("error", reject);
      if (options.chunked) {
        call.write(raw.slice(0, 10));
        call.write(raw.slice(10));
        call.end();
      } else call.end(raw);
    });
  }

  it("refuses cross-origin, absent/null Origin, wrong Host, and missing header before loading Pi", async () => {
    for (const headers of [
      { Origin: "https://evil.example" },
      { Origin: "null" },
      { Origin: undefined },
      { Host: "evil.example" },
      { Origin: origin.replace("127.0.0.1", "localhost") },
      { "X-Volli-Lab": undefined },
      { "X-Volli-Lab": "0" },
    ]) {
      const response = await post({ headers });
      expect(response.status).toBe(403);
      if (headers.Origin === "https://evil.example") {
        expect(response.headers["access-control-allow-origin"]).toBeUndefined();
      }
    }
    expect(load).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
  });

  it("requires POST, JSON, a bounded body and a valid DecisionRequest", async () => {
    expect((await post({ method: "GET", raw: "" })).status).toBe(405);
    expect((await post({ headers: { "Content-Type": "text/plain" } })).status).toBe(415);
    expect((await post({ raw: "{" })).status).toBe(400);
    expect(
      (await post({ raw: JSON.stringify({ request: { state: {}, questions: {} } }) })).status,
    ).toBe(400);
    expect(
      (
        await post({
          raw: JSON.stringify({ request: { ...request, state: { huge: "a".repeat(33 * 1024) } } }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post({
          raw: JSON.stringify({
            classifier: { providerId: "http://evil.example", modelId: "jev" },
            request,
          }),
        })
      ).status,
    ).toBe(400);
    expect((await post({ raw: JSON.stringify({ request, apiKey: "do-not-accept" }) })).status).toBe(
      400,
    );
    const oversized = "a".repeat(LAB_BODY_MAX_BYTES + 1);
    expect((await post({ raw: oversized })).status).toBe(413);
    expect((await post({ raw: oversized, chunked: true })).status).toBe(413);
    expect(load).not.toHaveBeenCalled();
  });

  it("loads lazily only for an explicit POST and returns answers, usage and latency", async () => {
    const response = await post();
    expect(response.status).toBe(200);
    expect(JSON.parse(response.text)).toEqual({
      result: outcome.ok && outcome.result,
      usage: outcome.usage,
      elapsedMs: 6,
    });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(load).toHaveBeenCalledWith(expect.stringContaining("lab-server/decision-runtime.ts"));
    expect(decide).toHaveBeenLastCalledWith(
      { classifier: { providerId: "typesafe", modelId: "jev-latest" }, request },
      expect.any(AbortSignal),
    );
    await post({
      raw: JSON.stringify({ classifier: { providerId: "opencode", modelId: "jev-1.13" }, request }),
    });
    expect(decide).toHaveBeenLastCalledWith(
      { classifier: { providerId: "opencode", modelId: "jev-1.13" }, request },
      expect.any(AbortSignal),
    );
  });

  it("never forwards runtime import errors to the browser", async () => {
    load.mockRejectedValueOnce(new Error("Bearer sk-private-provider-body"));
    const response = await post();
    expect(response.status).toBe(503);
    expect(JSON.parse(response.text).error.code).toBe("runtime-unavailable");
    expect(response.text).not.toContain("sk-private");
  });

  it("returns safe setup failures with measurements", async () => {
    decide.mockResolvedValueOnce({
      ok: false,
      error: { code: "needs-setup", message: "Sign in to typesafe." },
      usage: [],
      elapsedMs: 2,
    });
    const response = await post();
    expect(response.status).toBe(503);
    expect(JSON.parse(response.text)).toEqual({
      error: { code: "needs-setup", message: "Sign in to typesafe." },
      usage: [],
      elapsedMs: 2,
    });
  });

  it("bounds concurrent live calls without starting a fifth classifier", async () => {
    let finish!: (value: LabDecisionOutcome) => void;
    const pending = new Promise<LabDecisionOutcome>((resolve) => {
      finish = resolve;
    });
    const before = decide.mock.calls.length;
    decide.mockImplementation(() => pending);
    const accepted = Promise.all(Array.from({ length: 4 }, () => post()));
    try {
      await vi.waitFor(() => expect(decide.mock.calls.length).toBe(before + 4));
      expect((await post()).status).toBe(429);
      expect(decide.mock.calls.length).toBe(before + 4);
    } finally {
      finish(outcome);
      await accepted;
      decide.mockImplementation(async () => outcome);
    }
  });

  it.skipIf(nonLoopback === undefined)(
    "refuses an actual non-loopback connection even with matching Host/Origin and spoofed forwarding headers",
    async () => {
      const exposed = await createServer({
        configFile: false,
        root,
        mode: "lab",
        plugins: [labAutoSelectPlugin()],
        server: { host: "0.0.0.0", port: 0, strictPort: false },
        optimizeDeps: { noDiscovery: true, include: [] },
        logLevel: "silent",
      });
      const exposedLoad = vi.spyOn(exposed, "ssrLoadModule");
      try {
        await exposed.listen();
        const canonical = new URL(exposed.resolvedUrls!.local[0]!);
        const status = await new Promise<number>((resolve, reject) => {
          const call = httpRequest(
            `http://${nonLoopback}:${canonical.port}${LAB_AUTO_SELECT_PATH}`,
            {
              method: "POST",
              headers: {
                Host: canonical.host,
                Origin: canonical.origin,
                "X-Volli-Lab": "1",
                "Content-Type": "application/json",
                "X-Forwarded-For": "127.0.0.1",
                "X-Forwarded-Host": canonical.host,
              },
            },
            (response) => {
              response.resume();
              response.on("end", () => resolve(response.statusCode!));
            },
          );
          call.on("error", reject);
          call.end(JSON.stringify({ request }));
        });
        expect(status).toBe(403);
        expect(exposedLoad).not.toHaveBeenCalled();
      } finally {
        await exposed.close();
      }
    },
  );

  it("can SSR-load the actual server-only runtime without making a live decision", async () => {
    load.mockRestore();
    const runtime = await server.ssrLoadModule(
      fileURLToPath(new URL("./decision-runtime.ts", import.meta.url)),
    );
    expect(typeof runtime.decide).toBe("function");
  });
});

const hasLive = (plugins: readonly { name: string }[]): boolean =>
  plugins.some((plugin) => plugin.name === "volli:lab-live-auto-select");

it("omits the live plugin in ordinary serve and all builds, and emits no endpoint/runtime in a real production build", async () => {
  const ordinary = await resolveConfig({ configFile }, "serve", "development");
  const lab = await resolveConfig({ configFile, mode: "lab" }, "serve");
  const labBuild = await resolveConfig({ configFile, mode: "lab" }, "build");
  expect(hasLive(ordinary.plugins)).toBe(false);
  expect(hasLive(lab.plugins)).toBe(true);
  expect(hasLive(labBuild.plugins)).toBe(false);
  const root = await mkdtemp(join(desktop, "lab-server/.build-test-"));
  try {
    let built = false;
    await build({
      configFile,
      // Real app/cursor entrypoints: a replacement fixture cannot detect an
      // accidental app → lab import reaching the packaged renderer.
      root: join(desktop, "src/renderer"),
      mode: "production",
      logLevel: "silent",
      plugins: [
        {
          name: "assert-production-config",
          configResolved(config) {
            built = true;
            expect(hasLive(config.plugins)).toBe(false);
          },
          generateBundle(_options, bundle) {
            for (const chunk of Object.values(bundle)) {
              if (chunk.type !== "chunk") continue;
              for (const id of Object.keys(chunk.modules)) {
                expect(id).not.toContain("/src/renderer/lab/");
                expect(id).not.toContain("/lab-server/");
              }
            }
          },
        },
      ],
      build: {
        outDir: join(root, "dist"),
        emptyOutDir: true,
      },
    });
    expect(built).toBe(true);
    const output = await filesUnder(join(root, "dist"));
    expect(output.some((path) => path.endsWith(".js"))).toBe(true);
    for (const file of output) {
      const text = await readFile(file, "utf8");
      expect(text).not.toContain(LAB_AUTO_SELECT_PATH);
      expect(text).not.toContain("piOwnedModelAccess");
      expect(text).not.toContain("X-Volli-Lab");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
