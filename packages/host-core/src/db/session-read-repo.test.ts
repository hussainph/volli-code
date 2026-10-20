import { afterEach, describe, expect, it } from "vite-plus/test";
import type Database from "better-sqlite3";
import { SESSION_READ } from "@volli/shared";

import { insertProject } from "./projects-repo";
import {
  markSessionUnread,
  readSessionUnread,
  readSessionUnreads,
  writeSessionUnread,
} from "./session-read-repo";
import { openTestDb, testProject } from "./test-helpers";
import type { TestDb } from "./test-helpers";

let ctx: TestDb;

afterEach(() => {
  ctx.cleanup();
});

interface Fixture {
  db: Database.Database;
  session(id: string): string;
}

function fixture(): Fixture {
  ctx = openTestDb();
  const project = testProject();
  insertProject(ctx.db, project);
  return {
    db: ctx.db,
    session(id) {
      ctx.db
        .prepare(
          "INSERT INTO sessions (id, project_id, ticket_id, title, created_at) VALUES (?,?,?,?,?)",
        )
        .run(id, project.id, null, "A Session", 1_000);
      return id;
    },
  };
}

describe("readSessionUnread", () => {
  it("rests at read for a Session with no receipt at all", () => {
    const f = fixture();
    f.session("s1");

    expect(readSessionUnread(f.db, "s1")).toEqual(SESSION_READ);
  });

  it("answers the resting state for a Session that does not exist", () => {
    const f = fixture();

    expect(readSessionUnread(f.db, "never-minted")).toEqual(SESSION_READ);
  });

  it("reads back the stamp a mark wrote", () => {
    const f = fixture();
    f.session("s1");

    markSessionUnread(f.db, "s1", 4_000);

    expect(readSessionUnread(f.db, "s1")).toEqual({ unreadSince: 4_000 });
  });
});

describe("readSessionUnreads", () => {
  it("answers a whole roster, with the resting state for every miss", () => {
    const f = fixture();
    f.session("s1");
    f.session("s2");
    f.session("s3");
    markSessionUnread(f.db, "s2", 7_000);
    // A receipt that was marked and then read again: present in the table,
    // resting in the answer.
    writeSessionUnread(f.db, "s3", 5_000);
    writeSessionUnread(f.db, "s3", null);

    const readOf = readSessionUnreads(f.db, ["s1", "s2", "s3"]);

    expect(readOf("s1")).toEqual(SESSION_READ);
    expect(readOf("s2")).toEqual({ unreadSince: 7_000 });
    expect(readOf("s3")).toEqual(SESSION_READ);
    // A Session the batch was never asked about is not an error; it is the
    // same "nothing to say" every unrecorded Session gets.
    expect(readOf("s4")).toEqual(SESSION_READ);
  });

  it("asks nothing of the database for an empty roster", () => {
    const f = fixture();

    expect(readSessionUnreads(f.db, [])("s1")).toEqual(SESSION_READ);
  });

  it("answers a repeated id once", () => {
    const f = fixture();
    f.session("s1");
    markSessionUnread(f.db, "s1", 2_000);

    const readOf = readSessionUnreads(f.db, ["s1", "s1"]);

    expect(readOf("s1")).toEqual({ unreadSince: 2_000 });
  });
});

describe("writeSessionUnread", () => {
  it("marks read, and is idempotent", () => {
    const f = fixture();
    f.session("s1");
    markSessionUnread(f.db, "s1", 3_000);

    writeSessionUnread(f.db, "s1", null);
    writeSessionUnread(f.db, "s1", null);

    expect(readSessionUnread(f.db, "s1")).toEqual(SESSION_READ);
  });

  it("restamps when a person says unread again", () => {
    const f = fixture();
    f.session("s1");

    writeSessionUnread(f.db, "s1", 3_000);
    writeSessionUnread(f.db, "s1", 9_000);

    // A person's mark means "as of now" — unlike the automatic edge below.
    expect(readSessionUnread(f.db, "s1")).toEqual({ unreadSince: 9_000 });
  });

  it("marks a Session read that never had a receipt", () => {
    const f = fixture();
    f.session("s1");

    writeSessionUnread(f.db, "s1", null);

    expect(readSessionUnread(f.db, "s1")).toEqual(SESSION_READ);
  });
});

describe("markSessionUnread", () => {
  it("does not restamp a Session that is already unread", () => {
    const f = fixture();
    f.session("s1");

    markSessionUnread(f.db, "s1", 3_000);
    markSessionUnread(f.db, "s1", 9_000);

    // The dot's age answers "how long has this been waiting on me", so the
    // first unattended turn is the stamp that stands.
    expect(readSessionUnread(f.db, "s1")).toEqual({ unreadSince: 3_000 });
  });

  it("marks again after the Session was read", () => {
    const f = fixture();
    f.session("s1");
    markSessionUnread(f.db, "s1", 3_000);
    writeSessionUnread(f.db, "s1", null);

    markSessionUnread(f.db, "s1", 9_000);

    expect(readSessionUnread(f.db, "s1")).toEqual({ unreadSince: 9_000 });
  });
});
