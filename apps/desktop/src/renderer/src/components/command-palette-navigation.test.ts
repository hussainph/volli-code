import { afterEach, describe, expect, it } from "vite-plus/test";
import { useProjectUiStore } from "@renderer/stores/project-ui";
import { useUiStore } from "@renderer/stores/ui";
import { activatePaletteNavigation } from "./command-palette-navigation";
import { buildNavigationCommandItems } from "./command-palette-model";

const beforeUi = useUiStore.getState();
const beforeProject = useProjectUiStore.getState();
afterEach(() => {
  useUiStore.setState(beforeUi);
  useProjectUiStore.setState(beforeProject);
});
const items = buildNavigationCommandItems({ name: "Project" }, [
  { key: "skills", label: "Skills" },
]);

describe("palette Settings destinations", () => {
  it("keeps Settings open after choosing Skills, even when Settings was already open", () => {
    useUiStore.getState().setSettingsOpen(true, "general");
    activatePaletteNavigation(
      items.find((item) => item.id === "configure-pane")!,
      "p1",
    );
    expect(useUiStore.getState().settingsOpen).toBe(true);
    expect(useUiStore.getState().configureCategory).toBe("skills");
    expect(useUiStore.getState().settingsCategory).toBeNull();
  });
  it("opens project settings from its legacy palette id", () => {
    activatePaletteNavigation(
      items.find((item) => item.id === "configure")!,
      "p1",
    );
    expect(useUiStore.getState().settingsOpen).toBe(true);
    expect(useUiStore.getState().configureCategory).toBe("overview");
  });
  it("opens Settings with no project and ignores obsolete project rows without one", () => {
    activatePaletteNavigation(
      items.find((item) => item.id === "settings")!,
      null,
    );
    expect(useUiStore.getState().settingsOpen).toBe(true);
    activatePaletteNavigation(
      items.find((item) => item.id === "configure")!,
      null,
    );
    expect(useUiStore.getState().configureCategory).toBeNull();
  });
  it.each(["home", "board", "list"])("closes Settings only when navigating to %s", (id) => {
    useUiStore.getState().setSettingsOpen(true);
    activatePaletteNavigation(
      items.find((item) => item.id === id)!,
      "p1",
    );
    expect(useUiStore.getState().settingsOpen).toBe(false);
    expect(useProjectUiStore.getState().byProject["p1"]?.nav).toBe("home");
  });
});
