import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { DATA_EXPORT_LIMITS } from "../../../../../data-export-copy";
import { DataExportConfirmBody, StoragePane } from "./storage-pane";

describe("Settings → Storage database section", () => {
  it("names the action as a data export rather than a database export", () => {
    const html = renderToStaticMarkup(<StoragePane />);

    expect(html).toContain("Export data as JSON");
    expect(html).not.toContain("Database export");
  });

  it("states the limits before the export runs, naming attachments and transcripts", () => {
    const html = renderToStaticMarkup(<DataExportConfirmBody />);

    expect(html).toContain(DATA_EXPORT_LIMITS);
    expect(html).toContain("cannot be restored");
    expect(html).toContain("attachments or transcript files");
    // The old copy promised "every project, ticket, comment, session, label,
    // and setting", which is what made it read as a backup.
    expect(html).not.toContain("every project");
    expect(html.toLowerCase()).not.toContain("backup");
  });
});
