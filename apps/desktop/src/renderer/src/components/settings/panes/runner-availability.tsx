/**
 * "Keep this Mac working as a runner": a machine preference main reads at
 * every quit and in the runner's alwaysOn/power report (VC-1037).
 */
import * as React from "react";
import { LaptopIcon } from "@phosphor-icons/react/dist/csr/Laptop";
import { RUNNER_RESIDENT_APP_STATE_KEY, runnerStaysAvailable } from "@volli/shared";
import { PrefRow, PrefSection } from "@renderer/components/settings/kit";
import { Switch } from "@renderer/components/ui/switch";
import {
  appStateStorage,
  seedAppStateCache,
  type SyncStateStorage,
} from "@renderer/lib/app-state-storage";
import { toastError } from "@renderer/lib/toast";

const storage: SyncStateStorage = appStateStorage;

export function RunnerAvailability() {
  const [enabled, setEnabled] = React.useState(() =>
    runnerStaysAvailable(storage.getItem(RUNNER_RESIDENT_APP_STATE_KEY)),
  );
  const [saving, setSaving] = React.useState(false);
  const save = async (value: boolean) => {
    setSaving(true);
    try {
      const raw = String(value);
      const result = await window.api.appState.set(RUNNER_RESIDENT_APP_STATE_KEY, raw);
      if (!result.ok) throw new Error(result.error);
      seedAppStateCache({ [RUNNER_RESIDENT_APP_STATE_KEY]: raw });
      setEnabled(value);
    } catch (error) {
      toastError(error instanceof Error ? error.message : "Couldn’t save runner availability.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <PrefSection title="This Mac" icon={LaptopIcon}>
      <PrefRow label="Keep this Mac working as a runner" htmlFor="runner-resident">
        <Switch
          id="runner-resident"
          checked={enabled}
          disabled={saving}
          onCheckedChange={(value) => void save(value)}
        />
      </PrefRow>
    </PrefSection>
  );
}
