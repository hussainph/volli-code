import { describe, expect, it, vi } from "vite-plus/test";
import { EMPTY_SESSION_USAGE_SUMMARY } from "@volli/shared";
import { fakeCloud } from "@renderer/stores/cloud-board/fake-cloud.test-support";
import { cloudSessionListing, type CloudSessionRow } from "./cloud-session-listing";
import { CloudSessionSource } from "./cloud-session-source";

export const row = (patch: Partial<CloudSessionRow> = {}): CloudSessionRow => ({
  id: "s",
  projectId: "p",
  ticketId: null,
  role: "project",
  parentSessionId: null,
  ownerUserId: "u",
  origin: { kind: "user" },
  title: null,
  visibility: "private",
  status: "open",
  turnActive: false,
  lastTurnOutcome: null,
  signal: null,
  stopped: null,
  needsUser: false,
  attentionCount: 0,
  placeRunnerId: "r",
  model: null,
  usageTotals: { summary: EMPTY_SESSION_USAGE_SUMMARY },
  listing: { activity: "idle", waitingOn: null, live: false, bornTicketless: true },
  createdAt: 1,
  lastActivityAt: 2,
  ...patch,
});
const args = (cursor: string | null = null) => ({
  projectId: "p",
  paginationOpts: { cursor, numItems: 100 },
});
const page = (rows = [row()], done = true, cursor = "end") => ({
  page: rows,
  isDone: done,
  continueCursor: cursor,
});

describe("cloud listing projection", () => {
  it("keeps backend identity, attention, usage and provenance without inventing a PTY", () => {
    expect(cloudSessionListing(row())).toMatchObject({
      kind: "chat",
      record: {
        sessionId: "s",
        title: "Chat",
        activity: "idle",
        waitingOn: null,
        live: false,
        bornTicketless: true,
      },
      usage: EMPTY_SESSION_USAGE_SUMMARY,
      provenance: { kind: "user" },
    });
    // The backend's listing is carried verbatim; no row field is re-read for it.
    expect(
      cloudSessionListing(
        row({
          title: "Named",
          role: "ticket",
          ticketId: "t",
          needsUser: false,
          turnActive: false,
          listing: {
            activity: "waiting",
            waitingOn: "permission",
            live: true,
            bornTicketless: true,
          },
          model: { providerId: "a", modelId: "b", reasoningLevel: "high", connectionId: "local" },
        }),
      ),
    ).toMatchObject({
      record: {
        title: "Named",
        activity: "waiting",
        waitingOn: "permission",
        live: true,
        bornTicketless: true,
        model: { modelId: "b" },
      },
    });
    expect(
      cloudSessionListing(
        row({
          stopped: { at: 5, reason: null },
          lastTurnOutcome: "interrupted",
          listing: { activity: "stopped", waitingOn: null, live: false, bornTicketless: false },
        }),
      ).record,
    ).toMatchObject({
      activity: "stopped",
      waitingOn: null,
      live: false,
      bornTicketless: false,
      outcome: "interrupted",
    });
    expect(
      cloudSessionListing(
        row({ origin: { kind: "automation", automationRunId: "run", automationName: null } }),
      ).provenance,
    ).toEqual({ kind: "automation", automationRunId: "run", automationName: null });
    expect(
      cloudSessionListing(row({ origin: { kind: "session", sessionId: "parent" } })).provenance,
    ).toEqual({ kind: "session", parentSessionId: "parent", parentTitle: null });
    expect(cloudSessionListing(row({ origin: null, usageTotals: {} })).provenance).toEqual({
      kind: "user",
    });
  });
});

describe("cloud Session source", () => {
  it("shares reads, follows all pages, deduplicates boundaries and replaces changed suffixes", async () => {
    const fake = fakeCloud();
    const paint = vi.fn();
    const source = new CloudSessionSource(fake.session, paint, vi.fn());
    const ready = source.open("p");
    expect(source.open("p")).toBe(ready);
    fake.answer("sessions:list", args(), page([row()], false, "next"));
    expect(paint).not.toHaveBeenCalled();
    fake.answer("sessions:list", args("next"), page([row(), row({ id: "older" })]));
    expect(await ready).toHaveLength(2);
    expect(await source.open("p")).toHaveLength(2);
    fake.answer(
      "sessions:list",
      args(),
      page(
        [
          row({
            needsUser: true,
            listing: {
              activity: "waiting",
              waitingOn: "question",
              live: true,
              bornTicketless: true,
            },
          }),
        ],
        false,
        "next",
      ),
    );
    expect(paint.mock.lastCall?.[1][0].record.activity).toBe("waiting");
    fake.answer("sessions:list", args(), page([row({ id: "new" })], false, "changed"));
    expect(fake.watchers("sessions:list", args("next"))).toBe(0);
    fake.answer("sessions:list", args("changed"), page([row()]));
    expect(paint.mock.lastCall?.[1]).toHaveLength(2);
    fake.answer("sessions:list", args(), page([]));
    expect(paint.mock.lastCall?.[1]).toEqual([]);
    source.closeAll();
    source.close("missing");
    expect(fake.watchers("sessions:list", args())).toBe(0);
  });

  it("reads a warm query immediately and closes before an initial answer", async () => {
    const fake = fakeCloud();
    fake.answer("sessions:list", args(), page());
    const source = new CloudSessionSource(fake.session, vi.fn(), vi.fn());
    expect(await source.open("p")).toHaveLength(1);
    source.closeAll();
    const pending = source.open("p");
    source.closeAll();
    expect(await pending).toEqual([]);
  });

  it("surfaces a query error, retains displayed rows, and can reopen", async () => {
    const fake = fakeCloud();
    const paint = vi.fn();
    const failed = vi.fn();
    const source = new CloudSessionSource(fake.session, paint, failed);
    const pending = source.open("p");
    const error = new Error("not_found");
    fake.fail("sessions:list", args(), error);
    await expect(pending).rejects.toThrow("not_found");
    expect(failed).toHaveBeenCalledWith(error);
    expect(paint).not.toHaveBeenCalled();
    fake.answer("sessions:list", args(), page());
    expect(await source.open("p")).toHaveLength(1);
    fake.fail("sessions:list", args(), error);
    expect(paint).toHaveBeenCalledTimes(1);
    source.closeAll();
  });

  it("clears revoked rows for each authorization failure", async () => {
    const fake = fakeCloud();
    const paint = vi.fn();
    const source = new CloudSessionSource(fake.session, paint, vi.fn());
    fake.answer("sessions:list", args(), page());
    await source.open("p");
    fake.answer("sessions:list", args(), page([row()], false, "second"));
    fake.answer("sessions:list", args("second"), page([row({ id: "older" })]));
    for (const code of ["not_found", "not_a_member", "unauthenticated"]) {
      fake.fail("sessions:list", args(), { data: { code } });
      expect(paint.mock.lastCall?.[1]).toEqual([]);
      // Another page's queued cache update cannot resurrect revoked rows.
      fake.answer("sessions:list", args("second"), page([row({ id: "older" })]));
      expect(paint.mock.lastCall?.[1]).toEqual([]);
    }
    source.closeAll();
  });
});
