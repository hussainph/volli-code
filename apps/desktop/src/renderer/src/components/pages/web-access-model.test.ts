import { describe, expect, it } from "vite-plus/test";

import type { WebAccessSettingsView } from "../../../../ipc/contract";
import { webAccessPanel } from "./web-access-model";

function view(overrides: Partial<WebAccessSettingsView> = {}): WebAccessSettingsView {
  return {
    provider: "off",
    searxngUrl: null,
    keys: { brave: "absent", exa: "absent" },
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
      webAccessPanel(
        view({ keys: { brave: "present", exa: "absent" }, searxngUrl: "http://localhost:8888/" }),
      ),
    ).toMatchObject({ notice: null, active: false });
  });

  describe("Brave", () => {
    it("asks for the key that is missing, and does not claim to be on", () => {
      const panel = webAccessPanel(view({ provider: "brave" }));

      expect(panel).toMatchObject({ showsKey: true, showsEndpoint: false, active: false });
      expect(panel.notice).toMatch(/API key/i);
    });

    it("is on once a key is stored", () => {
      expect(
        webAccessPanel(view({ provider: "brave", keys: { brave: "present", exa: "absent" } })),
      ).toMatchObject({
        active: true,
        notice: null,
      });
    });

    it("names the provider whose key it is asking for", () => {
      // Exa chosen with only Brave's key stored is the case a shared "enter
      // your key" sentence would get wrong.
      const panel = webAccessPanel(
        view({ provider: "exa", keys: { brave: "present", exa: "absent" } }),
      );

      expect(panel.notice).toMatch(/Exa API key/);
      expect(panel.active).toBe(false);
    });
  });

  describe("SearXNG", () => {
    it("asks for an instance while there is none", () => {
      const panel = webAccessPanel(view({ provider: "searxng" }));

      expect(panel).toMatchObject({ showsEndpoint: true, showsKey: false, active: false });
      expect(panel.notice).toMatch(/instance/i);
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
          keys: { brave: "present", exa: "absent" },
        }),
      );

      expect(panel).toMatchObject({ active: true, notice: null });
    });
  });
});
