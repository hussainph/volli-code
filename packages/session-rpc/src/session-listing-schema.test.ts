/**
 * The Session listing's wire grammar is frozen from the start (VC-713, AM3):
 * every array and string bounded, every enum closed.
 */
import { z } from "zod";
import {
  EMPTY_SESSION_USAGE_SUMMARY,
  PERSON_STARTED,
  SESSION_LISTING_BOUNDS,
  type SessionListingRow,
} from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import { sessionProcedureSchemas } from "./index";
import { sessionListingPageSchema, sessionListingRowSchema } from "./session-listing-schema";

const row: SessionListingRow = {
  kind: "chat",
  record: {
    sessionId: "s",
    title: "Remote",
    projectId: "p",
    ticketId: null,
    createdAt: 1,
    adapterId: "pi",
    live: true,
    activity: "waiting",
    waitingOn: "question",
    outcome: null,
    lastActivityAt: 2,
    bornTicketless: true,
    role: "project",
    parentSessionId: null,
    model: null,
  },
  usage: EMPTY_SESSION_USAGE_SUMMARY,
  provenance: PERSON_STARTED,
};

describe("the Session listing's wire grammar (VC-713)", () => {
  it("accepts a row as the host answers it, and a page up to its bound", () => {
    expect(sessionListingRowSchema.parse(row)).toEqual(row);
    const full = Array.from({ length: SESSION_LISTING_BOUNDS.rows }, () => row);
    expect(sessionListingPageSchema.safeParse({ sessions: full, omitted: 3 }).success).toBe(true);
  });

  it("refuses a page past its bound and a string past its own", () => {
    const over = Array.from({ length: SESSION_LISTING_BOUNDS.rows + 1 }, () => row);
    expect(sessionListingPageSchema.safeParse({ sessions: over, omitted: 0 }).success).toBe(false);
    const title = "t".repeat(SESSION_LISTING_BOUNDS.text + 1);
    expect(
      sessionListingRowSchema.safeParse({ ...row, record: { ...row.record, title } }).success,
    ).toBe(false);
  });

  it("refuses a value no closed enum has", () => {
    for (const record of [
      { ...row.record, activity: "parked" },
      { ...row.record, waitingOn: "money" },
      { ...row.record, role: "worker" },
    ]) {
      expect(sessionListingRowSchema.safeParse({ ...row, record }).success).toBe(false);
    }
    expect(sessionListingRowSchema.safeParse({ ...row, kind: "browser" }).success).toBe(false);
  });

  it("publishes every string and array bounded, and no open union", () => {
    const published = JSON.stringify(
      z.toJSONSchema(sessionProcedureSchemas()["session.listing"]!.output, { io: "output" }),
    );
    expect(published).not.toContain("x-volli-open-union");
    const unbounded: string[] = [];
    const walk = (node: unknown, at: string): void => {
      if (Array.isArray(node))
        return node.forEach((child, index) => walk(child, `${at}[${index}]`));
      if (typeof node !== "object" || node === null) return;
      const schema = node as Record<string, unknown>;
      if (
        schema["type"] === "string" &&
        schema["enum"] === undefined &&
        schema["const"] === undefined
      )
        if (typeof schema["maxLength"] !== "number") unbounded.push(at);
      if (schema["type"] === "array" && typeof schema["maxItems"] !== "number") unbounded.push(at);
      for (const [key, child] of Object.entries(schema)) walk(child, `${at}.${key}`);
    };
    walk(JSON.parse(published), "$");
    expect(unbounded).toEqual([]);
  });
});
