import { describe, expect, it } from "vitest";
import {
  applied,
  apply,
  call,
  callsTo,
  definitionOf,
  document,
  getProject,
  login,
  publish,
  SPEC,
  SPEC_URL,
  serveSpec,
  sql,
  upstream,
  upstreamCalls,
} from "./harness";

/** "Check now": the one way a person makes the service look at the sources it follows. */
const check = (cookie: string) =>
  call("/api/projects/test/check", { method: "POST", headers: { cookie } });

describe("a selection and a document that have drifted apart", () => {
  it("names what the document no longer has, and keeps serving the rest", async () => {
    const { cookie, variant } = await publish({
      variant: { include: { operations: ["GET /pets", "POST /pets"], tags: ["retired"] } },
    });

    // The source loses POST /pets and gains DELETE /pets.
    const changed = structuredClone(SPEC) as { paths: Record<string, Record<string, unknown>> };
    changed.paths["/pets"] = {
      get: SPEC.paths["/pets"].get,
      delete: { tags: ["pets"], responses: { "204": { description: "gone" } } },
    };
    serveSpec(changed);

    expect(await (await check(cookie)).json()).toMatchObject({
      changed: true,
      addedOps: ["DELETE /pets"],
      removedOps: ["POST /pets"],
    });

    const { state } = await getProject(cookie);
    expect(state.variants.public?.notFound.include).toEqual({
      operations: ["POST /pets"],
      tags: ["retired"],
    });
    expect(state.variants.public).toMatchObject({ servedOperations: 1, totalOperations: 3 });

    const served = await call(variant.path);
    expect(served.status).toBe(200);
    const doc = (await served.json()) as { paths: Record<string, Record<string, object>> };
    expect(Object.keys(doc.paths["/pets"] ?? {})).toEqual(["get"]);

    // Nothing was decided or forgotten: when the operation is back, it is served again.
    serveSpec();
    await check(cookie);
    const back = (await (await call(variant.path)).json()) as typeof doc;
    expect(Object.keys(back.paths["/pets"] ?? {})).toEqual(["get", "post"]);
  });
});

describe("checking a source", () => {
  it("asks with the validators the source sent, and a 304 changes nothing", async () => {
    const { cookie, variant } = await publish();
    upstream("GET", SPEC_URL, (request) =>
      request.headers.get("if-none-match") === '"v1"'
        ? new Response(null, { status: 304 })
        : new Response(JSON.stringify(SPEC), { headers: { etag: '"v1"' } }),
    );
    await check(cookie);
    const etag = (await call(variant.path)).headers.get("etag");

    expect(await (await check(cookie)).json()).toMatchObject({ changed: false });
    expect(upstreamCalls.at(-1)?.headers.get("if-none-match")).toBe('"v1"');
    const after = await call(variant.path);
    expect(after.headers.get("x-proxy-source-status")).toBe("fresh");
    expect(after.headers.get("etag")).toBe(etag);
  });

  it("treats a download with the same bytes as no change, and picks up validators it starts to send", async () => {
    const { cookie, variant } = await publish();
    const etag = (await call(variant.path)).headers.get("etag");
    expect((await getProject(cookie)).state.sources[0]?.validator).toBeNull();

    serveSpec(SPEC, { etag: '"abc"' });
    expect(await (await check(cookie)).json()).toMatchObject({ changed: false });
    expect((await call(variant.path)).headers.get("etag")).toBe(etag);
    expect((await getProject(cookie)).state.sources[0]?.validator).toBe("etag");
  });

  it("keeps serving the last good copy when the source fails, and says so", async () => {
    const { cookie, variant } = await publish();
    upstream("GET", SPEC_URL, () => new Response("boom", { status: 500 }));
    await check(cookie);

    const response = await call(variant.path);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-proxy-source-status")).toBe("stale-error");
    expect(Object.keys(((await response.json()) as { paths: object }).paths)).toEqual(["/pets"]);
    const failing = await getProject(cookie);
    expect(failing.state.check?.lastError).toContain("HTTP 500");
    expect(failing.state.sources[0]).toMatchObject({ lastStatus: "error" });

    // Once the source is back, the next check clears it.
    serveSpec();
    await check(cookie);
    expect((await call(variant.path)).headers.get("x-proxy-source-status")).toBe("fresh");
  });

  it("is never caused by a reader, however old the copy is", async () => {
    const { variant } = await publish();
    const before = callsTo("GET", SPEC_URL);
    await sql("UPDATE projects SET checked_at = 0, next_check_at = 0");

    for (const path of [variant.path, `${variant.path}.yaml`, `${variant.path}/3.0.json`]) {
      expect((await call(path)).status).toBe(200);
    }
    expect((await call(variant.path, { method: "HEAD" })).status).toBe(200);
    expect(callsTo("GET", SPEC_URL)).toBe(before);
  });
});

describe("a source that breaks", () => {
  it("cannot hide that by wording its broken document like a platform error", async () => {
    const { cookie } = await publish();
    // The parser quotes what it could not read, so the words end up in the error.
    upstream(
      "GET",
      SPEC_URL,
      () => new Response("openapi: 3.1.0\n\ttoo many subrequests: 1\n", { status: 200 }),
    );
    const checked = await check(cookie);
    expect(checked.status).toBe(200);
    expect(await checked.json()).toMatchObject({ changed: false, lastStatus: "error" });
    const after = await getProject(cookie);
    expect(after.state.check?.lastStatus).toBe("error");
    expect(after.state.check?.lastError).toContain("Not valid YAML");
  });
});

describe("a project whose documents are all uploaded", () => {
  it("has nothing to check, and says so", async () => {
    const cookie = await login();
    await applied(
      apply(cookie, definitionOf({ sources: [{ file: "openapi.json" }], variants: { all: {} } }), {
        documents: { main: document() },
      }),
    );
    const refused = await check(cookie);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "not-followed" });
    expect((await call("/v/test/all.json")).headers.get("x-proxy-source-status")).toBe("fresh");
  });

  it("is not checked for a URL either, unless the definition says to follow it", async () => {
    const cookie = await login();
    // The address says where the document came from. The copy is whatever was uploaded.
    await applied(
      apply(cookie, definitionOf({ sources: [{ url: SPEC_URL }], variants: { all: {} } }), {
        documents: { main: document() },
      }),
    );
    expect(callsTo("GET", SPEC_URL)).toBe(0);
    expect((await check(cookie)).status).toBe(409);
    expect((await getProject(cookie)).state.check).toBeNull();
  });
});
