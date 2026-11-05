import { useDocumentMotionVisibility } from "@renderer/hooks/use-motion-visibility";
import { AppShell } from "@renderer/components/app-shell";
import { ExternalAppsProvider } from "@renderer/components/files/external-app-discovery";
import { DesktopModelAccessProvider } from "@renderer/lib/desktop-model-access-client";

function App() {
  useDocumentMotionVisibility();
  return (
    <DesktopModelAccessProvider>
      <ExternalAppsProvider>
        <AppShell />
      </ExternalAppsProvider>
    </DesktopModelAccessProvider>
  );
}

export default App;
