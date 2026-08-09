import { AppShell } from "@renderer/components/app-shell";
import { DesktopModelAccessProvider } from "@renderer/lib/desktop-model-access-client";

function App() {
  return (
    <DesktopModelAccessProvider>
      <AppShell />
    </DesktopModelAccessProvider>
  );
}

export default App;
