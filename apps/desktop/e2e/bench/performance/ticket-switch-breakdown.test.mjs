import { describe, expect, it } from "vitest";

import { ticketSwitchBreakdown } from "./ticket-switch-breakdown.mjs";

/**
 * VC-385 — the arithmetic that turns one switch's renderer marks into the
 * question the ticket actually asks: how much of the number is the palette,
 * how much is the workspace rebuild, how much is the description editor.
 *
 * Every expected value here is worked by hand from the mark stamps, never
 * recomputed the way the reducer does it.
 */
describe("ticketSwitchBreakdown", () => {
  it("splits the switch into the segments between consecutive marks", () => {
    // A switch that began at 1000 and was still settling at 1420.
    const marks = [
      { name: "volli.ticket-switch.start", startTime: 1000 },
      { name: "volli.command-palette.open", startTime: 1030 },
      { name: "volli.command-palette.sessions-listed", startTime: 1180 },
      { name: "volli.ticket-switch.commit", startTime: 1200 },
      { name: "volli.ticket-workspace.mount", startTime: 1240 },
      { name: "volli.ticket-description.ready", startTime: 1400 },
    ];

    expect(ticketSwitchBreakdown({ marks, latencyMs: 420 })).toEqual({
      paletteOpenMs: 30, // 1030 - 1000
      paletteResolveMs: 170, // 1200 - 1030
      workspaceRebuildMs: 40, // 1240 - 1200
      descriptionEditorMs: 160, // 1400 - 1240
      settleMs: 20, // (1000 + 420) - 1400
      sessionsListMs: 150, // 1180 - 1030, inside paletteResolveMs
      missingMarks: [],
    });
  });

  it("names the marks the switch never reached rather than reporting them as free", () => {
    // A renderer whose mark name drifted from the harness's, or a phase that
    // genuinely did not happen: either way the segments that depend on it are
    // unknown, not zero, and the run has to be able to say which.
    const marks = [
      { name: "volli.ticket-switch.start", startTime: 500 },
      { name: "volli.command-palette.open", startTime: 540 },
      { name: "volli.ticket-switch.commit", startTime: 700 },
    ];

    expect(ticketSwitchBreakdown({ marks, latencyMs: 300 })).toEqual({
      paletteOpenMs: 40, // 540 - 500
      paletteResolveMs: 160, // 700 - 540
      workspaceRebuildMs: null,
      descriptionEditorMs: null,
      settleMs: null,
      sessionsListMs: null,
      missingMarks: [
        "volli.command-palette.sessions-listed",
        "volli.ticket-workspace.mount",
        "volli.ticket-description.ready",
      ],
    });
  });
});
