import { describe, expect, it } from "vitest";
import {
  followTag,
  indexOperations,
  laterAdditions,
  normalizeSelection,
  type OperationEntry,
  pinTag,
  resolveSelection,
  type Selection,
  setOperationsServed,
  setTagServed,
  tagRule,
  withLaterAdditions,
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
const indexOf = (list: OperationEntry[]) => ({ entries: list, tags: [], totalOperations: 0 });
const served = (selection: Selection, list = entries) =>
  [...resolveSelection(indexOf(list), selection)].sort();
/** Nothing served, and what the API adds later stays hidden. */
const NOTHING: Selection = { include: {} };
/** Everything served, what the API adds later too. */
const EVERYTHING: Selection = {};

describe("serving and hiding operations", () => {
  it("names single operations when later additions are hidden", () => {
    const one = setOperationsServed(entries, NOTHING, ["GET /a"], true);
    expect(one).toEqual({ include: { operations: ["GET /a"] } });
    expect(setOperationsServed(entries, one, ["GET /a"], false)).toEqual(NOTHING);
  });

  it("excludes single operations when later additions are served", () => {
    const one = setOperationsServed(entries, EVERYTHING, ["GET /a"], false);
    expect(one).toEqual({ exclude: { operations: ["GET /a"] } });
    expect(served(one)).toEqual(["GET /b", "GET /c", "POST /a"]);
    expect(setOperationsServed(entries, one, ["GET /a"], true)).toEqual(EVERYTHING);
  });

  it("hiding one operation under an included tag keeps the tag a rule", () => {
    const rule = setTagServed(entries, NOTHING, "public", true);
    const without = setOperationsServed(entries, rule, ["POST /a"], false);
    expect(without).toEqual({
      include: { tags: ["public"] },
      exclude: { operations: ["POST /a"] },
    });
    expect(served(without)).toEqual(["GET /a"]);
    // The rule still covers what the API adds under the tag later.
    const later = [...entries, { key: "PUT /a", method: "PUT", path: "/a", tags: ["public"] }];
    expect(served(without, later)).toEqual(["GET /a", "PUT /a"]);
    // And checking the operation again leaves no trace.
    expect(setOperationsServed(entries, without, ["POST /a"], true)).toEqual(rule);
  });

  it("an operation with two included tags is hidden once, and both tags stay rules", () => {
    let selection = setTagServed(entries, NOTHING, "public", true);
    selection = setTagServed(entries, selection, "admin", true);
    expect(served(selection)).toEqual(["GET /a", "GET /b", "POST /a"]);
    selection = setOperationsServed(entries, selection, ["POST /a"], false);
    expect(served(selection)).toEqual(["GET /a", "GET /b"]);
    expect(selection.include?.tags).toEqual(["admin", "public"]);
  });

  it("serving an operation that an excluded tag hides keeps its siblings hidden", () => {
    const hidden = setTagServed(entries, EVERYTHING, "admin", false);
    expect(hidden).toEqual({ exclude: { tags: ["admin"] } });
    const one = setOperationsServed(entries, hidden, ["GET /b"], true);
    expect(served(one)).toEqual(["GET /a", "GET /b", "GET /c"]);
    // An exclusion always wins, so the tag cannot stay a rule here.
    expect(one).toEqual({ exclude: { operations: ["POST /a"] } });
  });

  it("leaves names the document does not have where they are", () => {
    const ahead: Selection = {
      include: { operations: ["GET /not-live-yet"], tags: ["public"] },
      exclude: { operations: ["DELETE /not-live-yet"] },
    };
    const edited = setOperationsServed(entries, ahead, ["GET /c"], true);
    expect(edited.include?.operations).toEqual(["GET /c", "GET /not-live-yet"]);
    expect(edited.exclude?.operations).toEqual(["DELETE /not-live-yet"]);
  });
});

describe("serving and hiding tags", () => {
  it("serving a tag is a rule when later additions are hidden; hiding it again removes every trace", () => {
    const pinned = setOperationsServed(entries, NOTHING, ["GET /a"], true);
    const rule = setTagServed(entries, pinned, "public", true);
    expect(rule).toEqual({ include: { tags: ["public"] } });
    expect(tagRule(rule, "public")).toBe("served");
    expect(setTagServed(entries, rule, "public", false)).toEqual(NOTHING);
  });

  it("hiding a tag is a rule when later additions are served", () => {
    const rule = setTagServed(entries, EVERYTHING, "admin", false);
    expect(rule).toEqual({ exclude: { tags: ["admin"] } });
    expect(tagRule(rule, "admin")).toBe("hidden");
    expect(served(rule)).toEqual(["GET /a", "GET /c"]);
    expect(setTagServed(entries, rule, "admin", true)).toEqual(EVERYTHING);
  });

  it("hiding a tag keeps what another included tag serves, except the tag's own operations", () => {
    let selection = setTagServed(entries, NOTHING, "public", true);
    selection = setTagServed(entries, selection, "admin", true);
    selection = setTagServed(entries, selection, "admin", false);
    // POST /a carries both tags: it is hidden with admin, and public stays a rule.
    expect(served(selection)).toEqual(["GET /a"]);
    expect(selection).toEqual({
      include: { tags: ["public"] },
      exclude: { operations: ["POST /a"] },
    });
  });

  it("serving a tag brings back operations that were excluded one by one", () => {
    let selection = setTagServed(entries, NOTHING, "public", true);
    selection = setOperationsServed(entries, selection, ["POST /a"], false);
    selection = setTagServed(entries, selection, "public", true);
    expect(selection).toEqual({ include: { tags: ["public"] } });
  });

  it("makes a tag a rule without changing what is served", () => {
    // Later additions are hidden: the tag's are served from now on, and what is unchecked stays so.
    const one = setOperationsServed(entries, NOTHING, ["GET /a"], true);
    const followed = followTag(entries, one, "public");
    expect(followed).toEqual({
      include: { tags: ["public"] },
      exclude: { operations: ["POST /a"] },
    });
    expect(served(followed)).toEqual(served(one));

    // Later additions are served: a tag can hide its own only when all of it is hidden.
    const partly = setOperationsServed(entries, EVERYTHING, ["GET /b"], false);
    expect(followTag(entries, partly, "admin")).toBe(partly);
    const wholly = setOperationsServed(entries, partly, ["POST /a"], false);
    expect(followTag(entries, wholly, "admin")).toEqual({ exclude: { tags: ["admin"] } });
  });

  it("turns a rule into pins without changing what is served", () => {
    const rule = setTagServed(entries, NOTHING, "public", true);
    const pinned = pinTag(entries, rule, "public");
    expect(pinned).toEqual({ include: { operations: ["GET /a", "POST /a"] } });
    expect(tagRule(pinned, "public")).toBeUndefined();

    const hidden = setTagServed(entries, EVERYTHING, "admin", false);
    expect(pinTag(entries, hidden, "admin")).toEqual({
      exclude: { operations: ["GET /b", "POST /a"] },
    });
    // A tag without a rule is left alone.
    expect(pinTag(entries, rule, "admin")).toBe(rule);
  });
});

describe("what happens to operations added later", () => {
  it("is hidden with an include, and served without one", () => {
    expect(laterAdditions(NOTHING)).toBe("hidden");
    expect(laterAdditions({ include: { tags: ["public"] } })).toBe("hidden");
    expect(laterAdditions(EVERYTHING)).toBe("served");
    expect(laterAdditions({ exclude: { tags: ["admin"] } })).toBe("served");
  });

  it("can be switched without changing what is served now", () => {
    const some = setOperationsServed(entries, NOTHING, ["GET /a", "GET /c"], true);
    const flipped = withLaterAdditions(entries, some, "served");
    expect(served(flipped)).toEqual(served(some));
    expect(laterAdditions(flipped)).toBe("served");
    // admin is hidden as a whole, so it becomes a rule; POST /a is covered by it.
    expect(flipped).toEqual({ exclude: { tags: ["admin"] } });

    const back = withLaterAdditions(entries, flipped, "hidden");
    expect(served(back)).toEqual(served(some));
    expect(back).toEqual({
      include: { operations: ["GET /a", "GET /c"] },
      exclude: { tags: ["admin"] },
    });
  });

  it("keeps a tag that is served as a whole a rule", () => {
    const everything = withLaterAdditions(entries, EVERYTHING, "hidden");
    expect(everything).toEqual({
      include: { tags: ["admin", "public"], operations: ["GET /c"] },
    });
    expect(served(everything)).toEqual(served(EVERYTHING));
  });

  it("returns the same selection when nothing is to switch", () => {
    const some: Selection = { include: { tags: ["public"] } };
    expect(withLaterAdditions(entries, some, "hidden")).toBe(some);
  });
});

describe("the stored form of a selection", () => {
  it("is sorted, without duplicates, and leaves out what says nothing", () => {
    expect(
      normalizeSelection({
        include: { operations: ["b", "a", "b"], tags: [] },
        exclude: { operations: [], tags: [] },
      }),
    ).toEqual({ include: { operations: ["a", "b"] } });
    expect(normalizeSelection({ include: { tags: [], operations: [] } })).toEqual({ include: {} });
    expect(normalizeSelection({ exclude: {} })).toEqual({});
  });
});

describe("any sequence of edits", () => {
  // Deterministic randomness: a failing seed can be replayed.
  function random(seed: number) {
    let state = seed;
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 2 ** 32;
    };
  }
  const { entries: real } = indexOperations(loadFixture("pipe0.json"));
  const tags = [...new Set(real.flatMap((entry) => entry.tags))];

  it("changes what it was asked to change and nothing else", () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const next = random(seed);
      const pick = <T>(list: T[]): T => list[Math.floor(next() * list.length)] as T;
      let selection: Selection = next() < 0.5 ? NOTHING : EVERYTHING;

      for (let step = 0; step < 300; step++) {
        const before = resolveSelection(indexOf(real), selection);
        const later = laterAdditions(selection);
        const roll = next();
        let expected: Set<string>;
        let edited: Selection;

        if (roll < 0.4) {
          const keys = Array.from({ length: 1 + Math.floor(next() * 3) }, () => pick(real).key);
          const want = next() < 0.5;
          edited = setOperationsServed(real, selection, keys, want);
          expected = new Set(before);
          for (const key of keys) want ? expected.add(key) : expected.delete(key);
        } else if (roll < 0.8) {
          const tag = pick(tags);
          const want = next() < 0.5;
          edited = setTagServed(real, selection, tag, want);
          expected = new Set(before);
          for (const entry of real) {
            if (!entry.tags.includes(tag)) continue;
            want ? expected.add(entry.key) : expected.delete(entry.key);
          }
          // Where a rule can say it, operations added under the tag later follow.
          const addedLater = { key: "GET /added-later", tags: [tag] };
          const then = resolveSelection(
            indexOf([...real, addedLater as OperationEntry]),
            edited,
          ).has(addedLater.key);
          if (want && later === "hidden") expect(then).toBe(true);
          if (!want) expect(then).toBe(false);
        } else if (roll < 0.9) {
          const tag = pick(tags);
          edited = next() < 0.5 ? pinTag(real, selection, tag) : followTag(real, selection, tag);
          expected = before;
        } else {
          edited = withLaterAdditions(real, selection, later === "served" ? "hidden" : "served");
          expected = before;
          expect(laterAdditions(edited)).not.toBe(later);
        }

        const after = resolveSelection(indexOf(real), edited);
        expect([...after].sort(), `seed ${seed}, step ${step}`).toEqual([...expected].sort());
        // Everything but the switch leaves later additions as they were.
        if (roll < 0.9) expect(laterAdditions(edited)).toBe(later);
        // And the result is in its stored form already.
        expect(edited).toEqual(normalizeSelection(edited));
        selection = edited;
      }
    }
  });
});
