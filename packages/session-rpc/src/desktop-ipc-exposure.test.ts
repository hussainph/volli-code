/**
 * Compile-time proof (part of `pnpm typecheck`; this package's tsconfig
 * includes `src`) that the IPC exposure table is total over EVERY router it
 * covers, not only over namespaces they share (VC-608 review B1). Each
 * `@ts-expect-error` is a classification missing or invented: if the table
 * stopped catching it, the directive itself would fail to compile.
 */
import { initTRPC } from "@trpc/server";
import { describe, expectTypeOf, it } from "vite-plus/test";

import type { ProcedurePaths, RouterProcedurePaths } from "./catalog";
import type { IpcExposureTable } from "./desktop-ipc";

// Two routers from independent tRPC instances, sharing no namespace: the
// shape of the Session router beside an area router (VC-565's board).
const left = initTRPC.create();
const right = initTRPC.context<{ area: true }>().create();
const sessionLike = left.router({
  session: { snapshot: left.procedure.query(() => 1), subscribe: left.procedure.query(() => 2) },
});
const boardLike = right.router({ ticket: { move: right.procedure.mutation(() => 3) } });
type Routers = typeof sessionLike | typeof boardLike;

// Every row: accepted.
const complete = {
  "session.snapshot": "ipc",
  "session.subscribe": "ipc",
  "ticket.move": "websocket-only",
} satisfies IpcExposureTable<Routers>;

// The second router's path left unclassified.
const missingArea = {
  "session.snapshot": "ipc",
  "session.subscribe": "ipc",
  // @ts-expect-error -- "ticket.move" has no classification.
} satisfies IpcExposureTable<Routers>;

// The first router's path left unclassified.
const missingSession = {
  "session.snapshot": "ipc",
  "ticket.move": "ipc",
  // @ts-expect-error -- "session.subscribe" has no classification.
} satisfies IpcExposureTable<Routers>;

// The empty table the non-distributive form accepted.
// @ts-expect-error -- every path is missing.
const empty = {} satisfies IpcExposureTable<Routers>;

const invented = {
  "session.snapshot": "ipc",
  "session.subscribe": "ipc",
  "ticket.move": "ipc",
  // @ts-expect-error -- a row for a path no router publishes.
  "ticket.nonsense": "ipc",
} satisfies IpcExposureTable<Routers>;

void [complete, missingArea, missingSession, empty, invented];

describe("the exposure table's paths", () => {
  it("are every path of each router, never only the namespaces they share", () => {
    expectTypeOf<RouterProcedurePaths<Routers>>().toEqualTypeOf<
      "session.snapshot" | "session.subscribe" | "ticket.move"
    >();
    expectTypeOf<
      ProcedurePaths<(typeof sessionLike)["_def"]["record"] | (typeof boardLike)["_def"]["record"]>
    >().toEqualTypeOf<"session.snapshot" | "session.subscribe" | "ticket.move">();
  });
});
