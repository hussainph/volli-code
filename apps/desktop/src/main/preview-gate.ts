/** Only the backend's explicit grant for an active account enables the preview. */
export function previewAccountGranted(viewer: {
  previewAccess?: unknown;
  status?: unknown;
  previewAgreementAccepted?: unknown;
}): boolean {
  return (
    viewer.previewAccess === "granted" &&
    viewer.status === "active" &&
    viewer.previewAgreementAccepted === true
  );
}
