import { describe, expect, it } from "vitest";
import { indexOperations } from "../src/index.js";
import { loadFixture } from "./helpers.js";

describe("indexOperations", () => {
  it("indexes the pipe0 reference spec", () => {
    const index = indexOperations(loadFixture("pipe0.json"));
    expect(index.totalOperations).toBe(30);
    expect(index.tags.map((t) => t.name).sort()).toEqual([
      "Connections",
      "Constants",
      "Pipes",
      "Search",
      "Searches",
      "Secrets",
    ]);
    for (const entry of index.entries) {
      expect(entry.key).toBe(`${entry.method} ${entry.path}`);
      expect(entry.operationId).toBeUndefined();
      expect(entry.tags.length).toBeGreaterThan(0);
    }
  });

  it("skips path-item keys that are not operations", () => {
    const index = indexOperations(loadFixture("petstore-3.0.yaml"));
    // /pets has summary + parameters at path-item level; they must not become ops.
    expect(index.totalOperations).toBe(4);
    const listPets = index.entries.find((e) => e.key === "GET /pets");
    expect(listPets?.operationId).toBe("listPets");
    expect(listPets?.summary).toBe("List all pets");
  });

  it("orders tags by the declared tags array, then first-seen", () => {
    const index = indexOperations(loadFixture("petstore-3.0.yaml"));
    expect(index.tags.map((t) => t.name)).toEqual(["pets", "stores", "unused"]);
    expect(index.tags.find((t) => t.name === "unused")?.count).toBe(0);
  });

  it("flags deprecated operations", () => {
    const index = indexOperations(loadFixture("petstore-3.0.yaml"));
    expect(index.entries.find((e) => e.key === "GET /pets/{petId}")?.deprecated).toBe(true);
  });
});
