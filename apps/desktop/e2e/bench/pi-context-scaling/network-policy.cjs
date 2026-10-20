/**
 * The decisions behind VC-445's network tripwire, with no side effects, so
 * they can be tested without patching a test runner's own sockets.
 */
"use strict";

/** The self-test target: TEST-NET-1 (RFC 5737) is reserved for documentation and never routed. */
const SELF_TEST_HOST = "192.0.2.1";

/** Loopback by address or by the one name that means it — never by prefix alone. */
function isLoopbackHost(host) {
  if (host === undefined || host === null || host === "") return true; // Node defaults to localhost.
  const normalized = String(host)
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  if (normalized === "localhost" || normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") {
    return true;
  }
  const ipv4 = normalized.replace(/^::ffff:/, "");
  const octets = ipv4.match(/^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  return octets !== null && octets.slice(1).every((octet) => Number(octet) <= 255);
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

module.exports = { SELF_TEST_HOST, describeConnect, isLoopbackHost };
