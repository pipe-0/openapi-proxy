import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, NoConfigError, parseConfig } from "../src/config.js";
import { example } from "./helpers.js";

const problems = (text: string) => {
  const parsed = parseConfig(text);
  return "problems" in parsed ? parsed.problems : [];
};

describe("reading a definition file", () => {
  it("reads every example", () => {
    for (const name of ["from-a-url", "several-audiences", "in-your-repository"]) {
      const config = loadConfig(example(name, "openapi-proxy.yaml"));
      expect(config.definition.project).toBe("bookshop");
      expect(config.dir).toBe(example(name));
    }
  });

  it("says on which line a problem is", () => {
    const text = [
      "version: 1",
      "project: bookshop",
      "sources:",
      "  - url: https://x.test/openapi.json",
      "    main: yes please",
      "variants:",
      "  public:",
      "    icon: glob",
      "    includes:",
      "      tags: [Books]",
    ].join("\n");
    expect(problems(text).map(({ path, line }) => ({ path, line }))).toEqual([
      { path: "sources[0].main", line: 5 },
      { path: "variants.public.icon", line: 8 },
      // A key that should not be there is pointed at itself.
      { path: "variants.public.includes", line: 9 },
    ]);
  });

  it("points at the key of a list when what is wrong is about the whole of it", () => {
    const text = [
      "version: 1",
      "project: bookshop",
      "sources:",
      "  - { name: a, file: ./a.yaml }",
      "  - { name: b, file: ./b.yaml }",
    ].join("\n");
    expect(problems(text)).toMatchObject([{ path: "sources", line: 3 }]);
  });

  it("reports text that is not YAML once, with its line, and explains the usual slip", () => {
    const text = [
      "version: 1",
      "project: bookshop",
      "sources: [{ file: ./a.yaml }]",
      "variants:",
      "  public:",
      "    include:",
      "      operations: [GET /books/{id}]",
    ].join("\n");
    const found = problems(text);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ path: "", line: 7 });
    expect(found[0]?.message).toContain("needs quotes");
    // Quoted, or one per line, it is fine.
    expect(problems(text.replace("[GET /books/{id}]", '["GET /books/{id}"]'))).toEqual([]);
  });

  it("tells a missing file from a wrong one", () => {
    expect(() => loadConfig(example("from-a-url", "nope.yaml"))).toThrow(NoConfigError);
    expect(() => loadConfig(example("from-a-url", "openapi.json"))).toThrow(ConfigError);
  });

  it("takes JSON as well, since JSON is YAML", () => {
    const text = JSON.stringify({
      version: 1,
      project: "bookshop",
      sources: [{ file: "./openapi.json" }],
    });
    expect(parseConfig(text)).toMatchObject({ definition: { project: "bookshop" } });
  });

  it("keeps the examples free of problems and of tabs", () => {
    for (const name of ["from-a-url", "several-audiences", "in-your-repository"]) {
      const text = readFileSync(example(name, "openapi-proxy.yaml"), "utf8");
      expect(problems(text), name).toEqual([]);
      expect(text).not.toContain("\t");
    }
  });
});
