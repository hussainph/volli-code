import { describe, expect, test } from "vite-plus/test";

import { parseTicketKey, renderTicketKey, resolveTicketPrefix } from "./ticket-key";

describe("renderTicketKey", () => {
  test("renders from the project's current prefix", () => {
    expect(renderTicketKey({ ticketPrefix: "VC" }, 12)).toBe("VC-12");
  });
});

describe("parseTicketKey", () => {
  test("parses bare and qualified keys, normalizing the prefix", () => {
    expect(parseTicketKey("VC-12")).toEqual({ qualifier: null, prefix: "VC", number: 12 });
    expect(parseTicketKey(" vc-925 ")).toEqual({ qualifier: null, prefix: "VC", number: 925 });
    expect(parseTicketKey("volli-code/VC12-3")).toEqual({
      qualifier: "volli-code",
      prefix: "VC12",
      number: 3,
    });
  });

  test("refuses anything that is not a key", () => {
    for (const text of [
      "VC-0",
      "VC-012",
      "12-VC",
      "VC",
      "TOOLONG-1",
      "1VC-2",
      "a/b/VC-1",
      "VC-1x",
    ]) {
      expect(parseTicketKey(text)).toBeNull();
    }
  });
});

describe("resolveTicketPrefix", () => {
  const vc = { id: "p1", ticketPrefix: "VC" };
  const vcMoved = { id: "p2", ticketPrefix: "VC" };
  const web = { id: "p3", ticketPrefix: "WEB" };

  test("finds a unique project, case-insensitively", () => {
    expect(resolveTicketPrefix("web", [vc, web])).toEqual({ kind: "unique", project: web });
  });

  test("reports a duplicate prefix as ambiguous instead of guessing", () => {
    expect(resolveTicketPrefix("VC", [vc, web, vcMoved])).toEqual({
      kind: "ambiguous",
      projects: [vc, vcMoved],
    });
  });

  test("answers none when no project has the prefix", () => {
    expect(resolveTicketPrefix("OPS", [vc, web])).toEqual({ kind: "none" });
  });
});
