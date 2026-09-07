/**
 * What the File menu and the save dialog SAY about the JSON export.
 *
 * The behaviour under test is copy, which is unusual for a main-process suite
 * and is the whole point of VC-283's first half: the previous label ("Export
 * Database as JSON…", over a dialog promising every setting) described a
 * backup, and there is no restore path, no attachment byte, and no transcript
 * file in the document it writes. A person who believed that sentence would
 * discover the gap only while trying to recover.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  DATA_EXPORT_CONTENTS,
  DATA_EXPORT_LIMITS,
  DATA_EXPORT_MENU_LABEL,
} from "../data-export-copy";

const { menuTemplates, showSaveDialog, showErrorBox } = vi.hoisted(() => ({
  menuTemplates: [] as unknown[][],
  showSaveDialog: vi.fn(),
  showErrorBox: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { getVersion: () => "9.9.9" },
  BrowserWindow: { getFocusedWindow: () => null },
  dialog: { showSaveDialog, showErrorBox },
  Menu: {
    buildFromTemplate: (template: unknown[]) => {
      menuTemplates.push(template);
      return { template };
    },
    setApplicationMenu: () => undefined,
  },
}));

interface MenuItemShape {
  label?: string;
  submenu?: MenuItemShape[];
}

function fileSubmenu(): MenuItemShape[] {
  const template = menuTemplates.at(-1) as MenuItemShape[] | undefined;
  const file = template?.find((item) => item.label === "File");
  if (!file?.submenu) throw new Error("no File menu in the built template");
  return file.submenu;
}

beforeEach(() => {
  menuTemplates.length = 0;
  showSaveDialog.mockReset();
  showErrorBox.mockReset();
});

afterEach(() => {
  vi.resetModules();
});

describe("File menu", () => {
  it("names the action as a data export, never as a database backup", async () => {
    const { registerAppMenu } = await import("./menu");

    registerAppMenu({ ok: false, error: "closed" });

    const labels = fileSubmenu().map((item) => item.label ?? "");
    expect(labels).toContain(DATA_EXPORT_MENU_LABEL);
    expect(labels).toContain("Export data as JSON…");
    for (const label of labels) {
      expect(label.toLowerCase()).not.toContain("database");
      expect(label.toLowerCase()).not.toContain("backup");
    }
  });
});

describe("export disclosure", () => {
  it("says the export cannot be restored and names both excluded artifact kinds", () => {
    expect(DATA_EXPORT_LIMITS).toContain("limited data export");
    expect(DATA_EXPORT_LIMITS).toContain("cannot be restored");
    expect(DATA_EXPORT_LIMITS).toContain("attachments");
    expect(DATA_EXPORT_LIMITS).toContain("transcript");
    expect(DATA_EXPORT_LIMITS.toLowerCase()).not.toContain("backup");
    expect(DATA_EXPORT_CONTENTS.toLowerCase()).not.toContain("every setting");
  });

  it("puts the disclosure in the save dialog itself, before any file is written", async () => {
    const { exportDatabase } = await import("./menu");
    showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined });

    await exportDatabase({ ok: true, db: {} as never });

    const options = showSaveDialog.mock.calls[0]?.[0] as Electron.SaveDialogOptions | undefined;
    expect(options?.message).toContain(DATA_EXPORT_LIMITS);
    expect(options?.title).toBe("Export data as JSON");
    expect(options?.defaultPath).toMatch(/^volli-export-\d{4}-\d{2}-\d{2}\.json$/);
  });

  it("still refuses a degraded database before showing anything", async () => {
    const { exportDatabase } = await import("./menu");

    await exportDatabase({ ok: false, error: "The database could not be opened." });

    expect(showSaveDialog).not.toHaveBeenCalled();
    expect(showErrorBox).toHaveBeenCalledWith(
      "Export Failed",
      "The database could not be opened.",
    );
  });
});
