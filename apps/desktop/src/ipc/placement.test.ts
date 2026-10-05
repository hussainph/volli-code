/**
 * The runtime half of `placement.ts` (VC-574). Its mapped type already fails
 * typecheck on a missing or stale entry; this file holds what a type cannot:
 *
 *  - every runtime descriptor table main registers has an entry per channel;
 *  - a SOURCE read of `contract.ts` and `cursor-contract.ts` (oxc, the parser
 *    vite-plus ships) agrees with the table, which catches a hand-written
 *    contract drifting and an interface dropped from `VolliInvokeContract`'s
 *    `extends` (its channels would silently leave `VolliIpcChannel`);
 *  - the invariants on owners, reasons and split halves.
 *
 * Counts are deliberately not pinned: they shrink as each area moves.
 */
import { readFileSync } from "node:fs";
import { parseSync } from "vite/rolldown/utils";
import { describe, expect, it } from "vite-plus/test";
import { CLOUD_PLACEMENTS, CLOUD_PLACEMENT_OWNERS } from "@volli/shared";
import {
  AGENT_OBSERVABILITY_IPC,
  AUTOMATION_IPC,
  BROWSER_IPC,
  CLI_IPC,
  DATA_IPC,
  DATABASE_RECOVERY_IPC,
  DECISION_MODEL_IPC,
  FILE_IPC,
  HARNESS_IPC,
  MODEL_ACCESS_IPC,
  NOTIFICATION_IPC,
  ORPHAN_PROCESS_IPC,
  PI_SESSION_ORPHAN_IPC,
  SHELL_IPC,
  SUPPORT_IPC,
  THEME_IPC,
  UPDATE_IPC,
  WEB_ACCESS_IPC,
} from "../main/ipc-descriptors";
import {
  CURSOR_ASK_TO_LEAVE_CHANNEL,
  CURSOR_SETTLED_CHANNEL,
  CURSOR_SIZE_CHANNEL,
  CURSOR_STATE_CHANNEL,
  CURSOR_TAKE_OVER_CHANNEL,
} from "./cursor-contract";
import { CHANNEL_PLACEMENT, THEME_OWNER_RULING, type ChannelPlacement } from "./placement";

const PLACED = new Set(Object.keys(CHANNEL_PLACEMENT));
const ENTRIES = Object.entries(CHANNEL_PLACEMENT) as [string, ChannelPlacement][];

/** The slice of oxc's ESTree this file reads. */
interface AstNode {
  readonly type: string;
  readonly [field: string]: unknown;
}

function isNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && typeof (value as AstNode).type === "string";
}

function children(node: AstNode, field: string): AstNode[] {
  const value = node[field];
  return Array.isArray(value) ? value.filter(isNode) : [];
}

function child(node: AstNode, field: string): AstNode {
  const value = node[field];
  if (!isNode(value)) throw new Error(`${node.type}.${field} is not a node.`);
  return value;
}

function parseTopLevel(file: string): AstNode[] {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  const parsed = parseSync(file, source);
  if (parsed.errors.length > 0)
    throw new Error(`${file} failed to parse: ${parsed.errors[0]?.message}`);
  const program = parsed.program as unknown as AstNode;
  // `export interface …` wraps the declaration; a bare one is the statement itself.
  return children(program, "body").map((statement) =>
    statement.type === "ExportNamedDeclaration" && isNode(statement["declaration"])
      ? child(statement, "declaration")
      : statement,
  );
}

function identifierName(node: AstNode): string {
  if (node.type !== "Identifier") throw new Error(`Expected an Identifier, found ${node.type}.`);
  return node["name"] as string;
}

function stringLiteral(node: unknown): string | null {
  return isNode(node) && node.type === "Literal" && typeof node["value"] === "string"
    ? node["value"]
    : null;
}

/** Every `Volli…Contract` interface in `contract.ts`, with the `volli:` channels it declares. */
function readContract(): {
  interfaces: Map<string, string[]>;
  invokeExtends: string[];
  events: string[];
} {
  const interfaces = new Map<string, string[]>();
  let invokeExtends: string[] | null = null;
  let events: string[] | null = null;
  for (const declaration of parseTopLevel("./contract.ts")) {
    if (declaration.type === "TSInterfaceDeclaration") {
      const name = identifierName(child(declaration, "id"));
      if (!/^Volli\w*Contract$/.test(name)) continue;
      if (name === "VolliInvokeContract") {
        invokeExtends = children(declaration, "extends").map((heritage) =>
          identifierName(child(heritage, "expression")),
        );
        continue;
      }
      const channels: string[] = [];
      for (const member of children(child(declaration, "body"), "body")) {
        const key = stringLiteral(member["key"]);
        if (key?.startsWith("volli:")) channels.push(key);
      }
      interfaces.set(name, channels);
    }
    if (
      declaration.type === "TSTypeAliasDeclaration" &&
      identifierName(child(declaration, "id")) === "VolliIpcEvent"
    ) {
      events = children(child(declaration, "typeAnnotation"), "types").map((member) => {
        const literal = stringLiteral(member["literal"]);
        if (literal === null) throw new Error("VolliIpcEvent has a non-literal member.");
        return literal;
      });
    }
  }
  if (invokeExtends === null) throw new Error("contract.ts declares no VolliInvokeContract.");
  if (events === null) throw new Error("contract.ts declares no VolliIpcEvent union.");
  return { interfaces, invokeExtends, events };
}

/** `cursor-contract.ts`'s channel constants, and the names its `CursorOverlayChannel` union lists. */
function readCursorContract(): { constants: Map<string, string>; unionMembers: string[] } {
  const constants = new Map<string, string>();
  let unionMembers: string[] | null = null;
  for (const declaration of parseTopLevel("./cursor-contract.ts")) {
    if (declaration.type === "VariableDeclaration") {
      for (const declarator of children(declaration, "declarations")) {
        const value = stringLiteral(declarator["init"]);
        if (value?.startsWith("volli:"))
          constants.set(identifierName(child(declarator, "id")), value);
      }
    }
    if (
      declaration.type === "TSTypeAliasDeclaration" &&
      identifierName(child(declaration, "id")) === "CursorOverlayChannel"
    ) {
      unionMembers = children(child(declaration, "typeAnnotation"), "types").map((member) => {
        if (member.type !== "TSTypeQuery")
          throw new Error(`CursorOverlayChannel member is ${member.type}, not typeof CONSTANT.`);
        return identifierName(child(member, "exprName"));
      });
    }
  }
  if (unionMembers === null)
    throw new Error("cursor-contract.ts declares no CursorOverlayChannel.");
  return { constants, unionMembers };
}

describe("CHANNEL_PLACEMENT covers every channel", () => {
  it("has an entry for every channel of every runtime descriptor table", () => {
    const tables = {
      DATA_IPC,
      FILE_IPC,
      THEME_IPC,
      AUTOMATION_IPC,
      BROWSER_IPC,
      SHELL_IPC,
      HARNESS_IPC,
      CLI_IPC,
      SUPPORT_IPC,
      MODEL_ACCESS_IPC,
      WEB_ACCESS_IPC,
      DECISION_MODEL_IPC,
      AGENT_OBSERVABILITY_IPC,
      NOTIFICATION_IPC,
      UPDATE_IPC,
      PI_SESSION_ORPHAN_IPC,
      ORPHAN_PROCESS_IPC,
      DATABASE_RECOVERY_IPC,
    };
    const missing: string[] = [];
    for (const [table, descriptors] of Object.entries(tables)) {
      const channels = Object.keys(descriptors);
      expect(channels.length, `${table} is empty`).toBeGreaterThan(0);
      for (const channel of channels)
        if (!PLACED.has(channel)) missing.push(`${table}: ${channel}`);
    }
    expect(missing).toEqual([]);
  });

  it("matches contract.ts's source exactly: every Volli*Contract interface plus the event union", () => {
    const { interfaces, events } = readContract();
    const cursor = readCursorContract();
    const declared = new Set([
      ...[...interfaces.values()].flat(),
      ...events,
      ...cursor.constants.values(),
    ]);
    expect([...declared].filter((channel) => !PLACED.has(channel))).toEqual([]);
    expect([...PLACED].filter((channel) => !declared.has(channel))).toEqual([]);
    // One channel, one declaration: a name repeated across interfaces would
    // let the set above hide a second, differently-typed copy.
    const all = [...[...interfaces.values()].flat(), ...events, ...cursor.constants.values()];
    expect(all.length).toBe(declared.size);
  });

  it("finds no invoke interface dropped from VolliInvokeContract's extends", () => {
    const { interfaces, invokeExtends } = readContract();
    // The send contract is folded into VolliIpcChannel directly, not through extends.
    const invokeInterfaces = [...interfaces.entries()]
      .filter(([name, channels]) => name !== "VolliSendContract" && channels.length > 0)
      .map(([name]) => name);
    expect(invokeInterfaces.filter((name) => !invokeExtends.includes(name))).toEqual([]);
    expect(invokeExtends.filter((name) => !interfaces.has(name))).toEqual([]);
    expect(interfaces.get("VolliSendContract")?.length ?? 0).toBeGreaterThan(0);
  });

  it("places every cursor overlay channel, and CursorOverlayChannel names every constant", () => {
    const { constants, unionMembers } = readCursorContract();
    expect(unionMembers.toSorted()).toEqual([...constants.keys()].toSorted());
    const runtime = [
      CURSOR_STATE_CHANNEL,
      CURSOR_SETTLED_CHANNEL,
      CURSOR_SIZE_CHANNEL,
      CURSOR_TAKE_OVER_CHANNEL,
      CURSOR_ASK_TO_LEAVE_CHANNEL,
    ];
    expect(runtime.toSorted()).toEqual([...constants.values()].toSorted());
    for (const channel of runtime) expect(PLACED.has(channel), channel).toBe(true);
  });
});

describe("CHANNEL_PLACEMENT invariants", () => {
  const areaOwners: readonly string[] = CLOUD_PLACEMENT_OWNERS.filter((owner) => owner !== "stays");

  it("uses only the closed placement vocabulary and the allowed owners", () => {
    const placements = new Set<string>(CLOUD_PLACEMENTS);
    const bad = ENTRIES.filter(
      ([, entry]) =>
        !placements.has(entry.placement) ||
        (entry.owner !== "stays" && !areaOwners.includes(entry.owner)),
    ).map(([channel]) => channel);
    expect(bad).toEqual([]);
    // VC-564…573 and VC-575…578: VC-574 classifies, it moves nothing.
    const expected = [564, 565, 566, 567, 568, 569, 570, 571, 572, 573, 575, 576, 577, 578];
    expect(areaOwners.toSorted()).toEqual(expected.map((n) => `VC-${n}`));
  });

  it("gives every row a non-empty reason", () => {
    expect(ENTRIES.filter(([, entry]) => entry.reason.trim() === "").map(([c]) => c)).toEqual([]);
  });

  it("names an area owner on every host, workspace and split row", () => {
    const unowned = ENTRIES.filter(
      ([, entry]) => entry.placement !== "client-local" && !areaOwners.includes(entry.owner),
    ).map(([channel]) => channel);
    expect(unowned).toEqual([]);
  });

  it("describes both halves of every split row, and only split rows carry halves", () => {
    for (const [channel, entry] of ENTRIES) {
      const split = (entry as { split?: unknown }).split;
      if (entry.placement !== "split") {
        expect(split, channel).toBeUndefined();
        continue;
      }
      expect(["host", "workspace"], channel).toContain(entry.split.scope);
      expect(entry.split.host.trim(), `${channel} host half`).not.toBe("");
      expect(entry.split.client.trim(), `${channel} client half`).not.toBe("");
      expect(entry.split.host, channel).not.toBe(entry.split.client);
    }
  });

  it("keeps mixed-scope prompt templates host-owned with workspace authorization", () => {
    for (const channel of ["volli:prompt-template-create", "volli:prompt-templates"] as const) {
      expect(CHANNEL_PLACEMENT[channel]).toMatchObject({ placement: "host", owner: "VC-567" });
      expect(CHANNEL_PLACEMENT[channel].reason).toContain("workspace grant");
      expect(CHANNEL_PLACEMENT[channel].reason).toContain("host-wide");
      expect(CHANNEL_PLACEMENT[channel].reason).toContain("device-as-user");
    }
  });

  it("keeps the decided owner-ruling reason to the three per-project theme writes", () => {
    const decided = ENTRIES.filter(([, entry]) => entry.reason === THEME_OWNER_RULING);
    expect(decided.map(([channel]) => channel).toSorted()).toEqual([
      "volli:theme-appearance-set-project",
      "volli:theme-canvas-set-project",
      "volli:theme-set-project",
    ]);
    for (const [, entry] of decided) {
      expect(entry.placement).toBe("workspace");
      expect(entry.owner).toBe("VC-565");
    }
  });
});
