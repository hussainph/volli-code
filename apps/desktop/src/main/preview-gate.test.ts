import { expect, it } from "vite-plus/test";
import { previewAccountGranted } from "./preview-gate";

it("requires an explicit grant for an active account", () => {
  for (const previewAccess of ["granted", "waitlisted", "future", undefined]) {
    for (const status of ["active", "deletion_pending", "deleted", undefined]) {
      for (const previewAgreementAccepted of [true, false, undefined]) {
        expect(previewAccountGranted({ previewAccess, status, previewAgreementAccepted })).toBe(
          previewAccess === "granted" && status === "active" && previewAgreementAccepted === true,
        );
      }
    }
  }
});
