import { describe, expect, it } from "vite-plus/test";

import type { UpdateUiState } from "../../../ipc/contract";
import { createUpdateStore } from "./update";

function downloaded(version: string): UpdateUiState {
  return {
    supported: true,
    phase: "downloaded",
    currentVersion: "0.1.0",
    targetVersion: version,
    percent: null,
    error: null,
  };
}

function downloading(version: string, percent: number): UpdateUiState {
  return { ...downloaded(version), phase: "downloading", percent };
}

describe("update store", () => {
  it("holds nothing until a snapshot arrives — no icon can render from a guess", () => {
    const store = createUpdateStore();
    expect(store.getState().state).toBeNull();
    expect(store.getState().dialogOpen).toBe(false);
  });

  it("auto-opens the install dialog when a download completes — once per version", () => {
    const store = createUpdateStore();

    store.getState().receive(downloading("0.2.0", 80));
    expect(store.getState().dialogOpen).toBe(false);

    store.getState().receive(downloaded("0.2.0"));
    expect(store.getState().dialogOpen).toBe(true);
  });

  it("a dismissal sticks for that version — the badge stays, the dialog stays shut", () => {
    const store = createUpdateStore();
    store.getState().receive(downloaded("0.2.0"));

    store.getState().dismissDialog();
    expect(store.getState().dialogOpen).toBe(false);
    // The update is never invisible: state still says downloaded (the badge's input).
    expect(store.getState().state?.phase).toBe("downloaded");

    // Re-broadcasts of the same downloaded version must not re-pop the dialog.
    store.getState().receive(downloaded("0.2.0"));
    expect(store.getState().dialogOpen).toBe(false);
  });

  it("a NEWER downloaded version prompts again — each version gets its one auto-open", () => {
    const store = createUpdateStore();
    store.getState().receive(downloaded("0.2.0"));
    store.getState().dismissDialog();

    store.getState().receive(downloaded("0.3.0"));
    expect(store.getState().dialogOpen).toBe(true);
  });

  it("clicking the badged icon re-opens the dialog a dismissal closed", () => {
    const store = createUpdateStore();
    store.getState().receive(downloaded("0.2.0"));
    store.getState().dismissDialog();

    store.getState().openDialog();
    expect(store.getState().dialogOpen).toBe(true);
  });

  it("openDialog is inert while nothing is downloaded — no dialog without an install to offer", () => {
    const store = createUpdateStore();
    store.getState().receive(downloading("0.2.0", 10));

    store.getState().openDialog();
    expect(store.getState().dialogOpen).toBe(false);
  });

  it("the dialog closes itself if the downloaded state it described goes away", () => {
    const store = createUpdateStore();
    store.getState().receive(downloaded("0.2.0"));
    expect(store.getState().dialogOpen).toBe(true);

    // A newer check superseded the staged download (e.g. an error surfaced).
    store.getState().receive({ ...downloaded("0.2.0"), phase: "error", error: "feed unreachable" });
    expect(store.getState().dialogOpen).toBe(false);
  });
});
