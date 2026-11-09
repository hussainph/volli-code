import { useDocumentMotionVisibility } from "@renderer/hooks/use-motion-visibility";
import { AppShell } from "@renderer/components/app-shell";
import { ViewportScrollLock } from "@renderer/components/ui/viewport-scroll-lock";
import { ExternalAppsProvider } from "@renderer/components/files/external-app-discovery";
import { DesktopModelAccessProvider } from "@renderer/lib/desktop-model-access-client";

function App() {
  useDocumentMotionVisibility();
  return (
    <DesktopModelAccessProvider>
      <ViewportScrollLock />
      <ExternalAppsProvider>
        <AppShell />
      </ExternalAppsProvider>
    </DesktopModelAccessProvider>
  );
}

export default App;
