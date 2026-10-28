import { expect, it } from "vite-plus/test";
import {
  DEFAULT_PREVIEW_SPONSOR_SEATS,
  MAX_PREVIEW_SPONSOR_SEATS,
  PREVIEW_WAITLIST_MESSAGE,
  PREVIEW_ENROLLMENT_AGREEMENT_VERSION,
  PREVIEW_AGREEMENT_REQUIRED_MESSAGE,
} from "./preview-access";

it("describes the preview waitlist without implying local projects moved", () => {
  expect(PREVIEW_WAITLIST_MESSAGE).toBe(
    "Volli Cloud is invite-only. You're on the waitlist; your local projects are unchanged.",
  );
});

it("pins the current enrollment agreement until the legal-page shared constant lands", () => {
  expect(PREVIEW_ENROLLMENT_AGREEMENT_VERSION).toBe("preview-0.3-2026-10-25");
  expect(PREVIEW_AGREEMENT_REQUIRED_MESSAGE).toContain("current Preview Agreement");
});

it("sponsors five people per preview person by default, within the operator's cap", () => {
  expect(DEFAULT_PREVIEW_SPONSOR_SEATS).toBe(5);
  expect(MAX_PREVIEW_SPONSOR_SEATS).toBeGreaterThan(DEFAULT_PREVIEW_SPONSOR_SEATS);
});
