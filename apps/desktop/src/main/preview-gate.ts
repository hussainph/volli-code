/** Only the backend's explicit grant for an active account enables the preview. */
export function previewAccountGranted(viewer: {
  previewAccess?: unknown;
  status?: unknown;
}): boolean {
  return viewer.previewAccess === "granted" && viewer.status === "active";
}

/** Stable preview access is checked once per launch, never trusted from a local marker. */
export async function previewAtLaunch(input: {
  stable: boolean;
  configured: boolean;
  readMarker(): { userId: string } | null;
  restoreAccount(): Promise<string | null>;
  deadlineMs?: number;
}): Promise<boolean> {
  if (!input.stable || !input.configured) return false;
  const marker = input.readMarker();
  if (marker === null) return false; // No unattended keychain access before a deliberate sign-in.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), input.deadlineMs ?? 2_000);
    });
    return (await Promise.race([input.restoreAccount(), deadline])) === marker.userId;
  } catch {
    return false; // Offline, expired or unreadable sign-ins cannot enable a stable build.
  } finally {
    clearTimeout(timer);
  }
}
