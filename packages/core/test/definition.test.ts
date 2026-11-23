import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  DEFINITION_SHAPE,
  definitionSchema,
  describeProblem,
  effectiveOverrides,
  effectiveVariant,
  effectiveVisibility,
  keysOf,
  mergeOrder,
  type Problem,
  type ProjectDefinition,
  readDefinition,
  readSelection,
  sourceLabel,
  warningsOf,
} from "../src/index.js";

/** The example from the docs: two sources, project defaults, one variant that states its own. */
const EXAMPLE = {
  version: 1,
  project: "pipe0",
  name: "Pipe0 API",
  visibility: "private",
  overrides: { servers: [{ url: "https://api.pipe0.com", description: "Production" }] },
  sources: [
    { name: "core", url: "https://api.pipe0.com/doc", main: true, follow: true },
    { name: "billing", file: "./billing/openapi.yaml", pathPrefix: "/billing" },
  ],
  variants: {
    public: {
      name: "Public API",
      icon: "globe",
      visibility: "public",
      include: { tags: ["Pipes", "Search"], operations: ["GET /v1/credit-balance"] },
      exclude: { operations: ["POST /v1/pipes/validate"] },
      overrides: { title: "Pipe0 public API" },
    },
    partner: { include: { tags: ["Connections"] } },
  },
};

const read = (input: unknown): ProjectDefinition => {
  const result = readDefinition(input);
  if ("problems" in result) throw new Error(result.problems.map(describeProblem).join("\n"));
  return result.definition;
};
const problemsOf = (input: unknown): Problem[] => {
  const result = readDefinition(input);
  return "problems" in result ? result.problems : [];
};
/** The example with one thing changed. */
const withChange = (change: (draft: typeof EXAMPLE & Record<string, unknown>) => void) => {
  const draft = structuredClone(EXAMPLE) as typeof EXAMPLE & Record<string, unknown>;
  change(draft);
  return draft;
};

describe("reading a definition", () => {
  it("takes the example as it is", () => {
    expect(read(EXAMPLE)).toEqual(EXAMPLE);
  });

  it("needs nothing but a version, a slug and one source", () => {
    const smallest = { version: 1, project: "books", sources: [{ url: "https://x.test/a.json" }] };
    expect(read(smallest)).toEqual({ ...smallest, variants: {} });
  });

  it("brings what it reads into one form", () => {
    const definition = read({
      version: 1,
      project: "books",
      name: "  Books  ",
      instance: "https://proxy.acme.com/",
      sources: [{ url: "https://x.test/a.json#top", main: true, follow: false, pathPrefix: "v1/" }],
      variants: {
        public: {
          include: { operations: ["b", "a", "b"], tags: [] },
          exclude: { tags: [] },
          overrides: { title: "  Books  " },
        },
      },
    });
    expect(definition).toEqual({
      version: 1,
      project: "books",
      name: "Books",
      instance: "https://proxy.acme.com",
      // The only source is the main one, and is not followed unless it says so.
      sources: [{ url: "https://x.test/a.json", pathPrefix: "/v1" }],
      variants: { public: { include: { operations: ["a", "b"] }, overrides: { title: "Books" } } },
    });
    // Reading what was read changes nothing.
    expect(read(definition)).toEqual(definition);
  });

  it("keeps an include that names nothing, and warns that it serves nothing", () => {
    const definition = read(
      withChange((draft) => {
        draft.variants.partner.include = {} as never;
      }),
    );
    expect(definition.variants.partner).toEqual({ include: {} });
    expect(warningsOf(definition).map((warning) => warning.path)).toEqual([
      "variants.partner.include",
    ]);
    expect(warningsOf(read(EXAMPLE))).toEqual([]);
  });
});

describe("what is wrong with a definition", () => {
  const at = (input: unknown) => problemsOf(input).map((problem) => problem.path);

  it("is said with the place it is at", () => {
    const [problem] = problemsOf(
      withChange((draft) => {
        draft.variants.public.icon = "glob";
      }),
    );
    expect(problem?.path).toBe("variants.public.icon");
    expect(problem?.allowed).toContain("globe");
    expect(describeProblem(problem as Problem)).toMatch(
      /^variants\.public\.icon "glob" is not one of the choices\. Allowed: file, book, /,
    );
  });

  it("includes a key that does not exist, with the ones that do", () => {
    const misspelt = withChange((draft) => {
      (draft.variants.public as Record<string, unknown>).includes = { tags: ["Pipes"] };
    });
    const [problem] = problemsOf(misspelt);
    expect(problem).toMatchObject({ path: "variants.public.includes" });
    expect(problem?.allowed).toEqual([
      "name",
      "icon",
      "visibility",
      "include",
      "exclude",
      "overrides",
    ]);
  });

  it("is all found at once", () => {
    expect(
      at({
        version: 1,
        project: "Not A Slug",
        sources: [{ url: "ftp://x.test/a" }],
        variants: { "Bad Slug": {}, ok: { visibility: "hidden", include: { tags: "Pipes" } } },
      }).sort(),
    ).toEqual(
      [
        "project",
        "sources[0].url",
        "variants.Bad Slug",
        "variants.ok.include.tags",
        "variants.ok.visibility",
      ].sort(),
    );
  });

  it("covers what the format requires", () => {
    expect(at({})).toEqual(["version", "project", "sources"]);
    expect(at("text")).toEqual([""]);
    expect(at({ version: 1, project: "books", sources: [] })).toEqual(["sources"]);
  });

  it("says a version it does not read, and nothing else", () => {
    const problems = problemsOf({ version: 2, project: "Not A Slug", anything: true });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ path: "version", allowed: ["1"] });
  });

  it("holds a source to being one thing: a url or a file", () => {
    const source = (fields: object) => ({ version: 1, project: "books", sources: [fields] });
    expect(at(source({ url: "https://x.test/a", file: "./a.yaml" }))).toEqual(["sources[0]"]);
    expect(at(source({ name: "core" }))).toEqual(["sources[0]"]);
    expect(at(source({ file: "./a.yaml", follow: true }))).toEqual(["sources[0].follow"]);
    expect(at(source({ file: "./a.yaml", pathPrefix: "/a b" }))).toEqual(["sources[0].pathPrefix"]);
    expect(at(source({ url: "https://x.test/a", extra: 1 }))).toEqual(["sources[0].extra"]);
  });

  it("holds several sources to a name each and one main", () => {
    const several = (sources: object[]) => ({ version: 1, project: "books", sources });
    const a = { name: "core", url: "https://x.test/a" };
    const b = { name: "billing", url: "https://x.test/b" };
    expect(at(several([{ ...a, main: true }, b]))).toEqual([]);
    expect(at(several([a, b]))).toEqual(["sources"]);
    expect(
      at(
        several([
          { ...a, main: true },
          { ...b, main: true },
        ]),
      ),
    ).toEqual(["sources"]);
    expect(at(several([{ ...a, main: true }, { url: b.url }]))).toEqual(["sources[1].name"]);
    expect(
      at(
        several([
          { ...a, main: true },
          { ...b, name: "Core" },
        ]),
      ),
    ).toEqual(["sources[1].name"]);
    expect(
      at(
        several([
          { ...a, main: true },
          { ...b, url: a.url },
        ]),
      ),
    ).toEqual(["sources[1].url"]);
  });

  it("holds servers and the instance to real addresses", () => {
    expect(
      at(
        withChange((draft) => {
          draft.overrides.servers[0] = { url: "api.pipe0.com" } as never;
        }),
      ),
    ).toEqual(["overrides.servers[0].url"]);
    expect(at({ ...EXAMPLE, instance: "http://proxy.acme.com" })).toEqual(["instance"]);
    expect(at({ ...EXAMPLE, instance: "http://localhost:7732" })).toEqual([]);
  });

  it("is told for a selection by itself too", () => {
    expect(readSelection({ include: { operations: ["b", "a"] } })).toEqual({
      selection: { include: { operations: ["a", "b"] } },
    });
    expect(readSelection({ mode: "include", operations: [] })).toMatchObject({
      problems: [{ path: "mode" }, { path: "operations" }],
    });
  });
});

describe("what a variant comes to", () => {
  const definition = read(EXAMPLE);

  it("takes title, description and servers key by key: its own, then the project's", () => {
    expect(effectiveOverrides(definition, "public")).toEqual({
      title: "Pipe0 public API",
      servers: [{ url: "https://api.pipe0.com", description: "Production" }],
    });
    expect(effectiveOverrides(definition, "partner")).toEqual(definition.overrides);
    expect(effectiveOverrides(read({ ...EXAMPLE, overrides: undefined }), "partner")).toBeNull();
  });

  it("is what the engine is given", () => {
    expect(effectiveVariant(definition, "public").selection).toEqual({
      include: { tags: ["Pipes", "Search"], operations: ["GET /v1/credit-balance"] },
      exclude: { operations: ["POST /v1/pipes/validate"] },
    });
    expect(effectiveVariant(definition, "partner").selection).toEqual({
      include: { tags: ["Connections"] },
    });
  });

  it("is readable by whoever the nearest layer says: variant, project, workspace", () => {
    expect(effectiveVisibility(definition, "public", "private")).toEqual({
      value: "public",
      from: "variant",
    });
    expect(effectiveVisibility(definition, "partner", "public")).toEqual({
      value: "private",
      from: "project",
    });
    const open = read({ ...EXAMPLE, visibility: undefined });
    expect(effectiveVisibility(open, "partner", "private")).toEqual({
      value: "private",
      from: "workspace",
    });
  });

  it("merges the main source first, then the others as listed", () => {
    const reordered = read({
      ...EXAMPLE,
      sources: [
        { name: "billing", file: "./billing.yaml" },
        { name: "search", file: "./search.yaml" },
        { name: "core", url: "https://api.pipe0.com/doc", main: true },
      ],
    });
    expect(mergeOrder(reordered).map(sourceLabel)).toEqual(["core", "billing", "search"]);
    expect(sourceLabel({})).toBe("main");
  });
});

describe("canonical JSON", () => {
  it("is the same for the same content in any key order", () => {
    expect(canonicalJson({ b: [2, { d: 1, c: undefined }], a: 1 })).toBe(
      canonicalJson({ a: 1, b: [2, { d: 1 }] }),
    );
    expect(canonicalJson({ a: [1, 2] })).not.toBe(canonicalJson({ a: [2, 1] }));
  });
});

describe("the published schema", () => {
  const file = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../public/schema/definition.v1.json",
  );
  const current = `${JSON.stringify(definitionSchema(), null, 2)}\n`;

  it("is the one this code generates (run `pnpm schema` after changing the format)", () => {
    if (process.env.UPDATE_SCHEMA) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, current);
    }
    expect(existsSync(file) ? readFileSync(file, "utf8") : "").toBe(current);
  });

  it("describes every key, and allows no others", () => {
    const schema = definitionSchema() as { additionalProperties: boolean; required: string[] };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["version", "project", "sources"]);
    const missing = keysOf(DEFINITION_SHAPE).filter((key) => {
      let node: Record<string, unknown> | undefined = schema as never;
      for (const part of key.split(".")) {
        const name = part.replace("[]", "");
        node =
          name === "<slug>"
            ? (node?.additionalProperties as Record<string, unknown>)
            : ((node?.properties as Record<string, unknown>)?.[name] as Record<string, unknown>);
        if (part.endsWith("[]")) node = node?.items as Record<string, unknown>;
      }
      return typeof node?.description !== "string";
    });
    expect(missing).toEqual([]);
  });
});
