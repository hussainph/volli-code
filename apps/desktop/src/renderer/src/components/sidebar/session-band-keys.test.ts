/**
 * The left band's keyboard order (VC-30 D8), which is the one thing about
 * stepping a screenshot cannot show: a folder and its open Sessions are ONE
 * order, a closed folder's Sessions are not in it at all, and a Chat Draft is
 * never in it — it stands for no Session, so there is nothing to peek or read.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  SESSION_BAND_KEY_HANDLED,
  sessionBandKeyAction,
  sessionBandModel,
  sessionBandStep,
  type SessionBandEntry,
} from "./session-band-keys";

const previous: readonly SessionBandEntry[] = [
  { kind: "session", rowId: "session:loose" },
  { kind: "folder", ticketId: "t1", rowIds: ["chat:a", "session:b"] },
  { kind: "folder", ticketId: "t2", rowIds: ["chat:c"] },
];

const model = (expanded: readonly string[] = [], active: readonly string[] = ["chat:live"]) =>
  sessionBandModel({ active, previous, expanded });

describe("sessionBandModel", () => {
  it("walks Active, then Previous, with a folder's Sessions only while it is open", () => {
    expect(model().rowIds).toEqual(["chat:live", "session:loose", "folder:t1", "folder:t2"]);
    expect(model(["t1"]).rowIds).toEqual([
      "chat:live",
      "session:loose",
      "folder:t1",
      "chat:a",
      "session:b",
      "folder:t2",
    ]);
  });

  it("steps over rows with no peek — a Chat Draft is not a stop", () => {
    // A provisional Draft's row id carries no `chat:`/`session:` prefix: it is
    // renderer-owned and its Session does not exist yet.
    const band = sessionBandModel({
      active: ["draft-1", "chat:live"],
      previous: [{ kind: "session", rowId: "draft-2" }],
      expanded: [],
    });

    expect(band.rowIds).toEqual(["chat:live"]);
  });

  it("keeps a closed folder's children out of the order but still lists them", () => {
    // A folder's CARD describes its Sessions while the folder is shut, so the
    // map is disclosure-independent; only the walk is not.
    const band = model();

    expect(band.folders.get("t1")).toEqual(["chat:a", "session:b"]);
    expect(band.folderOf.get("session:b")).toBe("t1");
    expect(band.folderOf.get("session:loose")).toBeUndefined();
    expect(band.open.has("t1")).toBe(false);
    expect(model(["t1"]).open.has("t1")).toBe(true);
  });

  it("leaves an open folder's unpeekable child out of the walk", () => {
    const band = sessionBandModel({
      active: [],
      previous: [{ kind: "folder", ticketId: "t1", rowIds: ["chat:a", "draft-3"] }],
      expanded: ["t1"],
    });

    expect(band.rowIds).toEqual(["folder:t1", "chat:a"]);
    // Still the folder's own membership, whatever the walk skips.
    expect(band.folders.get("t1")).toEqual(["chat:a", "draft-3"]);
  });
});

describe("sessionBandStep", () => {
  const rows = ["a", "b", "c"];

  it("clamps at both ends rather than wrapping between the bands", () => {
    expect(sessionBandStep(rows, "a", 1)).toBe("b");
    expect(sessionBandStep(rows, "c", 1)).toBe("c");
    expect(sessionBandStep(rows, "a", -1)).toBe("a");
    expect(sessionBandStep(rows, "c", -1)).toBe("b");
  });

  it("starts at the band's own edge for a row it does not know", () => {
    expect(sessionBandStep(rows, "draft", 1)).toBe("a");
    expect(sessionBandStep(rows, "draft", -1)).toBe("c");
  });

  it("has nowhere to go in an empty band", () => {
    expect(sessionBandStep([], "a", 1)).toBeNull();
  });
});

describe("sessionBandKeyAction", () => {
  it("steps with the arrows and with J/K, in either case", () => {
    const band = model(["t1"]);

    expect(sessionBandKeyAction("ArrowDown", "chat:live", band)).toEqual({
      kind: "focus-row",
      rowId: "session:loose",
    });
    expect(sessionBandKeyAction("j", "chat:live", band)).toEqual({
      kind: "focus-row",
      rowId: "session:loose",
    });
    expect(sessionBandKeyAction("J", "chat:live", band)).toEqual({
      kind: "focus-row",
      rowId: "session:loose",
    });
    expect(sessionBandKeyAction("ArrowUp", "session:loose", band)).toEqual({
      kind: "focus-row",
      rowId: "chat:live",
    });
    expect(sessionBandKeyAction("k", "session:loose", band)).toEqual({
      kind: "focus-row",
      rowId: "chat:live",
    });
    expect(sessionBandKeyAction("K", "session:loose", band)).toEqual({
      kind: "focus-row",
      rowId: "chat:live",
    });
  });

  it("says nothing about a step in a band with no rows", () => {
    const empty = sessionBandModel({ active: [], previous: [], expanded: [] });

    expect(sessionBandKeyAction("ArrowDown", "chat:live", empty)).toBeNull();
    expect(sessionBandKeyAction("ArrowUp", "chat:live", empty)).toBeNull();
  });

  it("opens a folder with → and closes it with ←", () => {
    expect(sessionBandKeyAction("ArrowRight", "folder:t1", model())).toEqual({
      kind: "toggle-folder",
      ticketId: "t1",
    });
    expect(sessionBandKeyAction("ArrowLeft", "folder:t1", model(["t1"]))).toEqual({
      kind: "toggle-folder",
      ticketId: "t1",
    });
  });

  it("consumes the arrow that would ask for the state a folder is already in", () => {
    // The peek's own fallback toggles blindly; passing these down would close
    // the folder the reader just asked to keep open.
    expect(sessionBandKeyAction("ArrowRight", "folder:t1", model(["t1"]))).toBe(
      SESSION_BAND_KEY_HANDLED,
    );
    expect(sessionBandKeyAction("ArrowLeft", "folder:t1", model())).toBe(SESSION_BAND_KEY_HANDLED);
  });

  it("takes ← on a Session back out to the folder holding it", () => {
    expect(sessionBandKeyAction("ArrowLeft", "chat:a", model(["t1"]))).toEqual({
      kind: "focus-folder",
      ticketId: "t1",
    });
  });

  it("leaves every other key, and every row with no folder, to the peek", () => {
    const band = model(["t1"]);

    expect(sessionBandKeyAction("ArrowLeft", "session:loose", band)).toBeNull();
    expect(sessionBandKeyAction("ArrowRight", "session:loose", band)).toBeNull();
    expect(sessionBandKeyAction(" ", "chat:live", band)).toBeNull();
    expect(sessionBandKeyAction("u", "chat:live", band)).toBeNull();
  });
});
