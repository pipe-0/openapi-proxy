import { describe, expect, it } from "vitest";
import { budgetLeft } from "../src/document/budget.js";
import {
  assembleDocument,
  buildVariant,
  ConvertError,
  convertDocument,
  DocumentTooComplexError,
  findExternalRefs,
  fingerprintOperations,
  indexOperations,
  type JsonObject,
  MergeError,
  type OpenAPIDocument,
  parseSpec,
  type Selection,
  SpecParseError,
  serialize,
  WORK_BUDGET,
  withBudget,
} from "../src/index.js";

/**
 * What the engine costs, held to what it says it costs.
 *
 * The engine counts its work in steps and stops when a job has used its
 * budget (src/document/budget.ts). That bounds the time a document can take
 * only if the count is honest: if every loop over what a document holds, and
 * every reading of its text, is paid for. A single loop that is not turns a
 * small document into minutes of work, and no review of the code finds the
 * last such loop.
 *
 * So this does not list shapes that once were slow. It makes documents at
 * random, each with a few things in it grown out of all proportion (twenty
 * thousand paths that share one path item, a summary of a megabyte, a
 * default security of five thousand requirements, in every combination),
 * puts each through everything the service does with a document, and checks
 * one thing: the time a job took is covered by the steps it counted. A job
 * may also be refused, but then quickly.
 *
 * `COST_SEEDS=2000 pnpm vitest run test/cost.test.ts` looks further than the
 * few dozen documents of an ordinary run.
 */

/** What may be out of proportion in a document: ordinarily, and when it is. */
const KNOBS = {
  paths: [3, 20_000],
  /** Operations on each path. Beyond the first few, in `additionalOperations`. */
  methods: [1, 3_000],
  /** Every path is a `$ref` to one path item among the components. */
  sharedItem: [0, 1],
  /** With `sharedItem`: a field next to the `$ref`, so that each path lays its own over the target. */
  refSiblings: [0, 1],
  pathLength: [6, 100_000],
  /** Paths are made of opening braces. */
  braces: [0, 1],
  /** Tags on each operation. */
  tags: [1, 5_000],
  declaredTags: [1, 20_000],
  /** `x-tagGroups` that all have one name. */
  tagGroups: [0, 20_000],
  /** Parameters on each operation, and on each path item. */
  parameters: [1, 3_000],
  itemParameters: [0, 3_000],
  /** Characters in each operation's summary. */
  summary: [10, 1_000_000],
  /** Requirements in the document's default security, scopes in each, and the length of a scheme's name. */
  security: [1, 5_000],
  scopes: [1, 5_000],
  schemeName: [6, 300_000],
  /** Operations state their own security. */
  ownSecurity: [0, 1],
  schemas: [3, 20_000],
  /** Each schema refers to the next. */
  chain: [0, 1],
  properties: [2, 5_000],
  enumValues: [0, 20_000],
  /** Schemas that extend one family through `allOf`, and each other. */
  extenders: [0, 20_000],
  extendersChain: [0, 1],
  /** Entries in the family's discriminator mapping. */
  mapping: [0, 20_000],
  /** Segments in a reference to a deep place outside the components. */
  refDepth: [0, 3_000],
  /** References into an operation, which a selection may leave out. */
  looseRefs: [0, 5_000],
  servers: [1, 5_000],
  /** Mentions of one object in a list, and the values in that object. */
  repeats: [0, 20_000],
  repeated: [1, 3_000],
  /** Characters in one text, which may be short lines, or characters that have to be escaped. */
  blob: [0, 2_000_000],
  blobLines: [0, 1],
  blobOdd: [0, 1],
  /** Levels that text is nested. */
  depth: [1, 150],
  webhooks: [0, 5_000],
  callbacks: [0, 300],
  /** Every operation has the same `operationId`. */
  sameIds: [0, 1],
} as const;

type Knob = keyof typeof KNOBS;
type Shape = Record<Knob, number>;
const KNOB_NAMES = Object.keys(KNOBS) as Knob[];

/** A random number generator that gives the same numbers for the same seed (mulberry32). */
function randomFrom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A shape with about three things out of proportion. */
function shapeFrom(seed: number): { shape: Shape; grown: Knob[] } {
  const random = randomFrom(seed);
  const grown = KNOB_NAMES.filter(() => random() < 3 / KNOB_NAMES.length);
  const shape = Object.fromEntries(
    KNOB_NAMES.map((knob) => [knob, KNOBS[knob][grown.includes(knob) ? 1 : 0]]),
  ) as Shape;
  return { shape, grown };
}

/** More than a source may be: the service takes five megabytes. Such a shape is not built. */
class TooBig extends Error {}

/**
 * The document of a shape. `flavor` makes another document of the same
 * shape whose schemas and security schemes mean something else, for merging.
 */
function build(shape: Shape, flavor = 0): OpenAPIDocument {
  let size = 0;
  const pay = (amount: number) => {
    size += amount;
    if (size > 4_000_000) throw new TooBig();
  };
  const text = (length: number, of = "x") => {
    pay(length);
    return of.repeat(Math.ceil(length / of.length)).slice(0, length);
  };
  const count = <T>(length: number, each: (n: number) => T): T[] => {
    pay(length * 4);
    return Array.from({ length }, (_, n) => each(n));
  };
  const named = <T>(length: number, each: (n: number) => [string, T]) =>
    Object.fromEntries(count(length, each));

  const ok = { "200": { description: "ok" } };
  const scheme = (n: number) => `${text(shape.schemeName, "key")}${n}`;
  const path = (n: number) =>
    `/${shape.braces ? text(shape.pathLength, "{") : text(shape.pathLength, "a")}${n}`;
  const firstPath = shape.sharedItem ? undefined : path(0);

  const operation = (p: number, m: number, last: boolean): JsonObject => ({
    operationId: shape.sameIds ? "same" : `op${p}x${m}`,
    summary: text(shape.summary),
    tags: count(shape.tags, (t) => `tag${t}`),
    parameters: count(shape.parameters, (q) => ({
      name: `q${q}`,
      in: "query",
      schema: { type: "string" },
    })),
    ...(shape.ownSecurity ? { security: [{ [scheme(0)]: [] }] } : {}),
    responses: {
      "200": {
        description: "ok",
        content: {
          "application/json": { schema: { $ref: `#/components/schemas/S${p % shape.schemas}` } },
        },
      },
    },
    ...(shape.callbacks
      ? {
          callbacks: named(shape.callbacks, (c) => [
            `on${c}`,
            { "{$request.body#/url}": { post: { responses: ok } } },
          ]),
        }
      : {}),
    // The first operation holds shapes that the last one borrows.
    ...(p === 0 && m === 0 && shape.looseRefs
      ? { "x-shapes": named(shape.looseRefs, (s) => [`s${s}`, { type: "string" }]) }
      : {}),
    ...(last && shape.looseRefs && firstPath !== undefined
      ? {
          "x-uses": count(shape.looseRefs, (s) => ({
            $ref: `#/paths/${firstPath.replace(/~/g, "~0").replace(/\//g, "~1")}/get/x-shapes/s${s}`,
          })),
        }
      : {}),
    ...(last && shape.refDepth
      ? { "x-far": { $ref: `#/x-deep${"/a".repeat(shape.refDepth)}` } }
      : {}),
  });

  const METHODS = ["get", "post", "put", "delete", "patch"];
  const item = (p: number, last: boolean): JsonObject => {
    const standard = Math.min(shape.methods, METHODS.length);
    return {
      ...(shape.itemParameters
        ? {
            parameters: count(shape.itemParameters, (q) => ({
              name: `i${q}`,
              in: "query",
              schema: { type: "string" },
            })),
          }
        : {}),
      ...Object.fromEntries(
        count(standard, (m) => [METHODS[m] as string, operation(p, m, last && m === 0)]),
      ),
      ...(shape.methods > standard
        ? {
            additionalOperations: named(shape.methods - standard, (m) => [
              `M${m}`,
              operation(p, standard + m, false),
            ]),
          }
        : {}),
    };
  };

  const schemas: JsonObject = named(shape.schemas, (n) => [
    `S${n}`,
    {
      type: "object",
      properties: {
        ...named(shape.properties, (property) => [
          `p${property}`,
          { type: flavor ? "integer" : "string" },
        ]),
        ...(shape.chain && n + 1 < shape.schemas
          ? { next: { $ref: `#/components/schemas/S${n + 1}` } }
          : {}),
      },
      ...(shape.enumValues ? { enum: count(shape.enumValues, (value) => `v${value}`) } : {}),
    },
  ]);
  if (shape.extenders || shape.mapping) {
    schemas.Pet = {
      type: "object",
      discriminator: {
        propertyName: "kind",
        ...(shape.mapping
          ? {
              mapping: named(shape.mapping, (value) => [
                `value${value}`,
                value % 2
                  ? `S${value % shape.schemas}`
                  : `#/components/schemas/S${value % shape.schemas}`,
              ]),
            }
          : {}),
      },
    };
    for (const [name, schema] of count(shape.extenders, (n): [string, JsonObject] => [
      `Pet${n}`,
      {
        allOf: [
          { $ref: `#/components/schemas/${shape.extendersChain && n > 0 ? `Pet${n - 1}` : "Pet"}` },
        ],
      },
    ])) {
      schemas[name] = schema;
    }
    (schemas.S0 as JsonObject).properties = { pet: { $ref: "#/components/schemas/Pet" } };
  }

  const shared = shape.sharedItem ? item(0, false) : undefined;
  let deep: unknown = { type: flavor ? "integer" : "string" };
  for (let level = 0; level < shape.refDepth; level++) deep = { a: deep };
  const blobText = shape.blobLines
    ? "0123456789\n"
    : shape.blobOdd
      ? `${String.fromCharCode(1)}${String.fromCharCode(0x20ac)}"`
      : "x";
  let blob: unknown = text(shape.blob, blobText);
  for (let level = 1; level < shape.depth; level++) blob = { level: blob };
  const repeated = named(shape.repeated, (n) => [`r${n}`, n]);

  return {
    openapi: "3.1.0",
    info: { title: "Shape", version: "1" },
    servers: count(shape.servers, (n) => ({ url: `https://s${n}.example.com` })),
    security: count(shape.security, (n) => ({
      [scheme(n)]: count(shape.scopes, (s) => `scope${s}`),
    })),
    tags: count(shape.declaredTags, (n) => ({ name: `tag${n}`, description: "A tag." })),
    ...(shape.tagGroups
      ? { "x-tagGroups": count(shape.tagGroups, (n) => ({ name: "group", tags: [`tag${n}`] })) }
      : {}),
    paths: named(shape.paths, (p) => [
      path(p),
      shared
        ? {
            $ref: "#/components/pathItems/Shared",
            ...(shape.refSiblings ? { summary: "A path." } : {}),
          }
        : item(p, p === shape.paths - 1),
    ]),
    ...(shape.webhooks
      ? { webhooks: named(shape.webhooks, (n) => [`hook${n}`, { post: { responses: ok } }]) }
      : {}),
    components: {
      schemas,
      securitySchemes: named(shape.security, (n) => [
        scheme(n),
        { type: "apiKey", in: "header", name: flavor ? "X-Other" : "X-Key" },
      ]),
      ...(shared ? { pathItems: { Shared: shared } } : {}),
    },
    "x-deep": deep,
    "x-blob": blob,
    ...(shape.repeats ? { "x-repeats": count(shape.repeats, () => repeated) } : {}),
  };
}

interface Subject {
  doc: OpenAPIDocument;
  other: OpenAPIDocument;
  json: string | undefined;
  yaml: string | undefined;
  half: Selection;
}

const everything: Selection = { mode: "exclude", operations: [], tags: [] };
const written = (doc: OpenAPIDocument, format: "json" | "yaml") => {
  serialize(doc, format);
};

/** Everything the service does with a document. */
const JOBS: Record<string, (subject: Subject) => unknown> = {
  "read as JSON": ({ json }) => json !== undefined && parseSpec(json),
  "read as YAML": ({ yaml }) => yaml !== undefined && parseSpec(yaml),
  "look at": ({ doc }) => {
    findExternalRefs(doc);
    indexOperations(doc);
    fingerprintOperations(doc);
  },
  "merge with a copy of itself": ({ doc }) =>
    assembleDocument([
      { name: "Core", doc },
      { name: "Copy", doc },
    ]),
  "merge with a copy under a prefix": ({ doc }) =>
    assembleDocument([
      { name: "Core", doc },
      { name: "Copy", doc, pathPrefix: "/copy" },
    ]),
  "merge with another like it": ({ doc, other }) =>
    assembleDocument([
      { name: "Core", doc },
      { name: "Other API", doc: other },
    ]),
  "merge with another like it under a prefix": ({ doc, other }) =>
    assembleDocument([
      { name: "Core", doc },
      { name: "Other API", doc: other, pathPrefix: "/other" },
    ]),
  "serve half of it": ({ doc, half }) => {
    const built = buildVariant(doc, { selection: half });
    written(built.doc, "json");
    written(built.doc, "yaml");
  },
  "serve it as 3.0": ({ doc }) => {
    written(buildVariant(doc, { selection: everything, version: "3.0" }).doc, "yaml");
  },
  "raise it from 3.0": ({ doc }) => convertDocument({ ...doc, openapi: "3.0.3" }, "3.1"),
};

const isRefusal = (error: unknown) =>
  error instanceof DocumentTooComplexError ||
  error instanceof SpecParseError ||
  error instanceof MergeError ||
  error instanceof ConvertError;

/** Run a job the way the service does, under one budget, and say what it took. */
function measured(work: () => unknown): { ms: number; steps: number; refused: boolean } {
  const started = performance.now();
  try {
    const steps = withBudget(() => {
      const before = budgetLeft() as number;
      work();
      return before - (budgetLeft() as number);
    });
    return { ms: performance.now() - started, steps, refused: false };
  } catch (error) {
    if (!isRefusal(error)) throw error;
    return { ms: performance.now() - started, steps: 0, refused: true };
  }
}

function subjectOf(shape: Shape): Subject | undefined {
  try {
    const doc = build(shape);
    const quietly = <T>(work: () => T): T | undefined => {
      try {
        return work();
      } catch (error) {
        if (!isRefusal(error) && !(error instanceof RangeError)) throw error;
        return undefined;
      }
    };
    // A source is at most five megabytes of text.
    const fits = (source: string | undefined) =>
      source !== undefined && source.length <= 5_000_000 ? source : undefined;
    const keys = quietly(() => indexOperations(doc).entries.map((entry) => entry.key)) ?? [];
    return {
      doc,
      other: build(shape, 1),
      json: fits(quietly(() => JSON.stringify(doc))),
      yaml: fits(quietly(() => serialize(doc, "yaml"))),
      half: { mode: "include", operations: keys.filter((_, n) => n % 2 === 0), tags: [] },
    };
  } catch (error) {
    if (error instanceof TooBig) return undefined;
    throw error;
  }
}

/**
 * What a step may take: two microseconds, on a slow machine with others
 * busy beside it. On an ordinary one a step is a tenth of that. And what a
 * job may take before it has counted anything: starting up, and the first
 * run of code that has not been run before.
 */
const MS_PER_STEP = 0.002;
const MS_TO_START = 150;
/**
 * And how long a job may run before it is refused for running out: the whole
 * budget, at a quarter of a microsecond a step. Most work is cheaper than that.
 */
const MS_TO_REFUSE = WORK_BUDGET * 0.00025;

const SEEDS = Number(process.env.COST_SEEDS ?? 60);

describe("the time a job takes is covered by the steps it counts", () => {
  const shapes = Array.from({ length: SEEDS }, (_, seed) => ({ seed, ...shapeFrom(seed + 1) }));

  it.each(shapes)(
    "document $seed, out of proportion in: $grown",
    ({ shape }) => {
      const subject = subjectOf(shape);
      if (!subject) return; // larger than a source may be
      for (const [job, work] of Object.entries(JOBS)) {
        const { ms, steps, refused } = measured(() => work(subject));
        if (refused) {
          expect(ms, `${job}: refused after ${Math.round(ms)} ms`).toBeLessThan(MS_TO_REFUSE);
        } else {
          expect(ms, `${job}: ${Math.round(ms)} ms for ${steps} steps`).toBeLessThan(
            MS_TO_START + steps * MS_PER_STEP,
          );
        }
      }
    },
    300_000,
  );
});

describe("the budget", () => {
  /**
   * An API like most: resources with a handful of operations each, their
   * schemas, descriptions of a few lines. About a kilobyte an operation.
   */
  function ordinary(operations: number): OpenAPIDocument {
    const resources = Math.ceil(operations / 5);
    const description =
      "Returns what was asked for.\n\nThe response is paginated, and sorted by the time each entry was created.";
    const resource = (n: number) => ({
      type: "object",
      required: ["id", "name"],
      properties: {
        id: { type: "string", format: "uuid", description: "The identifier of this resource." },
        name: { type: "string", description: "What people call it.", maxLength: 200 },
        createdAt: { type: "string", format: "date-time" },
        status: { type: "string", enum: ["active", "paused", "archived"] },
        owner: { $ref: `#/components/schemas/Resource${(n + 1) % resources}` },
        labels: { type: "array", items: { type: "string" } },
      },
    });
    const operation = (n: number, verb: string) => ({
      operationId: `${verb}Resource${n}`,
      summary: `${verb} resource ${n}`,
      description,
      tags: [`group${n % 40}`],
      parameters: [
        { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } },
        { name: "cursor", in: "query", schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "The resource.",
          content: {
            "application/json": { schema: { $ref: `#/components/schemas/Resource${n}` } },
          },
        },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    });
    const paths: JsonObject = {};
    for (let n = 0; n < resources; n++) {
      paths[`/resources${n}`] = { get: operation(n, "list"), post: operation(n, "create") };
      paths[`/resources${n}/{id}`] = {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        get: operation(n, "get"),
        patch: operation(n, "update"),
        delete: operation(n, "delete"),
      };
    }
    return {
      openapi: "3.1.0",
      info: { title: "Ordinary", version: "1.0.0" },
      security: [{ bearer: [] }],
      paths,
      components: {
        securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
        responses: { NotFound: { description: "Nothing is there." } },
        schemas: Object.fromEntries(
          Array.from({ length: resources }, (_, n) => [`Resource${n}`, resource(n)]),
        ),
      },
    };
  }

  it("is several times what the largest project takes", () => {
    // Five megabytes of sources is the most a project may have. As YAML,
    // which costs the most to read, and as two documents that are merged.
    const whole = serialize(ordinary(4_800), "yaml");
    const half = serialize(ordinary(2_400), "yaml");
    expect(whole.length).toBeGreaterThan(4_000_000);
    expect(whole.length).toBeLessThan(5_000_000);

    const render = (sources: Array<{ name: string; text: string; pathPrefix?: string }>) => {
      const { doc } = assembleDocument(
        sources.map(({ text, ...source }) => ({ ...source, doc: parseSpec(text).doc })),
      );
      return serialize(buildVariant(doc, { selection: everything, version: "3.0" }).doc, "yaml");
    };
    const check = (sources: Array<{ name: string; text: string; pathPrefix?: string }>) => {
      const { doc } = assembleDocument(
        sources.map(({ text, ...source }) => ({ ...source, doc: parseSpec(text).doc })),
      );
      indexOperations(doc);
      fingerprintOperations(doc);
    };
    const merged = [
      { name: "Core", text: half },
      { name: "Billing", text: half, pathPrefix: "/billing" },
    ];
    const jobs = {
      "render one document": measured(() => render([{ name: "Core", text: whole }])),
      "render two, merged": measured(() => render(merged)),
      "check one document": measured(() => check([{ name: "Core", text: whole }])),
      "check two, merged": measured(() => check(merged)),
    };
    for (const [job, { steps, refused }] of Object.entries(jobs)) {
      expect(refused, job).toBe(false);
      expect(steps, job).toBeLessThan(WORK_BUDGET / 3);
      expect(steps, job).toBeGreaterThan(WORK_BUDGET / 40);
    }
  }, 120_000);
});
