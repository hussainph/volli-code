/**
 * The catalog pattern proven end to end on a test-only area router
 * (`example-area.test-support.ts`), through the real builders: what VC-565
 * onward copies (HP § Command catalog, "Adding a command").
 */
import type { HostActor } from "@volli/host-protocol";
import type { CatalogKeyOf, VerbCatalogDeclaration, VerbEntry } from "@volli/shared";
import { describe, expect, expectTypeOf, it, vi } from "vite-plus/test";
import { z } from "zod";

import {
  createCatalogBuilders,
  hostErrorOf,
  LOCAL_DESKTOP_CALLER,
  PROJECT_RESOURCE,
  type CatalogCallerContext,
  type RouterCaller,
} from "./catalog";
import {
  createExampleAreaRouter,
  exampleAreaContext,
  ExampleTicketLedger,
  TICKET_RESOURCE,
  type ExampleAreaCatalogBinding,
  type ExampleAreaEntry,
} from "./example-area.test-support";
import { RpcDiagnosticLog } from "./index";

const WORKSPACE = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
const OTHER_WORKSPACE = "0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d";
const DEVICE = "7e8d9c0b-1a2f-4e3d-9c4b-5a6f7e8d9c0b";
const COMMAND = "3b241101-e2bb-4255-8caf-4136c566a962";
const OTHER_COMMAND = "9c858901-8a57-4791-81fe-4c455b099bc9";

function network(actor: HostActor): RouterCaller {
  return { actor, current: () => true };
}

const person = network({ kind: "device", deviceId: DEVICE, workspaceId: WORKSPACE });
const coordinator = network({ kind: "session", sessionId: "coordinator", workspaceId: WORKSPACE });
const pair = network({ kind: "session", sessionId: "pair", workspaceId: WORKSPACE });
const foreign = network({ kind: "session", sessionId: "stranger", workspaceId: WORKSPACE });

const ticket = (id: string, workspaceId: string, sessions: string[]) => ({
  id,
  workspaceId,
  sessions,
  parentId: null,
  afterId: null,
});

function ledger() {
  return new ExampleTicketLedger([
    // Several Sessions may coordinate on one ticket; none is "the owner".
    ticket("mine", WORKSPACE, ["coordinator", "pair"]),
    ticket("mine-2", WORKSPACE, ["coordinator"]),
    ticket("theirs", WORKSPACE, ["someone-else"]),
    ticket("elsewhere", OTHER_WORKSPACE, ["coordinator"]),
  ]);
}

function connect(caller: RouterCaller, tickets = ledger()) {
  const create = vi.spyOn(tickets, "create");
  const move = vi.spyOn(tickets, "move");
  const client = createExampleAreaRouter().createCaller(
    exampleAreaContext(tickets, caller, new RpcDiagnosticLog()),
  );
  return { client, tickets, create, move };
}

async function refusal(call: Promise<unknown>) {
  try {
    await call;
  } catch (error) {
    return hostErrorOf(error);
  }
  throw new Error("Expected the router to refuse this call");
}

const NOT_FOUND = {
  code: "NOT_FOUND",
  message: "Not found in this Workspace.",
  reason: "workspace-unknown",
};

describe("ticket.create: a session-own command-id write", () => {
  const input = { commandId: COMMAND, parentTicketId: "mine", title: "Sub-task" };

  it("admits the person, on any ticket in the Workspace", async () => {
    const { client, create } = connect(person);
    await expect(
      client.ticket.create({ ...input, parentTicketId: "theirs" }),
    ).resolves.toMatchObject({ status: "completed" });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("admits a Session the area's policy lets act on the subject, of several", async () => {
    const { client, tickets } = connect(coordinator);
    const receipt = await client.ticket.create(input);
    expect(tickets.tickets.get(receipt.ticketId)).toMatchObject({ parentId: "mine" });
    await expect(
      connect(pair).client.ticket.create({ ...input, commandId: OTHER_COMMAND }),
    ).resolves.toMatchObject({ status: "completed" });
  });

  it("refuses a Session the area's policy does not let act, before the handler", async () => {
    const { client, create } = connect(foreign);
    expect(await refusal(client.ticket.create(input))).toEqual({
      code: "FORBIDDEN",
      message: "ticket.create is open to a Session only on what its policy lets it act on.",
      reason: "verb-refused",
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("answers a parent in another Workspace exactly as an absent one", async () => {
    const { client, create } = connect(coordinator);
    const crossed = await refusal(client.ticket.create({ ...input, parentTicketId: "elsewhere" }));
    expect(crossed).toEqual(NOT_FOUND);
    expect(await refusal(client.ticket.create({ ...input, parentTicketId: "nope" }))).toEqual(
      crossed,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("replays the same intent and refuses another under the same command id", async () => {
    const { client, tickets } = connect(coordinator);
    const first = await client.ticket.create(input);
    expect(await client.ticket.create(input)).toEqual(first);
    expect(tickets.tickets.size).toBe(5);
    expect(await refusal(client.ticket.create({ ...input, title: "Other" }))).toEqual({
      code: "CONFLICT",
      message: `Command ${COMMAND} was already accepted with different intent`,
      reason: "command-conflict",
    });
  });

  it("lets the desktop's own window through with no port read at all", async () => {
    const tickets = ledger();
    const workspaceOf = vi.spyOn(tickets, "workspaceOf");
    const sessionMayAct = vi.spyOn(tickets, "sessionMayAct");
    const { client } = connect(LOCAL_DESKTOP_CALLER, tickets);
    await client.ticket.create({ ...input, parentTicketId: "elsewhere" });
    expect(workspaceOf).not.toHaveBeenCalled();
    expect(sessionMayAct).not.toHaveBeenCalled();
  });
});

describe("ticket.move: two resources", () => {
  const input = { commandId: COMMAND, ticketId: "mine", afterTicketId: "mine-2" };

  it("admits a coordinating Session on both, and the person on any", async () => {
    await expect(connect(coordinator).client.ticket.move(input)).resolves.toMatchObject({
      ticketId: "mine",
    });
    await expect(
      connect(person).client.ticket.move({ ...input, afterTicketId: "theirs" }),
    ).resolves.toMatchObject({ ticketId: "mine" });
  });

  it("refuses a second resource in another Workspace exactly as an absent one", async () => {
    for (const caller of [person, coordinator]) {
      const { client, move } = connect(caller);
      const crossed = await refusal(client.ticket.move({ ...input, afterTicketId: "elsewhere" }));
      expect(crossed).toEqual(NOT_FOUND);
      expect(await refusal(client.ticket.move({ ...input, afterTicketId: "nope" }))).toEqual(
        crossed,
      );
      expect(move).not.toHaveBeenCalled();
    }
  });

  // VC-564 A2 re-review B1': the ticket a move lands after is a reference.
  it("admits a Session to land after a ticket only someone else works on", async () => {
    const { client, move } = connect(coordinator);
    await expect(client.ticket.move({ ...input, afterTicketId: "theirs" })).resolves.toMatchObject({
      ticketId: "mine",
    });
    expect(move).toHaveBeenCalledTimes(1);
  });

  it("still refuses a referenced ticket in another Workspace exactly as an absent one", async () => {
    // The Session coordinates on `elsewhere`, but a reference is Workspace-checked all the same.
    const { client, move } = connect(coordinator);
    expect(await refusal(client.ticket.move({ ...input, afterTicketId: "elsewhere" }))).toEqual(
      NOT_FOUND,
    );
    expect(move).not.toHaveBeenCalled();
  });

  it("refuses a Session whose policy does not cover the subject, whatever the reference", async () => {
    const { client, move } = connect(coordinator);
    expect(
      await refusal(client.ticket.move({ ...input, ticketId: "theirs", afterTicketId: "mine" })),
    ).toMatchObject({ code: "FORBIDDEN", reason: "verb-refused" });
    expect(move).not.toHaveBeenCalled();
  });

  it("replays and conflicts by command id, like every command-id entry", async () => {
    const { client } = connect(coordinator);
    const first = await client.ticket.move(input);
    expect(await client.ticket.move(input)).toEqual(first);
    expect(
      await refusal(client.ticket.move({ ...input, ticketId: "mine-2", afterTicketId: "mine" })),
    ).toMatchObject({ code: "CONFLICT", reason: "command-conflict" });
    // A fresh command id is a fresh intent.
    await expect(
      client.ticket.move({ commandId: OTHER_COMMAND, ticketId: "mine-2", afterTicketId: "mine" }),
    ).resolves.toMatchObject({ ticketId: "mine-2" });
  });
});

/** A one-entry catalog, literally typed, for the rules no example command reaches. */
function area<
  const Catalog extends VerbCatalogDeclaration,
  const Key extends string = "area.write",
>(catalog: Catalog, key: Key = "area.write" as Key) {
  return {
    key,
    accessModes: ["hostApi"],
    actor: "user",
    handler: { site: "main", id: key },
    listed: false,
    group: "Write",
    summary: "A synthetic area write.",
    options: [],
    catalog,
  } satisfies VerbEntry;
}

describe("the area's builder family", () => {
  it("binds the example router to its catalog exactly, at compile time", () => {
    expectTypeOf<ExampleAreaCatalogBinding>().toEqualTypeOf<never>();
    expectTypeOf<CatalogKeyOf<ExampleAreaEntry>>().toEqualTypeOf<"ticket.create" | "ticket.move">();
  });

  it("wires its ports to its own resource kind only", async () => {
    const tickets = ledger();
    const context = exampleAreaContext(tickets, person, new RpcDiagnosticLog());
    expect(await context.resourceWorkspace?.({ kind: TICKET_RESOURCE, id: "mine" })).toBe(
      WORKSPACE,
    );
    expect(await context.resourceWorkspace?.({ kind: "terminal", id: "mine" })).toBeNull();
    expect(await context.sessionMayAct?.({ kind: "terminal", id: "mine" }, "coordinator")).toBe(
      false,
    );
    expect(
      await context.sessionMayAct?.({ kind: TICKET_RESOURCE, id: "nope" }, "coordinator"),
    ).toBe(false);
  });

  it("refuses at construction a withholding entry whose input has no command.kind", () => {
    const withholding = area({
      actor: "any",
      scope: "workspace",
      idempotency: "command-id",
      refusedIntents: ["area.start"],
    });
    const { workspaceProcedure } = createCatalogBuilders<CatalogCallerContext, typeof withholding>({
      entries: [withholding],
    });
    const named = () => ({ kind: PROJECT_RESOURCE, id: WORKSPACE });
    for (const schema of [
      z.object({ commandId: z.string() }),
      z.object({ command: z.string() }),
      z.object({ command: z.object({ name: z.string() }) }),
      z.string(),
    ]) {
      expect(() =>
        // @ts-expect-error -- a withholding entry's input must be a command.kind envelope.
        workspaceProcedure("area.write", schema, named),
      ).toThrow("Catalog entry area.write withholds intents, but its input has no command.kind");
    }
    expect(() =>
      workspaceProcedure(
        "area.write",
        z.object({ command: z.object({ kind: z.string() }) }),
        named,
      ),
    ).not.toThrow();
  });

  it("judges what a resolver names: a project by itself, nothing and unknown kinds never", async () => {
    const entry = area({ actor: "any", scope: "workspace", idempotency: "natural" });
    const { workspaceProcedure, catalogRouter } = createCatalogBuilders<
      CatalogCallerContext,
      typeof entry
    >({
      entries: [entry],
    });
    const handler = vi.fn(() => "done");
    const router = catalogRouter({
      area: {
        write: workspaceProcedure(
          "area.write",
          z.object({ named: z.array(z.object({ kind: z.string(), id: z.string() })) }),
          ({ named }) => named,
        )
          .output(z.string())
          .mutation(handler),
      },
    });
    const call = (named: { kind: string; id: string }[]) =>
      router
        .createCaller({ caller: person, diagnostics: new RpcDiagnosticLog() })
        .area.write({ named });
    await expect(call([{ kind: PROJECT_RESOURCE, id: WORKSPACE }])).resolves.toBe("done");
    expect(await refusal(call([]))).toEqual(NOT_FOUND);
    // No port answers a kind it was not given: refused like an absent one.
    expect(await refusal(call([{ kind: "terminal", id: "t" }]))).toEqual(NOT_FOUND);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("admits no Session without a predicate, or with no subject to judge (fail closed)", async () => {
    const entry = area({ actor: "session-own", scope: "workspace", idempotency: "natural" });
    const { workspaceProcedure, catalogRouter } = createCatalogBuilders<
      CatalogCallerContext,
      typeof entry
    >({
      entries: [entry],
    });
    const handler = vi.fn(() => "done");
    const router = catalogRouter({
      area: {
        write: workspaceProcedure(
          "area.write",
          z.object({ relation: z.enum(["subject", "reference"]) }),
          ({ relation }) => ({ kind: PROJECT_RESOURCE, id: WORKSPACE, relation }),
        )
          .output(z.string())
          .mutation(handler),
      },
    });
    const diagnostics = new RpcDiagnosticLog();
    const unjudged = router.createCaller({ caller: coordinator, diagnostics });
    const permissive = router.createCaller({
      caller: coordinator,
      diagnostics,
      sessionMayAct: () => true,
    });
    for (const call of [
      unjudged.area.write({ relation: "subject" }),
      permissive.area.write({ relation: "reference" }),
    ]) {
      expect(await refusal(call)).toMatchObject({ reason: "verb-refused" });
    }
    expect(handler).not.toHaveBeenCalled();
    await expect(permissive.area.write({ relation: "subject" })).resolves.toBe("done");
  });

  it("accepts only its own family's procedures, and names its legacy outputs from its catalog", () => {
    const entry = area({ scope: "host", idempotency: "read" }, "area.read");
    const first = createCatalogBuilders<CatalogCallerContext, typeof entry>({ entries: [entry] });
    const second = createCatalogBuilders<CatalogCallerContext, typeof entry>({ entries: [entry] });
    const procedure = first
      .hostProcedure("area.read")
      .output(z.null())
      .query(() => null);
    expect(() => second.catalogRouter({ area: { read: procedure } })).toThrow(
      "Procedure area.read was not built from its catalog entry",
    );
    expect(() => first.catalogRouter({ area: { read: procedure } })).not.toThrow();
    expect(() =>
      createCatalogBuilders<CatalogCallerContext, typeof entry>({
        entries: [entry],
        legacyUnvalidatedOutputs: ["area.unknown" as never],
      }),
    ).toThrow("No catalog entry declares area.unknown");
  });
});
