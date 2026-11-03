/** Compatibility destination for stored Configure routes. All settings use the same shell. */
import { SettingsPage } from "./settings-page";
export function ConfigurePage() {
  return <SettingsPage initialScope="project" />;
}
