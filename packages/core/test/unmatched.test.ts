import { describe, expect, it } from "vitest";
import { indexOperations, resolveSelection, slugify, unmatchedNames } from "../src/index.js";
import { loadFixture } from "./helpers.js";

describe("unmatchedNames", () => {
  const index = indexOperations(loadFixture("petstore-3.0.yaml"));

  it("names selected operations the document does not have", () => {
    const names = unmatchedNames(index, {
      mode: "include",
      operations: ["GET /pets", "DELETE /removed"],
      tags: [],
    });
    expect(names.include.operations).toEqual(["DELETE /removed"]);
    expect(names.exclude).toEqual({ operations: [], tags: [] });
  });

  it("names tags that no operation carries", () => {
    const names = unmatchedNames(index, {
      mode: "include",
      operations: [],
      tags: ["pets", "retired-tag", "unused"],
    });
    // "unused" is declared in the spec but has zero operations, so it matches nothing.
    expect(names.include.tags).toEqual(["retired-tag", "unused"]);
  });

  it("says on which side a name stands", () => {
    const names = unmatchedNames(index, { mode: "exclude", operations: ["GET /gone"], tags: [] });
    expect(names.exclude.operations).toEqual(["GET /gone"]);
    expect(names.include).toEqual({ operations: [], tags: [] });
  });
});

describe("resolveSelection", () => {
  const index = indexOperations(loadFixture("petstore-3.0.yaml"));

  it("dynamic tag rules match current operations only", () => {
    const kept = resolveSelection(index, { mode: "include", operations: [], tags: ["stores"] });
    expect([...kept]).toEqual(["GET /stores"]);
  });

  it("exclude of everything keeps nothing", () => {
    const all = index.entries.map((e) => e.key);
    const kept = resolveSelection(index, { mode: "exclude", operations: all, tags: [] });
    expect(kept.size).toBe(0);
  });
});

describe("slugify", () => {
  it("derives URL-safe slugs", () => {
    expect(slugify("Public docs")).toBe("public-docs");
    expect(slugify("  SDK (v2) — béta!  ")).toBe("sdk-v2-beta");
    expect(slugify("___")).toBe("");
  });
});
