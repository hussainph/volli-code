import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

/**
 * The renderer pages' Content-Security-Policy, as each `.html` entry declares
 * it in its `<meta http-equiv>` (VC-839).
 *
 * `form-action` is the one fetch directive that does NOT fall back to
 * `default-src`, so without it any `<form>` that reached the DOM could submit
 * — and a submission is a navigation, which main hands to the person's
 * browser with whatever they typed in the query string. No page here submits
 * a form natively (every form's `onSubmit` prevents the default), so `'none'`
 * costs nothing and closes the door whatever a sanitizer misses.
 */
function cspOf(page: string): string {
  const html = readFileSync(new URL(`../${page}`, import.meta.url), "utf8");
  const match = /http-equiv="Content-Security-Policy"\s+content="([^"]*)"/.exec(html);
  if (match === null) throw new Error(`${page} declares no Content-Security-Policy`);
  return match[1];
}

function directives(csp: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of csp.split(";")) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) map.set(name, values.join(" "));
  }
  return map;
}

describe("renderer CSP", () => {
  it.each(["index.html", "cursor.html"])("%s forbids every form submission", (page: string) => {
    expect(directives(cspOf(page)).get("form-action")).toBe("'none'");
  });
});

/**
 * Where the main window may open a connection (VC-889): its own origin, and
 * the loopback a Volli Cloud backend runs on for an unpackaged build (the
 * pinned local fixture). A packaged build names no backend yet; when one
 * exists, its exact deployment origin joins this list, and nothing broader.
 * No remote image source either: injected script cannot carry the window's
 * short-lived Volli Cloud token anywhere else.
 */
describe("the main window's connections", () => {
  it("reach only its own origin and the loopback", () => {
    const csp = directives(cspOf("index.html"));
    expect(csp.get("connect-src")).toBe(
      "'self' http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* ws://localhost:*",
    );
    expect(csp.get("img-src")).toBe("'self' data: volli-blob:");
    expect(csp.get("default-src")).toBe("'self'");
  });
});
