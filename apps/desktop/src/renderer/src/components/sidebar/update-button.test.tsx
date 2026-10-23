// @vitest-environment jsdom
import {
  summarizeUpdateFailure,
  UPDATE_FAILURE_FALLBACK,
  UPDATE_FAILURE_SUMMARY_MAX,
} from "@volli/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import type { UpdateUiState } from "../../../../ipc/contract";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { useUpdateStore } from "@renderer/stores/update";

import { UpdateButton } from "./update-button";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ERROR_STATE: UpdateUiState = {
  supported: true,
  phase: "error",
  currentVersion: "0.2.2",
  targetVersion: null,
  percent: null,
  error: null,
  lastCheck: null,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  useUpdateStore.setState({ state: null, dialogOpen: false, promptedVersions: [] });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useUpdateStore.setState({ state: null });
});

describe("UpdateButton failure copy", () => {
  it.each([
    {
      name: "a missing feed with a URL and header dump",
      raw: 'Cannot find latest-mac.yml in the latest release artifacts (https://github.com/example/app/releases/download/v1/latest-mac.yml): HttpError: 404 "method: GET url: https://github.com/example/app" Headers: {"server":"cdn.example.com","x-request-id":"private-request"}\ncontent-type: application/json',
    },
    {
      name: "a long failure with a URL and header dump",
      raw: `The release could not be checked ${"while the service is unavailable ".repeat(10)}https://updates.example.com/latest-mac.yml Headers: {"x-request-id":"private-request"}`,
    },
    { name: "a missing error", raw: null },
    { name: "an error with only diagnostics", raw: "https://updates.example.com/latest-mac.yml" },
  ])("summarizes $name in both the tooltip and aria-label", async ({ raw }) => {
    useUpdateStore.setState({ state: { ...ERROR_STATE, error: raw } });
    await act(async () => {
      root.render(
        <TooltipProvider>
          <UpdateButton />
        </TooltipProvider>,
      );
    });
    const button = container.querySelector("button");
    expect(button).not.toBeNull();
    await act(async () => button!.focus());

    const summary = summarizeUpdateFailure(raw ?? UPDATE_FAILURE_FALLBACK);
    const prefix = "Update check failed: ";
    const suffix = ". Select to retry.";
    const label = button!.getAttribute("aria-label");
    const tooltip = document.querySelector('[role="tooltip"]')?.textContent;
    expect(label).toBe(`${prefix}${summary}${suffix}`);
    expect(tooltip).toBe(label);
    for (const text of [label!, tooltip!]) {
      expect(text).not.toMatch(
        /https?:\/\/|github\.com|updates\.example\.com|Headers:|x-request-id|private-request|method:|url:/iu,
      );
      expect(text.slice(prefix.length, -suffix.length).length).toBeLessThanOrEqual(
        UPDATE_FAILURE_SUMMARY_MAX,
      );
    }
    if (raw === null || raw.startsWith("https://")) {
      expect(summary).toBe(UPDATE_FAILURE_FALLBACK);
    }
  });
});
