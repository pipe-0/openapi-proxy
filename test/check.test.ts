import { describe, expect, it } from "vitest";
import {
  type ApiProject,
  type ApiVariant,
  call,
  callsTo,
  mainSource,
  publish,
  SPEC,
  SPEC_URL,
  serveSpec,
  upstream,
  upstreamCalls,
} from "./harness";

const getProject = async (cookie: string, id: string) =>
  (await (await call(`/api/projects/${id}`, { headers: { cookie } })).json()) as ApiProject;
/** "Check now": the one way a person makes the service look at a source. */
const check = (cookie: string, id: string) =>
  call(`/api/projects/${id}/check`, { method: "POST", headers: { cookie } });

describe("a selection and a document that have drifted apart", () => {
  it("names what the document no longer has, and keeps serving the rest", async () => {
    const { cookie, project } = await publish({
      selection: {
        mode: "include",
        operations: ["GET /pets", "POST /pets"],
        tags: ["retired"],
      },
    });

    // The source loses POST /pets and gains DELETE /pets.
    const changed = structuredClone(SPEC) as { paths: Record<string, Record<string, unknown>> };
    changed.paths["/pets"] = {
      get: SPEC.paths["/pets"].get,
      delete: { tags: ["pets"], responses: { "204": { description: "gone" } } },
    };
    serveSpec(changed);

    expect(await (await check(cookie, project.id)).json()).toMatchObject({
      changed: true,
      addedOps: ["DELETE /pets"],
      removedOps: ["POST /pets"],
    });

    const [variant] = (await (
      await call("/api/variants", { headers: { cookie } })
    ).json()) as ApiVariant[];
    expect(variant?.notFound.include).toEqual({ operations: ["POST /pets"], tags: ["retired"] });

    const served = await call(variant?.path as string);
    expect(served.status).toBe(200);
    const doc = (await served.json()) as { paths: Record<string, Record<string, object>> };
    expect(Object.keys(doc.paths["/pets"] ?? {})).toEqual(["get"]);

    // Nothing was decided or forgotten: when the operation is back, it is served again.
    serveSpec();
    await check(cookie, project.id);
    const back = (await (await call(variant?.path as string)).json()) as typeof doc;
    expect(Object.keys(back.paths["/pets"] ?? {})).toEqual(["get", "post"]);
  });
});

describe("checking a source", () => {
  it("asks with the validators the source sent, and a 304 changes nothing", async () => {
    const { cookie, project, variant } = await publish();
    upstream("GET", SPEC_URL, (request) =>
      request.headers.get("if-none-match") === '"v1"'
        ? new Response(null, { status: 304 })
        : new Response(JSON.stringify(SPEC), { headers: { etag: '"v1"' } }),
    );
    await check(cookie, project.id);
    const etag = (await call(variant.path)).headers.get("etag");

    expect(await (await check(cookie, project.id)).json()).toMatchObject({ changed: false });
    expect(upstreamCalls.at(-1)?.headers.get("if-none-match")).toBe('"v1"');
    const after = await call(variant.path);
    expect(after.headers.get("x-proxy-source-status")).toBe("fresh");
    expect(after.headers.get("etag")).toBe(etag);
  });

  it("treats a download with the same bytes as no change, and picks up validators it starts to send", async () => {
    const { cookie, project, variant } = await publish();
    const etag = (await call(variant.path)).headers.get("etag");
    expect(mainSource(await getProject(cookie, project.id)).validator).toBeNull();

    serveSpec(SPEC, { etag: '"abc"' });
    expect(await (await check(cookie, project.id)).json()).toMatchObject({ changed: false });
    expect((await call(variant.path)).headers.get("etag")).toBe(etag);
    expect(mainSource(await getProject(cookie, project.id)).validator).toBe("etag");
  });

  it("keeps serving the last good copy when the source fails, and says so", async () => {
    const { cookie, project, variant } = await publish();
    upstream("GET", SPEC_URL, () => new Response("boom", { status: 500 }));
    await check(cookie, project.id);

    const response = await call(variant.path);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-proxy-source-status")).toBe("stale-error");
    expect(Object.keys(((await response.json()) as { paths: object }).paths)).toEqual(["/pets"]);
    expect((await getProject(cookie, project.id)).lastError).toContain("HTTP 500");

    // Once the source is back, the next check clears it.
    serveSpec();
    await check(cookie, project.id);
    expect((await call(variant.path)).headers.get("x-proxy-source-status")).toBe("fresh");
  });

  it("is never caused by a reader, however old the copy is", async () => {
    const { variant } = await publish();
    const before = callsTo("GET", SPEC_URL);
    const { sql } = await import("./harness");
    await sql("UPDATE projects SET fetched_at = 0, next_check_at = 0");

    for (const path of [variant.path, `${variant.path}.yaml`, `${variant.path}/3.0.json`]) {
      expect((await call(path)).status).toBe(200);
    }
    expect((await call(variant.path, { method: "HEAD" })).status).toBe(200);
    expect(callsTo("GET", SPEC_URL)).toBe(before);
  });
});

describe("a source that breaks", () => {
  it("cannot hide that by wording its broken document like a platform error", async () => {
    const { cookie, project } = await publish();
    // The parser quotes what it could not read, so the words end up in the error.
    upstream(
      "GET",
      SPEC_URL,
      () => new Response("openapi: 3.1.0\n\ttoo many subrequests: 1\n", { status: 200 }),
    );
    const checked = await call(`/api/projects/${project.id}/check`, {
      method: "POST",
      headers: { cookie },
    });
    expect(checked.status).toBe(200);
    const after = await getProject(cookie, project.id);
    expect(after.lastStatus).toBe("error");
    expect(after.lastError).toContain("Not valid YAML");
  });
});
