/**
 * VC-445 network tripwire: refuse and record every non-loopback connection.
 *
 * Loaded with Electron's `-r <this file>` switch into the Electron main
 * process under test (Playwright strips `NODE_OPTIONS`), and required by the
 * bench runner itself before it loads the Node history generator — in both
 * cases before a line of product code runs.
 *
 * The bench promises "no provider calls, no network". This file enforces that
 * promise and makes it checkable:
 *
 * - **Node sockets.** `net.Socket.prototype.connect` is where `http`, `https`,
 *   `tls` and undici's `fetch` all end up. A Unix-domain path (the `volli` CLI
 *   socket) and a loopback address are let through. Anything else is refused
 *   before DNS is consulted and recorded with its host and port.
 * - **Chromium requests.** In Electron, every `Session` — the default one and
 *   any partition created later (Browser tabs, electron-updater) — gets an
 *   `onBeforeRequest` filter that cancels http(s)/ws(s) to a non-loopback host.
 *
 * The bench FAILS a launch whose record holds any refused attempt, and before
 * measuring anything it runs a self-test: one deliberate Node connect and one
 * deliberate Chromium fetch to 192.0.2.1 (TEST-NET-1, RFC 5737, never routed).
 * Both must be refused and recorded here as self-tests, or the launch fails. A
 * silent guard would be indistinguishable from an absent one.
 *
 * What it does NOT cover, stated so nobody quotes it for more: processes
 * spawned by main (the bench separately verifies main spawns none — its
 * descendants are unchanged across binding), direct `dns.lookup` calls, and
 * Chromium's own service traffic that does not pass through a `Session`.
 */
"use strict";

const net = require("node:net");

const { SELF_TEST_HOST, describeConnect, isLoopbackHost } = require("./network-policy.cjs");

const state = {
  installedAt: Date.now(),
  process: process.type === "browser" ? "electron-main" : "node",
  blocked: [],
  allowedLoopback: 0,
  allowedUnixSocket: 0,
  chromiumBlocked: [],
  chromiumAllowed: 0,
  selfTests: [],
  selfTestArmed: false,
};
globalThis.VOLLI_NETWORK_TRIPWIRE = state;

/** A refused attempt is a self-test only when armed and aimed at the self-test host. */
function recordRefusal(list, attempt, host) {
  if (state.selfTestArmed && host === SELF_TEST_HOST) {
    state.selfTests.push(attempt);
    return;
  }
  list.push(attempt);
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
    via: "node",
    host: String(target.host),
    port: target.port === undefined ? null : Number(target.port),
    // The first product frame is what tells a reader WHO tried; node_modules
    // frames are kept too because a provider SDK is exactly what this hunts.
    stack: (new Error().stack ?? "").split("\n").slice(2, 10).join("\n"),
  };
  recordRefusal(state.blocked, attempt, attempt.host);
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
      recordRefusal(
        state.chromiumBlocked,
        { at: Date.now(), via: "chromium", url: details.url, resourceType: details.resourceType },
        host,
      );
      callback({ cancel: true });
    });
  };
  app.on("session-created", guard);
  app.once("ready", () => guard(session.defaultSession));
}

module.exports = { state };
