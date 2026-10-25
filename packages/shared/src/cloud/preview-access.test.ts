import { expect, it } from "vite-plus/test";
import { PREVIEW_WAITLIST_MESSAGE } from "./preview-access";

it("describes the preview waitlist without implying local projects moved", () => {
  expect(PREVIEW_WAITLIST_MESSAGE).toBe(
    "Volli Cloud is invite-only. You're on the waitlist; your local projects are unchanged.",
  );
});
