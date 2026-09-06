import { describe, expect, it } from "vite-plus/test";

import {
  ACTIVITY_KINDS,
  ACTIVITY_METADATA_KEY,
  EMPTY_ACTIVITY_SUBJECT,
  activityDuration,
  isActivityKind,
  isDurableActivity,
  isReadOnlyActivity,
  readActivityBrowse,
  readActivityDescriptor,
  type ActivityDescriptor,
} from "./session-activity";

/** Wrap a raw descriptor the way an adapter stamps it onto tool metadata. */
function stamped(raw: unknown): unknown {
  return { opencode: { ignored: true }, [ACTIVITY_METADATA_KEY]: raw };
}

const timed = (startedAt: number | null, endedAt: number | null): ActivityDescriptor => ({
  kind: "run-command",
  nativeToolName: "bash",
  subject: EMPTY_ACTIVITY_SUBJECT,
  outcome: null,
  startedAt,
  endedAt,
});

const EMPTY_OUTCOME = {
  exitCode: null,
  matchCount: null,
  fileCount: null,
  lineCount: null,
  bytes: null,
  addedLines: null,
  removedLines: null,
  diff: null,
  summary: null,
};

describe("isActivityKind", () => {
  it.each(ACTIVITY_KINDS)("accepts %s", (kind) => {
    expect(isActivityKind(kind)).toBe(true);
  });

  it.each([
    ["an unknown string", "run_command"],
    ["a number", 7],
    ["null", null],
    ["undefined", undefined],
    ["an object", { kind: "search" }],
  ])("rejects %s", (_label, value) => {
    expect(isActivityKind(value)).toBe(false);
  });
});

describe("readActivityDescriptor", () => {
  it("reads a fully populated descriptor", () => {
    expect(
      readActivityDescriptor(
        stamped({
          kind: "edit-file",
          nativeToolName: "edit",
          subject: {
            label: "src/index.ts",
            path: "/workspace/src/index.ts",
            lineRange: { start: 1, end: 48 },
          },
          outcome: {
            exitCode: 0,
            matchCount: 14,
            fileCount: 6,
            lineCount: 210,
            bytes: 4200,
            addedLines: 49,
            removedLines: 12,
            diff: "--- a\n+++ b\n",
            summary: "Edited one file",
          },
          startedAt: 10,
          endedAt: 42,
        }),
      ),
    ).toEqual({
      kind: "edit-file",
      nativeToolName: "edit",
      subject: {
        label: "src/index.ts",
        path: "/workspace/src/index.ts",
        lineRange: { start: 1, end: 48 },
      },
      outcome: {
        exitCode: 0,
        matchCount: 14,
        fileCount: 6,
        lineCount: 210,
        bytes: 4200,
        addedLines: 49,
        removedLines: 12,
        // Strings are trimmed on read, so a diff loses its trailing newline.
        diff: "--- a\n+++ b",
        summary: "Edited one file",
      },
      startedAt: 10,
      endedAt: 42,
    });
  });

  it.each([
    ["metadata is null", null],
    ["metadata is an array", [{ kind: "search", nativeToolName: "grep" }]],
    ["metadata is a string", "volli.activity"],
    ["metadata is a number", 7],
    ["the reserved key is absent", { opencode: { raw: "…" } }],
    ["the reserved key holds a non-record", { [ACTIVITY_METADATA_KEY]: "search" }],
    ["the reserved key holds an array", { [ACTIVITY_METADATA_KEY]: [] }],
    ["the kind is unknown", stamped({ kind: "run_command", nativeToolName: "bash" })],
    ["the kind is missing", stamped({ nativeToolName: "bash" })],
    ["nativeToolName is missing", stamped({ kind: "run-command" })],
    ["nativeToolName is blank", stamped({ kind: "run-command", nativeToolName: "   " })],
    ["nativeToolName is not a string", stamped({ kind: "run-command", nativeToolName: 7 })],
  ])("returns null when %s", (_label, metadata) => {
    expect(readActivityDescriptor(metadata)).toBeNull();
  });

  it("trims the native tool name", () => {
    expect(
      readActivityDescriptor(stamped({ kind: "other", nativeToolName: "  linear_x  " })),
    ).toMatchObject({ nativeToolName: "linear_x" });
  });

  it.each([
    ["absent", undefined],
    ["not a record", "src/index.ts"],
    ["an array", ["src/index.ts"]],
  ])("degrades a subject that is %s to the empty subject", (_label, subject) => {
    expect(
      readActivityDescriptor(stamped({ kind: "read-file", nativeToolName: "read", subject })),
    ).toMatchObject({ subject: EMPTY_ACTIVITY_SUBJECT });
  });

  it("drops non-string label and path", () => {
    expect(
      readActivityDescriptor(
        stamped({
          kind: "read-file",
          nativeToolName: "read",
          subject: { label: 7, path: false },
        }),
      ),
    ).toMatchObject({ subject: EMPTY_ACTIVITY_SUBJECT });
  });

  it.each([
    ["not a record", "1-48"],
    ["missing start", { end: 48 }],
    ["missing end", { start: 1 }],
    ["non-finite", { start: Number.NaN, end: Number.POSITIVE_INFINITY }],
    ["inverted", { start: 48, end: 1 }],
  ])("drops a lineRange that is %s", (_label, lineRange) => {
    expect(
      readActivityDescriptor(
        stamped({
          kind: "read-file",
          nativeToolName: "read",
          subject: { label: "src/index.ts", lineRange },
        }),
      ),
    ).toMatchObject({ subject: { label: "src/index.ts", path: null, lineRange: null } });
  });

  it("keeps a single-line range", () => {
    expect(
      readActivityDescriptor(
        stamped({
          kind: "read-file",
          nativeToolName: "read",
          subject: { lineRange: { start: 12, end: 12 } },
        }),
      ),
    ).toMatchObject({ subject: { lineRange: { start: 12, end: 12 } } });
  });

  it.each([
    ["absent", undefined],
    ["not a record", "exit 1"],
    ["an array", []],
  ])("returns a null outcome when it is %s", (_label, outcome) => {
    expect(
      readActivityDescriptor(stamped({ kind: "run-command", nativeToolName: "bash", outcome })),
    ).toMatchObject({ outcome: null });
  });

  it("nulls every malformed outcome field rather than dropping the outcome", () => {
    expect(
      readActivityDescriptor(
        stamped({
          kind: "run-command",
          nativeToolName: "bash",
          outcome: {
            exitCode: "1",
            matchCount: Number.NaN,
            fileCount: Number.POSITIVE_INFINITY,
            lineCount: null,
            bytes: {},
            addedLines: [],
            removedLines: false,
            diff: "  ",
            summary: 7,
          },
        }),
      ),
    ).toMatchObject({ outcome: EMPTY_OUTCOME });
  });

  it.each([
    ["absent", {}],
    ["not numbers", { startedAt: "10", endedAt: "42" }],
    ["non-finite", { startedAt: Number.NaN, endedAt: Number.POSITIVE_INFINITY }],
  ])("nulls timestamps that are %s", (_label, times) => {
    expect(
      readActivityDescriptor(stamped({ kind: "other", nativeToolName: "linear_x", ...times })),
    ).toMatchObject({ startedAt: null, endedAt: null });
  });
});

describe("activityDuration", () => {
  it.each([
    ["both ends reported", 10, 42, 32],
    ["a zero-length call", 10, 10, 0],
    ["no start", null, 42, null],
    ["no end", 10, null, null],
    ["neither end", null, null, null],
    // A clock that ran backwards is not a negative duration.
    ["an inverted clock", 42, 10, null],
  ] as const)("returns %s", (_label, startedAt, endedAt, expected) => {
    expect(activityDuration(timed(startedAt, endedAt))).toBe(expected);
  });
});

describe("isReadOnlyActivity", () => {
  it.each([
    ["read-file", true],
    ["search", true],
    ["list-directory", true],
    ["fetch-url", true],
    ["run-command", false],
    ["edit-file", false],
    ["write-file", false],
    ["plan", false],
    ["delegate", false],
    // Browsing clicks and types into pages: it acts, so it is a first-class
    // row rather than one folded under a read count.
    ["browse", false],
    ["other", false],
  ] as const)("reports %s as %s", (kind, expected) => {
    expect(isReadOnlyActivity(kind)).toBe(expected);
  });

  it("classifies every declared kind", () => {
    expect(ACTIVITY_KINDS.filter(isReadOnlyActivity)).toEqual([
      "read-file",
      "search",
      "list-directory",
      "fetch-url",
    ]);
  });
});

describe("isDurableActivity", () => {
  it.each([
    ["edit-file", true],
    ["write-file", true],
    ["read-file", false],
    ["search", false],
    ["list-directory", false],
    ["fetch-url", false],
    ["run-command", false],
    ["plan", false],
    ["delegate", false],
    ["browse", false],
    ["other", false],
  ] as const)("reports %s as %s", (kind, expected) => {
    expect(isDurableActivity(kind)).toBe(expected);
  });

  it("classifies every declared kind", () => {
    expect(ACTIVITY_KINDS.filter(isDurableActivity)).toEqual(["edit-file", "write-file"]);
  });

  it("is not the complement of read-only — some kinds are neither", () => {
    const neither = ACTIVITY_KINDS.filter(
      (kind) => !isReadOnlyActivity(kind) && !isDurableActivity(kind),
    );
    expect(neither).toEqual(["run-command", "plan", "delegate", "browse", "other"]);
  });
});

describe("readActivityDescriptor browse facet (VC-238)", () => {
  it("reads what a browser action touched: the tab, the page, the target and the picture", () => {
    expect(
      readActivityDescriptor(
        stamped({
          kind: "browse",
          nativeToolName: "browser_act",
          subject: { label: "example.com/sign-in" },
          browse: {
            action: "click",
            tabId: "tab-1",
            url: "https://example.com/sign-in",
            title: "Sign in",
            target: "Sign in",
            picture: "picture-7",
            errorCount: null,
            ownerSessionId: "s1",
            error: "Could not load page: ERR_CONNECTION_REFUSED",
          },
        }),
      ),
    ).toEqual({
      kind: "browse",
      nativeToolName: "browser_act",
      subject: { label: "example.com/sign-in", path: null, lineRange: null },
      outcome: null,
      startedAt: null,
      endedAt: null,
      browse: {
        action: "click",
        tabId: "tab-1",
        url: "https://example.com/sign-in",
        title: "Sign in",
        target: "Sign in",
        picture: "picture-7",
        errorCount: null,
        ownerSessionId: "s1",
        // Volli's words for the tab's own trouble, so the row's glyph can
        // disagree with a harness that called the call a success (§9).
        error: "Could not load page: ERR_CONNECTION_REFUSED",
        refusal: null,
      },
    });
  });

  it("nulls malformed facet fields, drops a facet with an unknown action, and omits the facet when absent", () => {
    expect(
      readActivityDescriptor(
        stamped({
          kind: "browse",
          nativeToolName: "browser_console",
          browse: { action: "console", tabId: 7, url: "", errorCount: 3, target: [] },
        }),
      )?.browse,
    ).toEqual({
      action: "console",
      tabId: null,
      url: null,
      title: null,
      target: null,
      picture: null,
      errorCount: 3,
      ownerSessionId: null,
      error: null,
      refusal: null,
    });
    expect(
      readActivityDescriptor(
        stamped({ kind: "browse", nativeToolName: "x", browse: { action: "teleport" } }),
      ),
    ).not.toHaveProperty("browse");
    expect(
      readActivityDescriptor(stamped({ kind: "browse", nativeToolName: "x", browse: "click" })),
    ).not.toHaveProperty("browse");
    expect(
      readActivityDescriptor(stamped({ kind: "read-file", nativeToolName: "read" })),
    ).not.toHaveProperty("browse");
  });

  it("reads a bare facet the same way, for the adapter that stamps it from a tool's details", () => {
    expect(readActivityBrowse({ action: "open", url: "https://example.com/" })).toEqual({
      action: "open",
      tabId: null,
      url: "https://example.com/",
      title: null,
      target: null,
      picture: null,
      errorCount: null,
      ownerSessionId: null,
      error: null,
      refusal: null,
    });
    expect(readActivityBrowse(undefined)).toBeNull();
    expect(readActivityBrowse({ action: "click", refusal: "browser.stale-ref" })?.refusal).toBe(
      "browser.stale-ref",
    );
    // A facet written before this build knew about `error` reads as healthy
    // rather than failing the whole descriptor: tolerant on read.
    expect(readActivityBrowse({ action: "click", error: 7 })?.error).toBeNull();
  });
});
