/** Release peer support, deliberately independent of today's Zod/catalog schemas. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { initTRPC, tracked, TRPCError, type AnyRouter } from "@trpc/server";
import { getUntypedClient } from "@trpc/client";
import {
  expectHostError,
  ipcContractLink,
  recordSubscription,
  webSocketContractLink,
} from "@volli/host-protocol/testing";
import { expect } from "vite-plus/test";

type JsonSchema = Record<string, unknown>;
export interface FrozenProcedure {
  kind: "query" | "mutation" | "subscription";
  input: JsonSchema;
  output: JsonSchema;
  noInput: boolean;
  voidOutput: boolean;
}
export interface PeerExchange {
  procedure: string;
  input: unknown;
  output?: unknown;
  frames?: unknown[];
  error?: { code: string; message: string; reason?: string };
}
export interface PeerRecording {
  provenance: { tag: string; commit: string; how: string; distributed: boolean };
  transport: "ipc" | "websocket";
  exchanges: PeerExchange[];
  /** The deterministic harness's native recording, for replay against the next host. */
  recording: unknown;
}
export interface CanaryPeerBundle {
  format: "volli-canary-peer-v1";
  provenance: { tag: string; commit: string; distributed: boolean };
  schema: { protocolVersion: number; tiers: { public: Record<string, FrozenProcedure> } };
  recordings: Record<string, PeerRecording>;
  followups: string[];
}
export const DEFAULT_CANARY_PEER = new URL(
  "../../../apps/desktop/src/main/session-rpc-wire-fixtures/canary-peer.json",
  import.meta.url,
);

/** Missing default is the ONLY bootstrap case. An explicitly selected missing/bad peer fails. */
export function loadCanaryPeer(
  path = process.env.VOLLI_CANARY_PEER_BUNDLE,
): CanaryPeerBundle | null {
  const target = path || DEFAULT_CANARY_PEER;
  if (!path && !existsSync(target)) return null;
  const value = JSON.parse(readFileSync(target, "utf8")) as CanaryPeerBundle;
  if (
    value.format !== "volli-canary-peer-v1" ||
    !value.provenance?.tag ||
    !/^[a-f0-9]{40}$/.test(value.provenance?.commit ?? "") ||
    typeof value.provenance.distributed !== "boolean" ||
    !value.schema?.tiers?.public ||
    value.schema.protocolVersion !== 1 ||
    (value.provenance.distributed
      ? !/^v\d+\.\d+\.\d+-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*$/.test(value.provenance.tag)
      : value.provenance.tag !== `dry-run-${value.provenance.commit}`) ||
    Object.keys(value.schema.tiers).some((tier) => tier !== "public") ||
    !value.recordings ||
    !Array.isArray(value.followups)
  )
    throw new Error("Malformed canary peer bundle");
  for (const recording of Object.values(value.recordings)) {
    if (
      !recording.provenance?.how ||
      recording.provenance.tag !== value.provenance.tag ||
      recording.provenance.commit !== value.provenance.commit ||
      recording.provenance.distributed !== value.provenance.distributed ||
      !["ipc", "websocket"].includes(recording.transport) ||
      !Array.isArray(recording.exchanges) ||
      !recording.exchanges.length
    )
      throw new Error("Malformed canary peer recording/provenance");
    for (const exchange of recording.exchanges) {
      const schema = value.schema.tiers.public[exchange.procedure];
      if (
        !schema ||
        !["query", "mutation", "subscription"].includes(schema.kind) ||
        !schema.input ||
        !schema.output ||
        typeof schema.noInput !== "boolean" ||
        typeof schema.voidOutput !== "boolean"
      )
        throw new Error(`Non-public/unknown recorded procedure: ${exchange.procedure}`);
      validateExchange(value, exchange);
    }
  }
  return value;
}

function canonical(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(canonical);
  if (node && typeof node === "object")
    return Object.fromEntries(
      Object.entries(node)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonical(child)]),
    );
  return node;
}

function requestKey(value: unknown): string {
  return JSON.stringify(canonical(value ?? null));
}

function fail(): never {
  throw new Error("Value violates the recorded canary schema");
}

/** JSON Schema 2020-12 subset emitted by the committed protocol generator.
 * Never imports current validators; unknown assertion keywords fail closed.
 * Output objects tolerate additions (the old consumer cannot read those fields).
 */
export function validateFrozen(
  schema: JsonSchema,
  value: unknown,
  root = schema,
  output = true,
): void {
  const annotations = new Set([
    "$schema",
    "$defs",
    "description",
    "title",
    "default",
    "examples",
    "readOnly",
    "x-volli-open-union",
    "x-volli-open-enum",
  ]);
  const supported = new Set([
    "$ref",
    "type",
    "const",
    "enum",
    "anyOf",
    "oneOf",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "propertyNames",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "minLength",
    "maxLength",
    "pattern",
    "format",
    "minItems",
    "maxItems",
  ]);
  for (const key of Object.keys(schema))
    if (!annotations.has(key) && !supported.has(key))
      throw new Error(`Unsupported frozen schema keyword ${key}`);
  if (schema.$ref) {
    if (typeof schema.$ref !== "string" || !schema.$ref.startsWith("#/")) return fail();
    let ref: unknown = root;
    for (const part of schema.$ref.slice(2).split("/"))
      ref = (ref as JsonSchema)?.[part.replaceAll("~1", "/").replaceAll("~0", "~")];
    if (!ref || typeof ref !== "object") return fail();
    validateFrozen(
      {
        ...ref,
        ...("x-volli-open-enum" in schema
          ? { "x-volli-open-enum": schema["x-volli-open-enum"] }
          : {}),
      },
      value,
      root,
      output,
    );
  }
  for (const union of ["anyOf", "oneOf"] as const)
    if (Array.isArray(schema[union])) {
      const branches = schema[union] as JsonSchema[];
      const discriminator = schema["x-volli-open-union"];
      let unknownVariant = false;
      if (output && typeof discriminator === "string" && isObject(value)) {
        const tags = branches.flatMap((branch) => {
          const property = (branch.properties as Record<string, JsonSchema>)[discriminator];
          return "const" in property ? [property.const] : (property.enum as unknown[]);
        });
        const tag = value[discriminator];
        unknownVariant =
          ["string", "number", "boolean"].includes(typeof tag) &&
          tags.some((known) => typeof known === typeof tag) &&
          !tags.some((known) => known === tag);
      }
      const passes = branches.filter((branch) => {
        try {
          validateFrozen(branch, value, root, output);
          return true;
        } catch {
          return false;
        }
      }).length;
      if (!unknownVariant && (!passes || (union === "oneOf" && passes !== 1))) return fail();
    }
  const vocabulary = Array.isArray(schema.enum) ? schema.enum : [schema.const];
  const openScalar =
    output &&
    schema["x-volli-open-enum"] === true &&
    ["string", "number", "boolean"].includes(typeof value) &&
    vocabulary.some((known) => typeof known === typeof value);
  if ("const" in schema && JSON.stringify(value) !== JSON.stringify(schema.const) && !openScalar)
    return fail();
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((v) => JSON.stringify(v) === JSON.stringify(value)) &&
    !openScalar
  )
    return fail();
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const matches = types.some((type) =>
      type === "null"
        ? value === null
        : type === "array"
          ? Array.isArray(value)
          : type === "object"
            ? typeof value === "object" && value !== null && !Array.isArray(value)
            : type === "integer"
              ? Number.isSafeInteger(value)
              : typeof value === type,
    );
    if (!matches) return fail();
  }
  if (typeof value === "number") {
    if (
      !Number.isFinite(value) ||
      (typeof schema.minimum === "number" && value < schema.minimum) ||
      (typeof schema.maximum === "number" && value > schema.maximum) ||
      (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) ||
      (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum)
    )
      return fail();
  }
  if (typeof value === "string") {
    if (
      (typeof schema.minLength === "number" && [...value].length < schema.minLength) ||
      (typeof schema.maxLength === "number" && [...value].length > schema.maxLength) ||
      (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value))
    )
      return fail();
    if (
      schema.format === "uuid" &&
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)
    )
      return fail();
    if (schema.format && schema.format !== "uuid")
      throw new Error(`Unsupported frozen format ${schema.format}`);
  }
  if (Array.isArray(value)) {
    if (
      (typeof schema.minItems === "number" && value.length < schema.minItems) ||
      (typeof schema.maxItems === "number" && value.length > schema.maxItems)
    )
      return fail();
    if (schema.items)
      for (const item of value) validateFrozen(schema.items as JsonSchema, item, root, output);
  } else if (typeof value === "object" && value !== null) {
    const object = value as Record<string, unknown>;
    for (const key of (schema.required ?? []) as string[]) if (!(key in object)) return fail();
    const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
    for (const [key, item] of Object.entries(object)) {
      if (schema.propertyNames)
        validateFrozen(schema.propertyNames as JsonSchema, key, root, output);
      if (properties[key]) validateFrozen(properties[key], item, root, output);
      else if (typeof schema.additionalProperties === "object")
        validateFrozen(schema.additionalProperties as JsonSchema, item, root, output);
      else if (!output && schema.additionalProperties === false) return fail();
    }
  }
}

export function validateExchange(
  bundle: Pick<CanaryPeerBundle, "schema">,
  exchange: PeerExchange,
): void {
  const schema = bundle.schema.tiers.public[exchange.procedure];
  if (!schema) throw new Error(`Missing frozen schema ${exchange.procedure}`);
  if (!schema.noInput) validateFrozen(schema.input, exchange.input, schema.input, false);
  if (exchange.error) {
    if (!exchange.error.code || !exchange.error.message)
      throw new Error("Malformed recorded error");
  } else if (schema.kind === "subscription") {
    if (!Array.isArray(exchange.frames)) throw new Error("Missing recorded subscription frames");
    for (const frame of exchange.frames) {
      const payload =
        typeof frame === "object" && frame !== null && "id" in frame && "data" in frame
          ? (frame as { data: unknown }).data
          : frame;
      validateFrozen(schema.output, payload);
    }
  } else if (!schema.voidOutput) validateFrozen(schema.output, exchange.output);
}

/** A frozen playback peer, NOT today's router with a second fixture. Its entire
 * grammar and answers come from the release artifact, and unsupported requests fail.
 */
export function createRecordedPeerRouter(
  bundle: CanaryPeerBundle,
  recording: PeerRecording,
): AnyRouter {
  const rpc = initTRPC.create({
    errorFormatter: ({ shape, error }) => ({
      ...shape,
      data: {
        ...shape.data,
        hostError: {
          code: error.code,
          message: error.message,
          ...((error.cause as { reason?: string } | undefined)?.reason
            ? { reason: (error.cause as unknown as { reason: string }).reason }
            : {}),
        },
      },
    }),
  });
  const tree: Record<string, unknown> = {};
  for (const path of new Set(recording.exchanges.map((exchange) => exchange.procedure))) {
    const schema = bundle.schema.tiers.public[path];
    const matches = recording.exchanges.filter((exchange) => exchange.procedure === path);
    const counts = new Map<string, number>();
    const answer = (input: unknown) => {
      const key = requestKey(input);
      const candidates = matches.filter((exchange) => requestKey(exchange.input) === key);
      const index = counts.get(key) ?? 0;
      counts.set(key, index + 1);
      const exchange = candidates[Math.min(index, candidates.length - 1)];
      if (!exchange)
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Request was not recorded at the release",
        });
      if (exchange.error)
        throw new TRPCError({
          code: exchange.error.code as "NOT_FOUND",
          message: exchange.error.message,
          cause: exchange.error.reason ? { reason: exchange.error.reason } : undefined,
        });
      return exchange;
    };
    const procedure = rpc.procedure.input({
      parse(value: unknown) {
        if (!schema.noInput) validateFrozen(schema.input, value, schema.input, false);
        return value;
      },
    });
    const resolver = ({ input }: { input: unknown }) => answer(input).output;
    const built =
      schema.kind === "query"
        ? procedure.query(resolver)
        : schema.kind === "mutation"
          ? procedure.mutation(resolver)
          : procedure.subscription(async function* ({ input, signal }) {
              for (const frame of answer(input).frames ?? []) {
                if (
                  typeof frame === "object" &&
                  frame !== null &&
                  "id" in frame &&
                  "data" in frame
                ) {
                  const envelope = frame as { id: string; data: unknown };
                  yield tracked(envelope.id, envelope.data);
                } else yield frame;
              }
              if (!signal?.aborted)
                await new Promise<void>((resolve) =>
                  signal?.addEventListener("abort", () => resolve(), { once: true }),
                );
            });
    const parts = path.split(".");
    let parent = tree;
    for (const part of parts.slice(0, -1)) {
      parent[part] ??= {};
      parent = parent[part] as Record<string, unknown>;
    }
    parent[parts.at(-1)!] = built;
  }
  return rpc.router(tree as Parameters<typeof rpc.router>[0]);
}

/** Harnesses write observed data only to a private staging directory. */
export function captureCanaryRecording(
  name: string,
  transport: PeerRecording["transport"],
  recording: unknown,
  exchanges: PeerExchange[],
): void {
  const directory = process.env.VOLLI_CANARY_CAPTURE_DIR;
  if (!directory) return;
  const schema = JSON.parse(
    readFileSync(new URL("../../../docs/protocol/protocol.schema.json", import.meta.url), "utf8"),
  ) as CanaryPeerBundle["schema"];
  for (const exchange of exchanges) validateExchange({ schema }, exchange);
  writeFileSync(
    join(directory, `${name}.json`),
    JSON.stringify({ transport, recording, exchanges }, null, 2),
  );
}

/** Normalize the legacy deterministic board/Session/sign-in/listing recordings. */
export function recordingExchanges(value: unknown): PeerExchange[] {
  const result: PeerExchange[] = [];
  function visit(node: unknown): void {
    if (!node || typeof node !== "object") return;
    const object = node as Record<string, unknown>;
    if (
      typeof object.procedure === "string" &&
      "input" in object &&
      ("output" in object || "frames" in object || "error" in object)
    ) {
      const exchange = { procedure: object.procedure, input: object.input };
      if (object.error) result.push({ ...exchange, error: object.error as PeerExchange["error"] });
      else if (
        object.output &&
        typeof object.output === "object" &&
        "code" in object.output &&
        "message" in object.output
      )
        result.push({ ...exchange, error: object.output as PeerExchange["error"] });
      else if (Array.isArray(object.frames)) {
        result.push({
          ...exchange,
          frames: "resumedInput" in object ? object.frames.slice(0, 1) : object.frames,
        });
        if ("resumedInput" in object)
          result.push({ ...exchange, input: object.resumedInput, frames: object.frames.slice(1) });
      } else {
        result.push({ ...exchange, output: object.output });
        if ("retryOutput" in object) result.push({ ...exchange, output: object.retryOutput });
      }
    }
    for (const [key, child] of Object.entries(object)) {
      if (["output", "frames", "input"].includes(key)) continue;
      visit(child);
    }
    if (Array.isArray(object.frames) && object.start && typeof object.start === "object") {
      const start = object.start as { procedure?: string; output?: { flowId?: string } };
      if (start.procedure === "signIns.start" && start.output?.flowId)
        result.push({
          procedure: "signIns.subscribe",
          input: { flowId: start.output.flowId },
          frames: object.frames,
        });
    }
  }
  visit(value);
  return result;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Preserve the deterministic known values, but ignore fields the old reader cannot see. */
function expectRecordedOutput(actual: unknown, recorded: unknown): void {
  if (Array.isArray(recorded)) {
    expect(Array.isArray(actual)).toBe(true);
    const values = actual as unknown[];
    expect(values).toHaveLength(recorded.length);
    recorded.forEach((value, index) => expectRecordedOutput(values[index], value));
  } else if (isObject(recorded)) {
    expect(isObject(actual)).toBe(true);
    for (const [key, value] of Object.entries(recorded)) {
      expect(Object.hasOwn(actual as object, key)).toBe(true);
      expectRecordedOutput((actual as Record<string, unknown>)[key], value);
    }
  } else expect(actual).toStrictEqual(recorded);
}

/** Canary desktop × next host: validate ACTUAL fresh responses with the canary's schema. */
export function checkNextHost(bundle: CanaryPeerBundle, name: string, observed: unknown): void {
  const frozen = bundle.recordings[name];
  if (!frozen) throw new Error(`Canary bundle lacks required recording ${name}`);
  const actual = recordingExchanges(observed);
  expect(actual).toHaveLength(frozen.exchanges.length);
  actual.forEach((exchange, index) => {
    const recorded = frozen.exchanges[index];
    expect(exchange.procedure).toBe(recorded.procedure);
    expect(exchange.input).toStrictEqual(recorded.input);
    for (const key of ["output", "frames", "error"] as const)
      expect(key in exchange).toBe(key in recorded);
    validateExchange(bundle, exchange);
    expectRecordedOutput(exchange, recorded);
  });
}

/** Next desktop × canary host: the frozen replay router crosses real adapters;
 * today's decoder is applied only on this (NEW client) side. */
export async function replayCanaryPeer(
  bundle: CanaryPeerBundle,
  name: string,
  schemas: Record<
    string,
    {
      input?: { parse(value: unknown): unknown };
      output: { parse(value: unknown): unknown };
      voidOutput?: boolean;
    }
  >,
): Promise<void> {
  const recording = bundle.recordings[name];
  if (!recording) throw new Error(`Canary bundle lacks required recording ${name}`);
  const router = createRecordedPeerRouter(bundle, recording);
  const link =
    recording.transport === "ipc"
      ? ipcContractLink({ router, createContext: () => ({}) })
      : webSocketContractLink({ router, createContext: () => ({}) });
  const connection = await link.open(null);
  const client = getUntypedClient(connection.client);
  try {
    for (const exchange of recording.exchanges) {
      const procedure = bundle.schema.tiers.public[exchange.procedure];
      const input = procedure.noInput
        ? undefined
        : (schemas[exchange.procedure].input?.parse(exchange.input) ?? exchange.input);
      if (!procedure.noInput) expect(input).toStrictEqual(exchange.input);
      if (procedure.kind === "subscription") {
        const stream = recordSubscription<unknown>((handlers) =>
          client.subscription(exchange.procedure, input, handlers),
        );
        try {
          const frames = await stream.received(exchange.frames!.length);
          expect(frames).toStrictEqual(exchange.frames);
          for (const frame of frames) {
            const data =
              frame && typeof frame === "object" && "id" in frame && "data" in frame
                ? (frame as { data: unknown }).data
                : frame;
            schemas[exchange.procedure].output.parse(data);
          }
        } finally {
          stream.unsubscribe();
        }
      } else {
        const call =
          procedure.kind === "query"
            ? client.query(exchange.procedure, input)
            : client.mutation(exchange.procedure, input);
        if (exchange.error) expect(await expectHostError(call)).toStrictEqual(exchange.error);
        else {
          const output = await call;
          expect(output).toStrictEqual(exchange.output);
          if (!schemas[exchange.procedure].voidOutput)
            schemas[exchange.procedure].output.parse(output);
        }
      }
    }
  } finally {
    await connection.close();
  }
}

/** The OLD client's requests are taken from the selected artifact, not the next
 * build's request grammar. The generic is only a test harness convenience. */
export function peerInput<T>(
  bundle: CanaryPeerBundle | null,
  name: string,
  procedure: string,
  fallback: T,
  occurrence = 0,
): T {
  if (!bundle) return fallback;
  const exchange = bundle.recordings[name]?.exchanges.filter(
    (value) => value.procedure === procedure,
  )[occurrence];
  if (!exchange) throw new Error(`Canary peer lacks request ${name}/${procedure}/${occurrence}`);
  return structuredClone(exchange.input) as T;
}
