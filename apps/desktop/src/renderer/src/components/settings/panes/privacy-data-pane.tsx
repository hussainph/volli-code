import { AgentObservabilitySettings } from "./telemetry-pane";
import { DatabaseSection } from "./storage-pane";

export function PrivacyDataPane() {
  return (
    <>
      <AgentObservabilitySettings />
      <DatabaseSection />
    </>
  );
}
