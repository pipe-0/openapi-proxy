import { describe, expect, it } from "vitest";
import { computeDrift, indexOperations, resolveSelection, slugify } from "../src/index.js";
import { loadFixture } from "./helpers.js";

describe("computeDrift", () => {
  const index = indexOperations(loadFixture("petstore-3.0.yaml"));

  it("reports selected operations that vanished", () => {
    const drift = computeDrift(
      { mode: "include", operations: ["GET /pets", "DELETE /removed"], tags: [] },
      index.entries.map((e) => e.key),
      index,
    );
    expect(drift.missingSelectedOperations).toEqual(["DELETE /removed"]);
    expect(drift.newOperations).toEqual([]);
  });

  it("reports tag rules that match nothing", () => {
    const drift = computeDrift(
      { mode: "include", operations: [], tags: ["pets", "retired-tag", "unused"] },
      index.entries.map((e) => e.key),
      index,
    );
    // "unused" is declared in the spec but has zero operations, so it matches nothing.
    expect(drift.missingSelectedTags).toEqual(["retired-tag", "unused"]);
  });

  it("reports operations added since the snapshot", () => {
    const snapshot = index.entries.map((e) => e.key).filter((k) => k !== "GET /stores");
    const drift = computeDrift({ mode: "include", operations: [], tags: [] }, snapshot, index);
    expect(drift.newOperations).toEqual(["GET /stores"]);
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
