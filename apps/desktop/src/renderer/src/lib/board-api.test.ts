/**
 * The board's per-surface door (VC-889): `window.api`'s own functions for
 * this Mac's projects, the protocol facade for a remote host's, and Volli
 * Cloud's in a cloud launch, each call routed by its project.
 */
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { LOCAL_LAUNCH } from "@volli/shared";

import { adoptLaunch } from "@renderer/stores/launch";
import { boardApi, routedBoardApi, type BoardApi } from "./board-api";
import { startBoardProtocol, stopBoardProtocol } from "./board-protocol";

vi.mock("./cloud-client", () => ({ cloudSession: () => null }));

afterEach(() => {
  stopBoardProtocol();
  adoptLaunch(LOCAL_LAUNCH);
  vi.unstubAllGlobals();
});

describe("boardApi in a local launch with the protocol off", () => {
  it("answers with window.api's own functions, untouched, flag on as off", async () => {
    const api = {
      tickets: {
        events: vi.fn(async () => "events"),
        body: vi.fn(async () => "body"),
        latestSignals: vi.fn(async () => "signals"),
        statusEntries: vi.fn(async () => "entries"),
      },
      comments: {
        list: vi.fn(async () => "list"),
        create: vi.fn(async () => "create"),
        update: vi.fn(async () => "update"),
        remove: vi.fn(async () => "remove"),
      },
      projects: {
        update: vi.fn(async () => "project"),
        setSkillModes: vi.fn(async () => "modes"),
        setSessionDefaults: vi.fn(async () => "defaults"),
        checkFolder: vi.fn(async () => "folder"),
      },
    };
    vi.stubGlobal("window", { api });
    const door = boardApi();

    const answers = await Promise.all([
      door.tickets.events({ ticketId: "a" }),
      door.tickets.body({ ticketId: "a" }),
      door.tickets.latestSignals({ projectId: "p1" }),
      door.tickets.statusEntries({ projectId: "p1" }),
      door.comments.list({ ticketId: "a" }),
      door.comments.create({ ticketId: "a", body: "hi" }),
      door.comments.update({ commentId: "c", body: "edit" }),
      door.comments.remove({ commentId: "c" }),
      door.projects.update({ id: "p1", baseBranch: "main" }),
      door.projects.setSkillModes({ id: "p1", modes: {} }),
      door.projects.setSessionDefaults({ id: "p1", model: null }),
      door.projects.checkFolder("p1"),
    ]);

    expect(answers).toEqual([
      "events",
      "body",
      "signals",
      "entries",
      "list",
      "create",
      "update",
      "remove",
      "project",
      "modes",
      "defaults",
      "folder",
    ]);
    expect(api.tickets.events).toHaveBeenCalledWith({ ticketId: "a" });
    expect(api.tickets.body).toHaveBeenCalledWith({ ticketId: "a" });
    expect(api.tickets.latestSignals).toHaveBeenCalledWith({ projectId: "p1" });
    expect(api.tickets.statusEntries).toHaveBeenCalledWith({ projectId: "p1" });
    expect(api.comments.list).toHaveBeenCalledWith({ ticketId: "a" });
    expect(api.comments.create).toHaveBeenCalledWith({ ticketId: "a", body: "hi" });
    expect(api.comments.update).toHaveBeenCalledWith({ commentId: "c", body: "edit" });
    expect(api.comments.remove).toHaveBeenCalledWith({ commentId: "c" });
    expect(api.projects.update).toHaveBeenCalledWith({ id: "p1", baseBranch: "main" });
    expect(api.projects.setSkillModes).toHaveBeenCalledWith({ id: "p1", modes: {} });
    expect(api.projects.setSessionDefaults).toHaveBeenCalledWith({ id: "p1", model: null });
    expect(api.projects.checkFolder).toHaveBeenCalledWith("p1");
  });
});

/** A door that answers each call with its own name and which door it was. */
function namedDoor(name: string): BoardApi {
  const answer =
    (call: string) =>
    async (..._args: unknown[]) =>
      `${name}:${call}` as never;
  return {
    tickets: {
      events: answer("events"),
      body: answer("body"),
      latestSignals: answer("latestSignals"),
      statusEntries: answer("statusEntries"),
    },
    comments: {
      list: answer("list"),
      create: answer("create"),
      update: answer("update"),
      remove: answer("remove"),
    },
    projects: {
      update: answer("update"),
      setSkillModes: answer("setSkillModes"),
      setSessionDefaults: answer("setSessionDefaults"),
      checkFolder: answer("checkFolder"),
    },
  };
}

describe("routing each call by its project's place", () => {
  it("sends a remote project's, ticket's or comment's call to the remote door, the rest local", async () => {
    const api = routedBoardApi(namedDoor("local"), namedDoor("remote"), {
      projectIsRemote: (id) => id === "r",
      ticketIsRemote: (id) => id === "rt",
      commentIsRemote: (id) => id === "rc",
    });
    expect(
      await Promise.all([
        api.tickets.events({ ticketId: "rt" }),
        api.tickets.body({ ticketId: "t" }),
        api.tickets.latestSignals({ projectId: "r" }),
        api.tickets.statusEntries({ projectId: "p" }),
        api.comments.list({ ticketId: "rt" }),
        api.comments.create({ ticketId: "t", body: "b" }),
        api.comments.update({ commentId: "rc", body: "b" }),
        api.comments.remove({ commentId: "c" }),
        api.projects.update({ id: "r", baseBranch: null }),
        api.projects.setSkillModes({ id: "p", modes: {} }),
        api.projects.setSessionDefaults({ id: "r", model: null }),
        api.projects.checkFolder("p"),
      ]),
    ).toEqual([
      "remote:events",
      "local:body",
      "remote:latestSignals",
      "local:statusEntries",
      "remote:list",
      "local:create",
      "remote:update",
      "local:remove",
      "remote:update",
      "local:setSkillModes",
      "remote:setSessionDefaults",
      "local:checkFolder",
    ]);
  });

  it("with the protocol on, keeps this Mac's projects on window.api and a followed board's on the facade", async () => {
    const statusEntries = vi.fn(async () => ({ ok: true, entries: [] }));
    const body = vi.fn(async () => ({ ok: true, body: "local" }));
    const remove = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("window", {
      api: { tickets: { statusEntries, body }, comments: { remove }, projects: {} },
    });
    const { sync, commentTickets } = startBoardProtocol({
      view: {
        paint: vi.fn(),
        adoptProject: vi.fn(),
        notePlanningChange: vi.fn(),
        checkoutMoved: vi.fn(),
        failed: vi.fn(),
      },
      client: {} as never,
      clientFor: () =>
        ({
          board: {
            statusEntries: { query: async () => ["remote"] },
            ticketBody: { query: async () => ({ body: "remote" }) },
          },
        }) as never,
    });
    vi.spyOn(sync, "follows").mockImplementation((id) => id === "r1");
    vi.spyOn(sync, "projectOf").mockImplementation((id) => (id === "rt" ? "r1" : undefined));
    commentTickets.note("rc", "rt");
    commentTickets.note("lc", "lt");

    expect(await boardApi().tickets.statusEntries({ projectId: "p1" })).toEqual({
      ok: true,
      entries: [],
    });
    expect(await boardApi().tickets.statusEntries({ projectId: "r1" })).toEqual({
      ok: true,
      entries: ["remote"],
    });
    expect(await boardApi().tickets.body({ ticketId: "lt" })).toEqual({ ok: true, body: "local" });
    expect(await boardApi().tickets.body({ ticketId: "rt" })).toEqual({ ok: true, body: "remote" });
    await boardApi().comments.remove({ commentId: "lc" });
    await boardApi().comments.remove({ commentId: "unknown" });
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it("sends everything to Volli Cloud's door in a cloud launch", async () => {
    adoptLaunch({ store: "cloud", userId: "u", backendUrl: "http://127.0.0.1:1" });
    expect(await boardApi().tickets.body({ ticketId: "t" })).toEqual({
      ok: false,
      error: "Volli Cloud isn’t connected yet.",
    });
  });
});
