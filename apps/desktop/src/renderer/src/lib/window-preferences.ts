/** Adopt accepted device preferences without sharing workspace navigation or drafts. */
import { acceptAppStateValue, onPreferenceValueAccepted } from "./app-state-storage";
import { useThemeStore } from "@renderer/stores/theme";
import { useUiStore, UI_APP_STATE_KEY } from "@renderer/stores/ui";
import { useStyleStore } from "@renderer/stores/style";

function rehydrate(key: string): void {
  // Rehydration merges only persisted preferences, retaining transient view
  // state. Unlike setState, it does not write the event back to main.
  if (key === UI_APP_STATE_KEY) void useUiStore.persist.rehydrate();
  else if (key === "volli:style") void useStyleStore.persist.rehydrate();
}

export function startWindowPreferenceSync(): { activate(): void; stop(): void } {
  let active = false;
  const buffered = new Map<string, string>();
  const receive = (key: string, value: string): void => {
    if (![UI_APP_STATE_KEY, "volli:style", "theme", "appearance"].includes(key)) return;
    if (!active) {
      buffered.set(key, value);
      return;
    }
    if (!acceptAppStateValue(key, value)) return;
    if (key === "theme" || key === "appearance") {
      // Device preferences in cloud launches too: no SQLite board hydration.
      const theme = useThemeStore.getState();
      theme.hydrateGlobal(
        {
          theme: key === "theme" ? value : JSON.stringify(theme.globalCanvas),
          appearance: key === "appearance" ? value : theme.globalAppearance,
        },
        { live: true },
      );
      return;
    }
    rehydrate(key);
  };
  // Subscribe before bootstrap: a write during its round trip is replayed after
  // the snapshot restores, rather than permanently leaving the new window stale.
  const stopEvents = window.api.appState.onChanged(({ key, value }) => receive(key, value));
  const stopAccepted = onPreferenceValueAccepted((key) => {
    if (active) rehydrate(key);
  });
  return {
    activate: () => {
      active = true;
      for (const [key, value] of buffered) receive(key, value);
      buffered.clear();
    },
    stop: () => {
      stopEvents();
      stopAccepted();
      buffered.clear();
    },
  };
}
