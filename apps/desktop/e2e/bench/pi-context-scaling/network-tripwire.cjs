/**
 * VC-445 network tripwire: refuse and record every non-loopback connection.
 *
 * Loaded with Electron's `-r <this file>` switch into the Electron main
 * process under test (Playwright strips `NODE_OPTIONS`), and required by the
 * bench runner itself before it loads the Node history generator — in both
 * cases before a line of product code runs. The bench promises "no provider calls, no network", and
 * a promise a benchmark cannot check is a promise it will one day break
 * quietly, so this file is the check rather than a hope:
 *
 * - **Node sockets.** `net.Socket.prototype.connect` is where `http`, `https`,
 *   `tls` and undici's `fetch` all end up. A Unix-domain path (the `volli` CLI
 *   socket) and a loopback host are let through; anything else is refused
 *   before DNS is consulted and recorded with its host and port.
 * - **Chromium requests.** In Electron, every `Session` — the default one and
 *   any partition created later (Browser tabs, electron-updater) — gets an
 *   `onBeforeRequest` filter that cancels http(s)/ws(s) to a non-loopback host.
 *
 * The record lives on `globalThis.VOLLI_NETWORK_TRIPWIRE`, which the bench
 * reads through `electronApp.evaluate` and publishes with every launch. A
 * non-empty `blocked` list means something TRIED to leave the machine; the
 * bench reports it rather than hiding it, and fails the run if any attempt
 * names a model provider.
 */
"use strict";

const net = require("node:net");

const state = {
  installedAt: Date.now(),
  process: process.type === "browser" ? "electron-main" : "node",
  blocked: [],
  allowedLoopback: 0,
  allowedUnixSocket: 0,
  chromiumBlocked: [],
  chromiumAllowed: 0,
};
globalThis.VOLLI_NETWORK_TRIPWIRE = state;

function isLoopbackHost(host) {
  if (host === undefined || host === null || host === "") return true; // Node defaults to localhost.
  const normalized = String(host)
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    normalized.startsWith("127.") ||
    normalized === "::ffff:127.0.0.1"
  );
}

/** `Socket#connect`'s overloads, reduced to what the decision needs. */
function describeConnect(args) {
  const [first, second] = args;
  if (Array.isArray(first)) return describeConnect(first); // net's internal normalized form
  if (first !== null && typeof first === "object") {
    if (typeof first.path === "string") return { kind: "unix", path: first.path };
    return { kind: "tcp", host: first.host, port: first.port };
  }
  if (typeof first === "string" && !/^\d+$/.test(first)) return { kind: "unix", path: first };
  return { kind: "tcp", host: typeof second === "string" ? second : undefined, port: first };
}

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function tripwireConnect(...args) {
  const target = describeConnect(args);
  if (target.kind === "unix") {
    state.allowedUnixSocket += 1;
    return originalConnect.apply(this, args);
  }
  if (isLoopbackHost(target.host)) {
    state.allowedLoopback += 1;
    return originalConnect.apply(this, args);
  }
  const attempt = {
    at: Date.now(),
    host: String(target.host),
    port: target.port === undefined ? null : Number(target.port),
    // The first product frame is what tells a reader WHO tried; node_modules
    // frames are kept too because a provider SDK is exactly what this hunts.
    stack: (new Error().stack ?? "").split("\n").slice(2, 10).join("\n"),
  };
  state.blocked.push(attempt);
  const error = Object.assign(
    new Error(`VC-445 network tripwire refused ${attempt.host}:${attempt.port}`),
    { code: "ECONNREFUSED" },
  );
  process.nextTick(() => this.destroy(error));
  return this;
};

if (process.type === "browser") {
  // Electron main only: the renderer and utility processes never load this file.
  const { app, session } = require("electron");
  const filter = { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] };
  const guard = (target) => {
    target.webRequest.onBeforeRequest(filter, (details, callback) => {
      let host = "";
      try {
        host = new URL(details.url).hostname;
      } catch {
        host = "";
      }
      if (isLoopbackHost(host)) {
        state.chromiumAllowed += 1;
        callback({});
        return;
      }
      state.chromiumBlocked.push({
        at: Date.now(),
        url: details.url,
        resourceType: details.resourceType,
      });
      callback({ cancel: true });
    });
  };
  app.on("session-created", guard);
  app.once("ready", () => guard(session.defaultSession));
}
