/** Dev-server-only spending door. No runtime/credential code loads until a guarded POST. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import type { DecisionAnswered, DecisionRequest, SessionUsage } from "@volli/shared";
// Relative source import keeps this pure validator inside Vite's config bundle;
// externalizing the raw-TS @volli/shared entry would ask Node to load it directly.
import { checkDecisionRequest } from "../../../packages/shared/src/decision-model";
import type { Plugin, ViteDevServer } from "vite-plus";

export const LAB_AUTO_SELECT_PATH = "/__lab/auto-select";
export const LAB_BODY_MAX_BYTES = 384 * 1024;
const MAX_IN_FLIGHT = 4;

export interface LabDecisionInput {
  classifier: { providerId: string; modelId: string };
  request: DecisionRequest;
}

export type LabDecisionOutcome =
  | { ok: true; result: DecisionAnswered; usage: SessionUsage[]; elapsedMs: number }
  | {
      ok: false;
      error: { code: string; message: string };
      usage: SessionUsage[];
      elapsedMs: number;
    };

// A type-only edge checks the runtime in the desktop node typecheck without
// turning the config's lazy SSR door into an eager runtime import.
type LabDecisionRuntime = Pick<typeof import("./decision-runtime"), "decide">;

function loopback(address: string | undefined): boolean {
  if (address === undefined) return false;
  const plain = address.startsWith("::ffff:") ? address.slice(7) : address;
  return plain === "::1" || (isIP(plain) === 4 && plain.startsWith("127."));
}

function serverOrigin(server: ViteDevServer): URL | null {
  const address = server.resolvedUrls?.local[0];
  if (address === undefined) return null;
  const url = new URL(address);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  return hostname === "localhost" || loopback(hostname) ? url : null;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  if (response.destroyed) return;
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.removeHeader("Access-Control-Allow-Origin");
  response.end(JSON.stringify(body));
}

class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function bodyOf(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  const declared = Number(request.headers["content-length"] ?? 0);
  if (declared > LAB_BODY_MAX_BYTES) {
    request.resume();
    throw new RequestError(413, "body-too-large", "The lab request is too large.");
  }
  // Event listeners, rather than async iteration: abandoning an oversized
  // iterator destroys the socket before the 413 response can reach the caller.
  const raw = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      request.resume();
      reject(new RequestError(408, "body-timeout", "The lab request body timed out."));
    }, 10_000);
    const cleanup = (): void => {
      clearTimeout(timer);
      request.off("data", data);
      request.off("end", end);
      request.off("error", error);
      request.off("aborted", aborted);
    };
    const data = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > LAB_BODY_MAX_BYTES) {
        cleanup();
        request.resume();
        reject(new RequestError(413, "body-too-large", "The lab request is too large."));
      } else chunks.push(chunk);
    };
    const end = (): void => {
      cleanup();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const error = (): void => {
      cleanup();
      reject(new RequestError(400, "invalid-body", "Could not read the lab request."));
    };
    const aborted = (): void => error();
    request.on("data", data);
    request.on("end", end);
    request.on("error", error);
    request.on("aborted", aborted);
  });
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new RequestError(400, "invalid-json", "The lab request must be JSON.");
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inputOf(value: unknown): LabDecisionInput {
  if (
    !record(value) ||
    Object.keys(value).some((key) => key !== "classifier" && key !== "request")
  ) {
    throw new RequestError(400, "invalid-input", "Send only classifier and request.");
  }
  const classifier =
    value["classifier"] === undefined
      ? { providerId: "typesafe", modelId: "jev-latest" }
      : value["classifier"];
  if (
    !record(classifier) ||
    Object.keys(classifier).some((key) => key !== "providerId" && key !== "modelId") ||
    typeof classifier["providerId"] !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(classifier["providerId"]) ||
    typeof classifier["modelId"] !== "string" ||
    classifier["modelId"].includes("://") ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,255}$/.test(classifier["modelId"])
  ) {
    throw new RequestError(
      400,
      "invalid-classifier",
      "Choose a provider id and classifier model id, not a URL or credentials.",
    );
  }
  const checked = checkDecisionRequest(value["request"]);
  if (!checked.ok) throw new RequestError(400, "invalid-request", checked.problem);
  return {
    classifier: { providerId: classifier["providerId"], modelId: classifier["modelId"] },
    request: checked.value,
  };
}

/** Receiving path: vite.config.ts, only `serve --mode lab`; never a renderer import. */
export function labAutoSelectPlugin(): Plugin {
  return {
    name: "volli:lab-live-auto-select",
    apply: "serve",
    configureServer(server) {
      if (server.config.mode !== "lab") return;
      let active = 0;
      // This is deliberately not a static import: normal app config/build/test
      // evaluation must not load Pi, restore catalogs, or open credential stores.
      const loadRuntime = async (): Promise<LabDecisionRuntime> =>
        (await server.ssrLoadModule(
          fileURLToPath(new URL("./decision-runtime.ts", import.meta.url)),
        )) as LabDecisionRuntime;
      server.middlewares.use((request, response, next) => {
        if (request.url?.split("?")[0] !== LAB_AUTO_SELECT_PATH) {
          next();
          return;
        }
        const origin = serverOrigin(server);
        if (
          !loopback(request.socket.remoteAddress) ||
          origin === null ||
          request.headers.host !== origin.host ||
          request.headers.origin !== origin.origin ||
          request.headers["x-volli-lab"] !== "1"
        ) {
          send(response, 403, {
            error: {
              code: "forbidden",
              message: "Live lab calls require the loopback lab origin and X-Volli-Lab: 1.",
            },
          });
          return;
        }
        if (request.method !== "POST") {
          response.setHeader("Allow", "POST");
          send(response, 405, {
            error: { code: "method-not-allowed", message: "Live lab calls require POST." },
          });
          return;
        }
        if (request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") {
          send(response, 415, {
            error: { code: "content-type", message: "Send application/json." },
          });
          return;
        }
        if (active >= MAX_IN_FLIGHT) {
          send(response, 429, {
            error: { code: "busy", message: "Wait for the current lab calls to finish." },
          });
          return;
        }
        active += 1;
        const controller = new AbortController();
        const closed = (): void => controller.abort();
        response.once("close", closed);
        void (async () => {
          try {
            const input = inputOf(await bodyOf(request));
            if (controller.signal.aborted) return;
            const runtime = await loadRuntime();
            const outcome = await runtime.decide(input, controller.signal);
            if (outcome.ok) {
              const { result, usage, elapsedMs } = outcome;
              send(response, 200, { result, usage, elapsedMs });
            } else {
              const { error, usage, elapsedMs } = outcome;
              send(response, error.code === "timeout" ? 504 : 503, { error, usage, elapsedMs });
            }
          } catch (error) {
            if (error instanceof RequestError)
              send(response, error.status, { error: { code: error.code, message: error.message } });
            else
              send(response, 503, {
                error: {
                  code: "runtime-unavailable",
                  message:
                    "The live decision runtime could not start. Check the lab server and Pi model setup.",
                },
              });
          } finally {
            response.off("close", closed);
            active -= 1;
          }
        })();
      });
    },
  };
}
