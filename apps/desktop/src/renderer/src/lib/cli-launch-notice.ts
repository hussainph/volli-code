let consumed = false;

/** StrictMode-safe one-shot notice for the explicit `volli app launch` path. */
export function takeCliLaunchNotice(launchedByCli: boolean): string | null {
  if (!launchedByCli || consumed) return null;
  consumed = true;
  return "Volli launched by an agent via the CLI";
}
