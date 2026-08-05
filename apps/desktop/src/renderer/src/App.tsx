import { AppShell } from "@renderer/components/app-shell";
import { DesktopRuntimeCatalogProvider } from "@renderer/lib/desktop-runtime-catalog-client";

function App() {
  return (
    <DesktopRuntimeCatalogProvider>
      <AppShell />
    </DesktopRuntimeCatalogProvider>
  );
}

export default App;
