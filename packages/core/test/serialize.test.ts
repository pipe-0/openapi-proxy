import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { applyVariant, measure, parseSpec, serialize } from "../src/index.js";
import { loadFixture, loadFixtureText } from "./helpers.js";

describe("serialize", () => {
  it("JSON output round-trips", () => {
    const doc = loadFixture("petstore-3.0.yaml");
    const text = serialize(doc, "json");
    expect(JSON.parse(text)).toEqual(doc);
    expect(text.endsWith("\n")).toBe(true);
  });

  it("writes JSON minified when the source is, and indented otherwise", () => {
    const minified = parseSpec(loadFixtureText("pipe0.json"));
    expect(minified.minified).toBe(true);
    const text = serialize(minified.doc, "json", { minified: minified.minified });
    expect(text).toBe(loadFixtureText("pipe0.json"));

    expect(parseSpec(loadFixtureText("cycles.json")).minified).toBe(false);
    expect(parseSpec(JSON.stringify({ openapi: "3.1.0" }, null, "\t")).minified).toBe(false);
    expect(parseSpec(loadFixtureText("petstore-3.0.yaml")).minified).toBe(false);
  });

  it("YAML output round-trips", () => {
    const doc = loadFixture("petstore-3.0.yaml");
    expect(parseYaml(serialize(doc, "yaml"))).toEqual(doc);
  });

  it("YAML output never contains anchors despite shared references", () => {
    // Filtered docs share subtrees with their source; anchors would confuse
    // downstream tools even though they're technically valid YAML.
    const source = loadFixture("pipe0.json");
    const { doc } = applyVariant(source, { exclude: { tags: ["Pipes"] } });
    const text = serialize(doc, "yaml");
    expect(text).not.toMatch(/&a\d/);
    expect(text).not.toMatch(/\*a\d/);
    expect(parseYaml(text, { maxAliasCount: 10_000 })).toEqual(doc);
  });

  it("a serialized filtered doc re-parses as a valid spec", () => {
    const source = loadFixture("pipe0.json");
    const { doc } = applyVariant(source, { include: { tags: ["Search"] } });
    const reparsed = parseSpec(serialize(doc, "yaml"));
    expect(reparsed.specVersion).toBe("3.1");
    expect(reparsed.doc).toEqual(doc);
  });

  it("key order survives serialization", () => {
    const original = loadFixtureText("pipe0.json");
    const doc = parseSpec(original).doc;
    const roundTripped = JSON.parse(serialize(doc, "json"));
    expect(Object.keys(roundTripped)).toEqual(Object.keys(doc));
    expect(Object.keys(roundTripped.paths)).toEqual(Object.keys(doc.paths as object));
  });
});

describe("YAML output, for every reader", () => {
  const chr = String.fromCharCode;
  /** Texts chosen to be mistaken for something else, or to need escaping. */
  const TEXTS = [
    ...["", " ", "a", "true", "Yes", "NO", "null", "~", "y", "1", "1.0", "3.1.0", "1e3", "0x1f"],
    ...["0o7", "1_000", "2001-12-14", "12:30:45", ".5", "-", "- a", "a: b", "a #b", "#a", "a:"],
    ...["key: |", "*a", "&a", "!a", "%a", "@a", "`a", "'a'", '"a"', "[a]", "{a}", "a, b", "<<"],
    ...["=", "/pets/{id}", "$ref", "a b ", " a", "a\\b", "?", "? a", "|", ">", "---", "..."],
    ...["line one\nline two", "ends with one\n", "two at the end\n\n", "\nstarts with one"],
    ...["  indented\nthen not", "first\n  indented\nlast", "tab\there\nand\tthere"],
    ...["trailing space \nnext", "a\n\n\nb", "a\r\nb", "only spaces after\n   ", "# a\n- b\nc: d"],
    `nul${chr(0)}`,
    `bell${chr(7)}\nline`,
    `del${chr(0x7f)}`,
    `next line${chr(0x85)}x`,
    `separator${chr(0x2028)}x\ny`,
    `no-break${chr(0xa0)}x`,
    `mark${chr(0xfeff)}x`,
    `euro ${chr(0x20ac)}\nand more`,
    `smile ${chr(0xd83d)}${chr(0xde00)}`,
    `smile\n${chr(0xd83d)}${chr(0xde00)}`,
    "k".repeat(1100),
  ];
  const NUMBERS = [0, -1, 1.5, 1e21, 1e-7, -0, 123456789012];

  /** The same values for the same seed. */
  const valuesFrom = (seed: number) => {
    let state = seed;
    const random = () => {
      state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff;
      return state / 0x7fffffff;
    };
    const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)] as T;
    const value = (depth: number): unknown => {
      const kind = random();
      if (depth > 3 || kind < 0.45) return pick(TEXTS);
      if (kind < 0.55) return pick([...NUMBERS, true, false, null]);
      const length = Math.floor(random() * 4);
      if (kind < 0.75) return Array.from({ length }, () => value(depth + 1));
      return Object.fromEntries(Array.from({ length }, () => [pick(TEXTS), value(depth + 1)]));
    };
    return { openapi: "3.1.0", "x-values": Array.from({ length: 12 }, () => value(0)) };
  };

  it("reads back as what was written, under YAML 1.2 and under 1.1", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const doc = valuesFrom(seed);
      const expected = JSON.parse(JSON.stringify(doc));
      const text = serialize(doc, "yaml");
      for (const version of ["1.2", "1.1"] as const) {
        expect(parseYaml(text, { version }), `seed ${seed}, YAML ${version}:\n${text}`).toEqual(
          expected,
        );
      }
      expect(parseSpec(text).doc).toEqual(expected);
    }
  });

  it("comes to no more than the document was measured at, like JSON", () => {
    const bytes = (text: string) => new TextEncoder().encode(text).length;
    for (let seed = 1; seed <= 300; seed++) {
      const doc = valuesFrom(seed);
      const measured = measure(doc, { depth: 1000, size: Number.MAX_SAFE_INTEGER });
      expect(bytes(serialize(doc, "yaml")), `seed ${seed}`).toBeLessThanOrEqual(measured);
      expect(bytes(serialize(doc, "json")), `seed ${seed}`).toBeLessThanOrEqual(measured);
    }
  });

  it("writes a document the way people do", () => {
    const text = serialize(
      {
        openapi: "3.1.0",
        info: { title: "Pets", version: "1.0", description: "First line.\n\nSecond paragraph.\n" },
        paths: { "/pets/{id}": { get: { tags: ["pets"], responses: { "200": { $ref: "#/x" } } } } },
        "x-empty": { list: [], map: {} },
      },
      "yaml",
    );
    expect(text).toBe(
      [
        "openapi: 3.1.0",
        "info:",
        "  title: Pets",
        '  version: "1.0"',
        "  description: |",
        "    First line.",
        "",
        "    Second paragraph.",
        "paths:",
        "  /pets/{id}:",
        "    get:",
        "      tags:",
        "        - pets",
        "      responses:",
        '        "200":',
        '          $ref: "#/x"',
        "x-empty:",
        "  list: []",
        "  map: {}",
        "",
      ].join("\n"),
    );
  });
});
