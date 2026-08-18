import { describe, expect, it } from "vite-plus/test";

import type { WebAccessSettingsView } from "../../../../ipc/contract";
import { webAccessPanel } from "./web-access-model";

function view(overrides: Partial<WebAccessSettingsView> = {}): WebAccessSettingsView {
  return {
    provider: "off",
    searxngUrl: null,
    braveKey: "absent",
    encryptionAvailable: true,
    ...overrides,
  };
}

describe("webAccessPanel", () => {
  it("shows a profile that configured nothing exactly one control", () => {
    const panel = webAccessPanel(view());

    expect(panel).toMatchObject({
      provider: "off",
      showsEndpoint: false,
      showsKey: false,
      active: false,
      notice: null,
    });
  });

  it("says nothing extra when Off — the segment is the whole explanation", () => {
    expect(
      webAccessPanel(view({ braveKey: "present", searxngUrl: "http://localhost:8888/" })),
    ).toMatchObject({ notice: null, active: false });
  });

  describe("Brave", () => {
    it("asks for the key that is missing, and does not claim to be on", () => {
      const panel = webAccessPanel(view({ provider: "brave" }));

      expect(panel).toMatchObject({ showsKey: true, showsEndpoint: false, active: false });
      expect(panel.notice).toMatchObject({ tone: "neutral" });
      expect(panel.notice?.message).toMatch(/API key/i);
    });

    it("is on once a key is stored", () => {
      expect(webAccessPanel(view({ provider: "brave", braveKey: "present" }))).toMatchObject({
        active: true,
        notice: null,
      });
    });

    it("says a machine that cannot encrypt cannot hold a key, before anyone types one", () => {
      const panel = webAccessPanel(view({ provider: "brave", encryptionAvailable: false }));

      expect(panel.keyEntryDisabled).toBe(true);
      expect(panel.notice).toMatchObject({ tone: "error" });
      expect(panel.notice?.message).toMatch(/keychain/i);
      expect(panel.active).toBe(false);
    });

    it("tells a person their stored key stopped opening rather than that they have none", () => {
      const panel = webAccessPanel(
        view({ provider: "brave", braveKey: "unreadable", encryptionAvailable: false }),
      );

      expect(panel.notice).toMatchObject({ tone: "error" });
      expect(panel.notice?.message).toMatch(/could not be read/i);
      expect(panel.active).toBe(false);
    });
  });

  describe("SearXNG", () => {
    it("asks for an instance while there is none", () => {
      const panel = webAccessPanel(view({ provider: "searxng" }));

      expect(panel).toMatchObject({ showsEndpoint: true, showsKey: false, active: false });
      expect(panel.notice?.message).toMatch(/instance/i);
    });

    it("is on once an instance is saved, and never asks for a key", () => {
      const panel = webAccessPanel(
        view({ provider: "searxng", searxngUrl: "http://localhost:8888/" }),
      );

      expect(panel).toMatchObject({ showsKey: false, active: true, notice: null });
    });

    it("ignores a stored key entirely — this provider sends no credential", () => {
      const panel = webAccessPanel(
        view({
          provider: "searxng",
          searxngUrl: "http://localhost:8888/",
          braveKey: "unreadable",
          encryptionAvailable: false,
        }),
      );

      expect(panel).toMatchObject({ active: true, notice: null });
    });
  });
});
