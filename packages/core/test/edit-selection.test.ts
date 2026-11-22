import { describe, expect, it } from "vitest";
import {
  indexOperations,
  type OperationEntry,
  pinTag,
  resolveSelection,
  type Selection,
  setOperationsServed,
  setTagServed,
  withMode,
} from "../src/index.js";
import { loadFixture } from "./helpers.js";

// A small document where one operation carries two tags, the case that makes
// rule editing interesting.
const entries: OperationEntry[] = [
  { key: "GET /a", method: "GET", path: "/a", tags: ["public"] },
  { key: "POST /a", method: "POST", path: "/a", tags: ["public", "admin"] },
  { key: "GET /b", method: "GET", path: "/b", tags: ["admin"] },
  { key: "GET /c", method: "GET", path: "/c", tags: [] },
];
const index = { entries, tags: [], totalOperations: entries.length };
const served = (selection: Selection) => [...resolveSelection(index, selection)].sort();
const empty = (mode: Selection["mode"]): Selection => ({ mode, operations: [], tags: [] });

describe("serving and hiding operations", () => {
  it("pins single operations in include mode", () => {
    const one = setOperationsServed(entries, empty("include"), ["GET /a"], true);
    expect(one).toEqual({ mode: "include", operations: ["GET /a"], tags: [] });
    expect(setOperationsServed(entries, one, ["GET /a"], false)).toEqual(empty("include"));
  });

  it("hides single operations in exclude mode", () => {
    const one = setOperationsServed(entries, empty("exclude"), ["GET /a"], false);
    expect(one).toEqual({ mode: "exclude", operations: ["GET /a"], tags: [] });
    expect(served(one)).toEqual(["GET /b", "GET /c", "POST /a"]);
  });

  it("hiding one operation under a rule keeps its siblings served", () => {
    const rule = setTagServed(entries, empty("include"), "public", true);
    expect(rule.tags).toEqual(["public"]);
    const without = setOperationsServed(entries, rule, ["POST /a"], false);
    expect(without).toEqual({ mode: "include", operations: ["GET /a"], tags: [] });
  });

  it("an operation with two tags is released from both rules", () => {
    let selection = setTagServed(entries, empty("include"), "public", true);
    selection = setTagServed(entries, selection, "admin", true);
    expect(served(selection)).toEqual(["GET /a", "GET /b", "POST /a"]);
    selection = setOperationsServed(entries, selection, ["POST /a"], false);
    expect(served(selection)).toEqual(["GET /a", "GET /b"]);
    expect(selection.tags).toEqual([]);
  });
});

describe("serving and hiding tags", () => {
  it("serving a tag in include mode is a rule; hiding it again removes every trace", () => {
    const pinned = setOperationsServed(entries, empty("include"), ["GET /a"], true);
    const rule = setTagServed(entries, pinned, "public", true);
    expect(rule).toEqual({ mode: "include", operations: [], tags: ["public"] });
    expect(setTagServed(entries, rule, "public", false)).toEqual(empty("include"));
  });

  it("hiding a tag in exclude mode is a rule too", () => {
    const hidden = setTagServed(entries, empty("exclude"), "admin", false);
    expect(hidden).toEqual({ mode: "exclude", operations: [], tags: ["admin"] });
    expect(served(hidden)).toEqual(["GET /a", "GET /c"]);
    expect(setTagServed(entries, hidden, "admin", true)).toEqual(empty("exclude"));
  });

  it("hiding a tag also hides operations another rule was serving, and nothing else", () => {
    let selection = setTagServed(entries, empty("include"), "public", true);
    selection = setTagServed(entries, selection, "admin", true);
    selection = setTagServed(entries, selection, "admin", false);
    expect(served(selection)).toEqual(["GET /a"]);
  });

  it("pinTag freezes a rule into the operations it covers today", () => {
    const rule = setTagServed(entries, empty("include"), "public", true);
    const pinned = pinTag(entries, rule, "public");
    expect(pinned).toEqual({ mode: "include", operations: ["GET /a", "POST /a"], tags: [] });
    expect(pinTag(entries, pinned, "public")).toBe(pinned);
  });
});

describe("switching the mode", () => {
  it("keeps what is served and turns fully matching tags into rules", () => {
    const include: Selection = { mode: "include", operations: ["GET /c"], tags: ["public"] };
    const exclude = withMode(entries, include, "exclude");
    expect(exclude.mode).toBe("exclude");
    expect(served(exclude)).toEqual(served(include));
    // GET /b is the only thing hidden; "admin" is only partly hidden, so it is a pin.
    expect(exclude).toEqual({ mode: "exclude", operations: ["GET /b"], tags: [] });

    const back = withMode(entries, exclude, "include");
    expect(served(back)).toEqual(served(include));
    expect(back.tags).toEqual(["public"]);
    expect(withMode(entries, back, "include")).toBe(back);
  });

  it("a fully hidden tag becomes a hide rule", () => {
    const include: Selection = { mode: "include", operations: [], tags: ["public"] };
    const hidden = withMode(
      entries,
      setOperationsServed(entries, include, ["POST /a"], false),
      "exclude",
    );
    expect(served(hidden)).toEqual(["GET /a"]);
    expect(hidden.tags).toEqual(["admin"]);
  });
});

describe("random edits against a simple model", () => {
  // The model is just a set of served keys. Every edit must change exactly
  // the operations it names, whatever rules and pins are in play.
  function rng(seed: number) {
    let state = seed;
    return () => {
      state = (state * 1664525 + 1013904223) % 4294967296;
      return state / 4294967296;
    };
  }

  for (const fixture of ["petstore-3.0.yaml", "pipe0.json", "webhooks.json"]) {
    it(fixture, () => {
      const all = indexOperations(loadFixture(fixture));
      const tags = all.tags.filter((tag) => tag.count > 0).map((tag) => tag.name);
      const random = rng(42);
      const pick = <T>(list: T[]): T => list[Math.floor(random() * list.length)] as T;

      let selection: Selection = { mode: "include", operations: [], tags: [] };
      const model = new Set<string>();

      for (let step = 0; step < 400; step++) {
        const roll = random();
        const on = random() < 0.5;
        if (roll < 0.45) {
          const keys = [pick(all.entries).key, pick(all.entries).key];
          selection = setOperationsServed(all.entries, selection, keys, on);
          for (const key of keys) on ? model.add(key) : model.delete(key);
        } else if (roll < 0.8 && tags.length > 0) {
          const tag = pick(tags);
          selection = setTagServed(all.entries, selection, tag, on);
          for (const entry of all.entries) {
            if (entry.tags.includes(tag)) on ? model.add(entry.key) : model.delete(entry.key);
          }
        } else if (roll < 0.9 && selection.tags.length > 0) {
          selection = pinTag(all.entries, selection, pick(selection.tags));
        } else {
          selection = withMode(
            all.entries,
            selection,
            selection.mode === "include" ? "exclude" : "include",
          );
        }
        expect([...resolveSelection(all, selection)].sort(), `step ${step}`).toEqual(
          [...model].sort(),
        );
      }
    });
  }
});
