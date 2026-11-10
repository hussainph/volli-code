import { expect, it } from "vite-plus/test";
import { settingsIconColor } from "./settings-icon-colors";
it("uses stable category identities in app, project and search navigation", () => {
  expect(settingsIconColor("appearance")).toBe("#2a6ae6");
  expect(settingsIconColor("app:notifications")).toBe("#e5383b");
  expect(settingsIconColor("project:mcp")).toBe("#7754f0");
  expect(settingsIconColor("unknown")).toBe(settingsIconColor("general"));
  expect(settingsIconColor("toString")).toBe(settingsIconColor("general"));
});
