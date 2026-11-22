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
  it("is for whoever owns the project: a check on demand, by button, token or agent", async () => {
    const { cookie, project, variant } = await publish();
    serveSpec(withoutPost());

    // A request to the public URL is answered from the copy, which is seconds old...
    expect(await methods(await call(variant.path))).toEqual(["get", "post"]);
    // ...whatever it sends: readers are anonymous, and do not decide how often a source is called.
    const insisting = await call(variant.path, { headers: { "cache-control": "no-cache" } });
    expect(await methods(insisting)).toEqual(["get", "post"]);

    await call(`/api/projects/${project.id}/check`, { method: "POST", headers: { cookie } });
    expect(await methods(await call(variant.path))).toEqual(["get"]);
  });
});
