/**
 * TEMPORARY — a visual check of the canvas editor in both appearances. Delete
 * before shipping.
 */
import { CircleHalfIcon } from "@phosphor-icons/react/dist/csr/CircleHalf";
import { PaletteIcon } from "@phosphor-icons/react/dist/csr/Palette";
import { DEFAULT_CANVAS, type Canvas } from "@volli/shared";

import { SettingsRow, SettingsSection } from "@renderer/components/pages/settings-shell";
import { AppearanceModeChoice, CanvasEditor } from "@renderer/components/theme/canvas-editor";
import type { ThemeScope } from "@renderer/stores/theme";

export const title = "zz — canvas editor check";
export const viewport = "stage" as const;

const GLOBAL: ThemeScope = { kind: "global" };

const STRANDING: Canvas = {
  ...DEFAULT_CANVAS,
  stops: [{ hex: "#e068d8", x: 0.5, y: 0.5 }],
  vibrancy: 1,
};

const THREE: Canvas = {
  ...DEFAULT_CANVAS,
  stops: [
    { hex: "#e8652a", x: 0.2, y: 0.3 },
    { hex: "#2a7de8", x: 0.6, y: 0.5 },
    { hex: "#7de82a", x: 0.8, y: 0.8 },
  ],
  primaryIndex: 1,
};

export default function CanvasEditorCheck() {
  const resolved = document.documentElement.classList.contains("light") ? "light" : "dark";
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <SettingsSection title="App theme" icon={PaletteIcon}>
        <CanvasEditor scope={GLOBAL} canvas={DEFAULT_CANVAS} resolved={resolved} />
      </SettingsSection>

      <SettingsSection title="Three stops" icon={PaletteIcon}>
        <CanvasEditor scope={GLOBAL} canvas={THREE} resolved={resolved} />
      </SettingsSection>

      <SettingsSection title="Stranded floor" icon={PaletteIcon}>
        <CanvasEditor scope={GLOBAL} canvas={STRANDING} resolved="light" />
      </SettingsSection>

      <SettingsSection title="Light &amp; dark" icon={CircleHalfIcon}>
        <SettingsRow label="Mode">
          <AppearanceModeChoice value="auto" testId="mode" onChange={() => {}} />
        </SettingsRow>
      </SettingsSection>
    </div>
  );
}
