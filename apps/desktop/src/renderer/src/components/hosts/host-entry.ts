/**
 * The two ways to more hosts (VC-700 PR 3), wherever they are offered: the
 * switcher (through VC-576's entry points), ⌘K and Settings → Hosts.
 */
import { useRemoteHostsStore } from "@renderer/stores/remote-hosts";
import { useUiStore } from "@renderer/stores/ui";

/** The Hosts category's key in Settings: "Manage hosts…" deep-links here. */
export const HOSTS_CATEGORY_KEY = "hosts";

/** Opens the Add-a-host sheet; never on a read-only hosts file, where main would refuse it. */
export function openAddHostSheet(): void {
  const store = useRemoteHostsStore.getState();
  if (store.readOnly !== null) return;
  store.openAddHost();
}

/** Opens Settings on Hosts. */
export function openHostsSettings(): void {
  useUiStore.getState().setSettingsOpen(true, HOSTS_CATEGORY_KEY);
}
