import { afterEach, describe, expect, it } from "vitest";
import { timing } from "../src/server/serve";
import { call, callsTo, publish, SPEC, SPEC_URL, serveSpec, sql, upstream } from "./harness";

/**
 * The promise is "a URL that always reflects the current source". These tests
 * pin down what that means when nobody has asked for a while, when many ask at
 * once, when the source is slow, and when someone needs the truth right now.
 */
const DAY = 24 * 60 * 60 * 1000;
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
    await age(305_000); // five seconds past the default interval
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

describe("asking for the truth right now", () => {
  it("Cache-Control: no-cache checks the source first, even inside the interval", async () => {
    const { variant } = await publish();
    await age(60_000);
    serveSpec(withoutPost());

    // An ordinary request is answered from the copy, which is one minute old.
    expect(await methods(await call(variant.path))).toEqual(["get", "post"]);

    const forced = await call(variant.path, { headers: { "cache-control": "no-cache" } });
    expect(await methods(forced)).toEqual(["get"]);
    expect(forced.headers.get("x-proxy-source-status")).toBe("fresh");
  });

  it("honors max-age the same way", async () => {
    const { variant } = await publish();
    await age(60_000);
    serveSpec(withoutPost());

    const relaxed = await call(variant.path, { headers: { "cache-control": "max-age=120" } });
    expect(await methods(relaxed)).toEqual(["get", "post"]);
    const strict = await call(variant.path, { headers: { "cache-control": "max-age=30" } });
    expect(await methods(strict)).toEqual(["get"]);
  });

  it("cannot be used to hammer the source", async () => {
    const { variant } = await publish();
    const before = callsTo("GET", SPEC_URL);
    for (let i = 0; i < 5; i++) {
      await call(variant.path, { headers: { "cache-control": "no-cache" } });
    }
    // The copy is seconds old: nothing to check yet.
    expect(callsTo("GET", SPEC_URL) - before).toBe(0);
  });

  it("tells caches to revalidate every time when the interval is 0", async () => {
    const { cookie, project, variant } = await publish();
    expect((await call(variant.path)).headers.get("cache-control")).toBe(
      "public, max-age=60, stale-while-revalidate=300",
    );
    await call(`/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ ttlSeconds: 0 }),
    });
    expect((await call(variant.path)).headers.get("cache-control")).toBe("public, no-cache");
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
