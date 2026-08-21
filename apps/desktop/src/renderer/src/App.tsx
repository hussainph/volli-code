import { AppShell } from "@renderer/components/app-shell";
import { ExternalAppsProvider } from "@renderer/components/files/external-app-menu";
import { DesktopModelAccessProvider } from "@renderer/lib/desktop-model-access-client";

function App() {
  return (
    <DesktopModelAccessProvider>
      <ExternalAppsProvider>
        <AppShell />
      </ExternalAppsProvider>
    </DesktopModelAccessProvider>
  );
}

export default App;
