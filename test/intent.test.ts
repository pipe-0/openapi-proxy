import { describe, expect, it } from "vitest";
import { call, callsTo, publish, SPEC, SPEC_URL, serveSpec, sql } from "./harness";

/**
 * The promise is "a URL that always reflects the current source". These tests
 * pin down what that means when nobody has asked for a while, and when someone
 * needs the truth right now.
 */
const DAY = 24 * 60 * 60 * 1000;
const withoutPost = () => {
  const changed = structuredClone(SPEC) as { paths: Record<string, Record<string, unknown>> };
  changed.paths["/pets"] = { get: SPEC.paths["/pets"].get };
  return changed;
};
const methods = async (response: Response) =>
  Object.keys(((await response.json()) as { paths: Record<string, object> }).paths["/pets"] ?? {});

describe("after a long quiet period", () => {
  it("the first request gets the current document, not the one from days ago", async () => {
    const { variant } = await publish();
    await sql("UPDATE projects SET fetched_at = fetched_at - ?", 3 * DAY);
    serveSpec(withoutPost());

    const response = await call(variant.path);
    expect(await methods(response)).toEqual(["get"]);
    expect(response.headers.get("x-proxy-source-status")).toBe("fresh");
  });

  it("requests that arrive together share one check and all get its result", async () => {
    const { variant } = await publish();
    await sql("UPDATE projects SET fetched_at = fetched_at - ?", 3 * DAY);
    serveSpec(withoutPost());
    const before = callsTo("GET", SPEC_URL);

    const responses = await Promise.all(Array.from({ length: 5 }, () => call(variant.path)));
    for (const response of responses) expect(await methods(response)).toEqual(["get"]);
    expect(callsTo("GET", SPEC_URL) - before).toBe(1);
  });
});

describe("asking for the truth right now", () => {
  it("Cache-Control: no-cache revalidates before answering, even inside the interval", async () => {
    const { variant } = await publish();
    await sql("UPDATE projects SET fetched_at = fetched_at - ?", 60_000);
    serveSpec(withoutPost());

    // An ordinary request is still answered from the copy, which is one minute old.
    expect(await methods(await call(variant.path))).toEqual(["get", "post"]);

    const forced = await call(variant.path, { headers: { "cache-control": "no-cache" } });
    expect(await methods(forced)).toEqual(["get"]);
  });

  it("cannot be used to hammer the source", async () => {
    const { variant } = await publish();
    const before = callsTo("GET", SPEC_URL);
    for (let i = 0; i < 5; i++) {
      await call(variant.path, { headers: { "cache-control": "no-cache" } });
    }
    // The copy is seconds old: nothing to revalidate yet.
    expect(callsTo("GET", SPEC_URL) - before).toBe(0);
  });
});
