import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vite-plus/test";
import { ModelAccessSettings } from "./models-pane";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { ModelAccessProvider } from "@renderer/lib/model-access-client";
function markup(agents = false) {
  const client = {
    inspect: vi.fn(),
    defaults: vi.fn(),
    setDefault: vi.fn(),
    hiddenModels: vi.fn(),
    setHiddenModels: vi.fn(),
    compactionPolicy: vi.fn(),
    setCompactionPolicy: vi.fn(),
    codeModePolicy: vi.fn(),
    setCodeModePolicy: vi.fn(),
    pickerView: vi.fn(),
    setPickerView: vi.fn(),
    beginSignIn: vi.fn(),
    signOut: vi.fn(),
  };
  return renderToStaticMarkup(
    <TooltipProvider>
      <ModelAccessProvider client={client}>
        <ModelAccessSettings agents={agents} />
      </ModelAccessProvider>
    </TooltipProvider>,
  );
}
it("holds account geometry before model defaults while settings are unread", () => {
  const html = markup();
  expect(html.indexOf("Loading model accounts")).toBeLessThan(
    html.indexOf("Loading model defaults"),
  );
  expect(html).toContain('data-slot="skeleton"');
  expect(html).not.toContain("Code Mode");
  expect(html).not.toContain("Decision model");
  expect(html).not.toContain('aria-label="Model:');
});
it("separates agent behavior from model accounts and tier defaults", () => {
  const html = markup(true);
  expect(html).toContain("Decision model");
  expect(html).toContain("Code Mode");
  expect(html).toContain("Loading compaction");
  expect(html).not.toContain("Default models");
  expect(html).not.toContain("Loading model accounts");
});
