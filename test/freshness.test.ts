import { afterEach, describe, expect, it } from "vitest";
import { timing } from "../src/server/serve";
import { call, callsTo, json, publish, SPEC, SPEC_URL, serveSpec, sql, upstream } from "./harness";

/**
 * The promise is "a URL that always reflects the current source". These tests
 * pin down what that means when nobody has asked for a while, when many ask at
 * once, when the source is slow, and when someone needs the truth right now.
 */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const defaults = { ...timing };
afterEach(() => Object.assign(timing, defaults));

const withoutPost = () => {
  const changed = structuredClone(SPEC) as { paths: Record<string, Record<string, unknown>> };
  changed.paths["/pets"] = { get: SPEC.paths["/pets"].get };
  return changed;
};
const methods = async (response: Response) =>
  Object.keys(((await response.json()) as { paths: Record<string, object> }).paths["/pets"] ?? {});
const age = (ms: number) => sql("UPDATE projects SET fetched_at = ?", Date.now() - ms);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A source that only answers once `release()` is called. */
function slowSource(body: unknown) {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  upstream("GET", SPEC_URL, async () => {
    await gate;
    return Response.json(body);
  });
  return release;
}

async function until(condition: () => boolean) {
  for (let i = 0; i < 200 && !condition(); i++) await sleep(10);
  expect(condition()).toBe(true);
}

describe("after a long quiet period", () => {
  it("the first request gets the current document, not the one from days ago", async () => {
    const { variant } = await publish();
    await age(3 * DAY);
    serveSpec(withoutPost());

    const response = await call(variant.path);
    expect(await methods(response)).toEqual(["get"]);
    expect(response.headers.get("x-proxy-source-status")).toBe("fresh");
  });

  it("requests that arrive together share one check and all get its result", async () => {
    const { variant } = await publish();
    await age(3 * DAY);
    const before = callsTo("GET", SPEC_URL);
    const release = slowSource(withoutPost());

    const responses = Array.from({ length: 5 }, () => call(variant.path));
    await until(() => callsTo("GET", SPEC_URL) > before);
    await sleep(150); // long enough for the others to be waiting on the one that checks
    release();

    for (const response of await Promise.all(responses)) {
      expect(await methods(response)).toEqual(["get"]);
      expect(response.headers.get("x-proxy-source-status")).toBe("fresh");
    }
    expect(callsTo("GET", SPEC_URL) - before).toBe(1);
  });
});

describe("a variant in steady use", () => {
  it("is answered from the copy while one request checks, so only that one waits", async () => {
    const { variant } = await publish();
    await age(HOUR + 5_000); // five seconds past the interval
    const before = callsTo("GET", SPEC_URL);
    const release = slowSource(withoutPost());

    const checking = call(variant.path);
    await until(() => callsTo("GET", SPEC_URL) > before);

    const meanwhile = await call(variant.path);
    expect(meanwhile.headers.get("x-proxy-source-status")).toBe("stale");
    expect(await methods(meanwhile)).toEqual(["get", "post"]);

    release();
    const checked = await checking;
    expect(checked.headers.get("x-proxy-source-status")).toBe("fresh");
    expect(await methods(checked)).toEqual(["get"]);
    expect(callsTo("GET", SPEC_URL) - before).toBe(1);
  });
});

describe("a slow source", () => {
  it("does not hold a request for longer than the wait limit", async () => {
    timing.checkWaitMs = 150;
    const { variant } = await publish();
    await age(3 * DAY);
    const release = slowSource(withoutPost());

    const pending = call(variant.path);
    await sleep(500); // well past the limit: the answer is decided by now
    release(); // the check itself carries on and completes in the background

    const response = await pending;
    expect(response.status).toBe(200);
    expect(response.headers.get("x-proxy-source-status")).toBe("stale");
    expect(await methods(response)).toEqual(["get", "post"]);

    const next = await call(variant.path);
    expect(next.headers.get("x-proxy-source-status")).toBe("fresh");
    expect(await methods(next)).toEqual(["get"]);
  });
});

describe("how often a source is asked", () => {
  // Nobody sets this. It follows from what a check costs the source.
  const checksAfter = async (path: string, ms: number) => {
    const before = callsTo("GET", SPEC_URL);
    await age(ms);
    await call(path);
    return callsTo("GET", SPEC_URL) - before;
  };

  it("once an hour, if every check means sending the whole document", async () => {
    const { variant } = await publish();
    expect(await checksAfter(variant.path, 59 * MINUTE)).toBe(0);
    expect(await checksAfter(variant.path, 61 * MINUTE)).toBe(1);
  });

  it("every five minutes, if the source can say cheaply that nothing changed", async () => {
    serveSpec(SPEC, { etag: '"v1"' });
    const { cookie, project, variant } = await publish({ serve: false });
    expect(project.checkIntervalSeconds).toBe(300);
    expect(await checksAfter(variant.path, 4 * MINUTE)).toBe(0);
    expect(await checksAfter(variant.path, 6 * MINUTE)).toBe(1);

    // It stops sending one: back to once an hour, and the app says so.
    serveSpec();
    await call(`/api/projects/${project.id}/check`, { method: "POST", headers: { cookie } });
    expect(await checksAfter(variant.path, 6 * MINUTE)).toBe(0);
    const now = (await (
      await call(`/api/projects/${project.id}`, { headers: { cookie } })
    ).json()) as { checkIntervalSeconds: number; sources: Array<{ cheap: boolean }> };
    expect(now).toMatchObject({ checkIntervalSeconds: 3600, sources: [{ cheap: false }] });
  });

  it("as often as its costliest document allows, when a project has several", async () => {
    const other = "https://billing.example.com/openapi.json";
    serveSpec(SPEC, { etag: '"v1"' });
    serveSpec({ ...SPEC, info: { title: "Billing", version: "1" } }, {}, other);
    const { cookie, project, variant } = await publish({ serve: false });
    const added = await call(
      `/api/projects/${project.id}/sources`,
      json("POST", { url: other, pathPrefix: "/billing" }, cookie),
    );
    expect(await added.json()).toMatchObject({
      checkIntervalSeconds: 3600,
      sources: [{ cheap: true }, { cheap: false }],
    });
    expect(await checksAfter(variant.path, 6 * MINUTE)).toBe(0);
  });

  it("not more often because a reader asks: readers are anonymous", async () => {
    const { variant } = await publish();
    await age(10 * MINUTE);
    serveSpec(withoutPost());
    const before = callsTo("GET", SPEC_URL);
    const insisting: Array<Record<string, string>> = [
      { "cache-control": "no-cache" },
      { "cache-control": "max-age=0" },
      { pragma: "no-cache" },
    ];
    for (const headers of insisting) {
      const response = await call(variant.path, { headers });
      expect(await methods(response)).toEqual(["get", "post"]);
    }
    expect(callsTo("GET", SPEC_URL) - before).toBe(0);
  });

  it("at once when someone who is signed in says so", async () => {
    const { cookie, project, variant } = await publish();
    serveSpec(withoutPost());
    await call(`/api/projects/${project.id}/check`, { method: "POST", headers: { cookie } });
    expect(await methods(await call(variant.path))).toEqual(["get"]);
  });

  it("and caches in between are told to keep a copy for a minute", async () => {
    const { variant } = await publish();
    expect((await call(variant.path)).headers.get("cache-control")).toBe(
      "public, max-age=60, stale-while-revalidate=300",
    );
  });
});

describe("the validator", () => {
  it("always describes the bytes that were sent", async () => {
    const { variant } = await publish();
    const before = await call(variant.path);
    const oldEtag = before.headers.get("etag");

    await age(3 * DAY);
    serveSpec(withoutPost());
    const changed = await call(variant.path);
    expect(await methods(changed)).toEqual(["get"]);
    expect(changed.headers.get("etag")).not.toBe(oldEtag);

    // The old validator no longer matches anything; the new one does.
    const stale = await call(variant.path, { headers: { "if-none-match": oldEtag as string } });
    expect(stale.status).toBe(200);
    const current = await call(variant.path, {
      headers: { "if-none-match": changed.headers.get("etag") as string },
    });
    expect(current.status).toBe(304);
  });
});
