import { Settings } from "lucide-react";

/** Placeholder: settings UI lands once there is something to configure. */
export function SettingsPage() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
      <Settings className="size-8 text-muted-foreground" />
      <h2 className="text-lg font-semibold">Settings</h2>
      <p className="text-sm text-muted-foreground">Nothing to configure yet.</p>
    </div>
  );
}
