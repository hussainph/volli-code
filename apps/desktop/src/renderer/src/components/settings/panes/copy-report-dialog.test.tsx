import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { CopyReportDialog, CopyReportPreview, copyReportToClipboard } from "./copy-report-dialog";

const report = "Volli report\n\nCLI status\nCommand: Linked";
const writeText = async () => undefined;
const refuse = async () => Promise.reject(new Error("denied"));

describe("CopyReportDialog", () => {
  it("keeps the trigger disabled until the complete report is ready", () => {
    const html = renderToStaticMarkup(<CopyReportDialog report={report} availability="loading" />);

    expect(html).toContain("Preparing report…");
    expect(html).toContain("disabled");
    expect(html).not.toContain("Report preview");
  });

  it("shows a refused clipboard write as a failure, never a copied verdict", () => {
    const html = renderToStaticMarkup(<CopyReportPreview report={report} copyState="failed" />);

    expect(html).toContain('role="alert"');
    expect(html).toContain("copy the report. Try again.");
    expect(html).not.toContain("Report copied.");
  });
});

describe("copyReportToClipboard", () => {
  it("reports the clipboard's actual outcome", async () => {
    await expect(copyReportToClipboard(report, { writeText })).resolves.toBe("copied");
    await expect(copyReportToClipboard(report, { writeText: refuse })).resolves.toBe("failed");
    await expect(copyReportToClipboard(report, undefined)).resolves.toBe("failed");
  });
});
