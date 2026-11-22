import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { applyVariant, parseSpec, serialize } from "../src/index.js";
import { loadFixture, loadFixtureText } from "./helpers.js";

describe("serialize", () => {
  it("JSON output round-trips", () => {
    const doc = loadFixture("petstore-3.0.yaml");
    const text = serialize(doc, "json");
    expect(JSON.parse(text)).toEqual(doc);
    expect(text.endsWith("\n")).toBe(true);
  });

  it("mirrors the source's JSON indentation when asked to", () => {
    const minified = parseSpec(loadFixtureText("pipe0.json"));
    expect(minified.indent).toBe(0);
    const text = serialize(minified.doc, "json", { indent: minified.indent });
    expect(text).toBe(loadFixtureText("pipe0.json"));

    const pretty = parseSpec(loadFixtureText("cycles.json"));
    expect(pretty.indent).toBe(2);
    expect(parseSpec(JSON.stringify({ openapi: "3.1.0" }, null, "\t")).indent).toBe("\t");
    expect(parseSpec(loadFixtureText("petstore-3.0.yaml")).indent).toBe(2);
  });

  it("YAML output round-trips", () => {
    const doc = loadFixture("petstore-3.0.yaml");
    expect(parseYaml(serialize(doc, "yaml"))).toEqual(doc);
  });

  it("YAML output never contains anchors despite shared references", () => {
    // Filtered docs share subtrees with their source; anchors would confuse
    // downstream tools even though they're technically valid YAML.
    const source = loadFixture("pipe0.json");
    const { doc } = applyVariant(source, { mode: "exclude", operations: [], tags: ["Pipes"] });
    const text = serialize(doc, "yaml");
    expect(text).not.toMatch(/&a\d/);
    expect(text).not.toMatch(/\*a\d/);
    expect(parseYaml(text, { maxAliasCount: 10_000 })).toEqual(doc);
  });

  it("a serialized filtered doc re-parses as a valid spec", () => {
    const source = loadFixture("pipe0.json");
    const { doc } = applyVariant(source, { mode: "include", operations: [], tags: ["Search"] });
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
