import { describe, expect, it } from "vitest";
import {
  type ApiProject,
  type ApiVariant,
  call,
  callsTo,
  json,
  mainSource,
  patchSource,
  publish,
  SPEC,
  SPEC_URL,
  serveSpec,
  sql,
  upstream,
  upstreamCalls,
} from "./harness";

const VERSION_URL = "https://api.example.com/version";
/** Let time pass: long enough that any project is due for a check. */
const expire = (ms = 2 * 60 * 60_000) => sql("UPDATE projects SET fetched_at = fetched_at - ?", ms);
const getProject = async (cookie: string, id: string) =>
  (await (await call(`/api/projects/${id}`, { headers: { cookie } })).json()) as ApiProject;

describe("drift", () => {
  it("reports missing and new operations, and keeps serving", async () => {
    const { cookie, project } = await publish({
      selection: {
        mode: "include",
        operations: ["GET /pets", "POST /pets"],
        tags: [],
      },
    });

    // The source loses POST /pets and gains DELETE /pets.
    const changed = structuredClone(SPEC) as { paths: Record<string, Record<string, unknown>> };
    changed.paths["/pets"] = {
      get: SPEC.paths["/pets"].get,
      delete: { tags: ["pets"], responses: { "204": { description: "gone" } } },
    };
    serveSpec(changed);

    const refresh = await call(`/api/projects/${project.id}/check`, {
      method: "POST",
      headers: { cookie },
    });
    expect(await refresh.json()).toMatchObject({
      changed: true,
      addedOps: ["DELETE /pets"],
      removedOps: ["POST /pets"],
    });

    const [variant] = (await (
      await call("/api/variants", { headers: { cookie } })
    ).json()) as ApiVariant[];
    expect(variant?.drift.missingSelectedOperations).toEqual(["POST /pets"]);
    expect(variant?.drift.newOperations).toEqual(["DELETE /pets"]);

    const served = await call(variant?.path as string);
    expect(served.status).toBe(200);
    const doc = (await served.json()) as { paths: Record<string, Record<string, object>> };
    expect(Object.keys(doc.paths["/pets"] ?? {})).toEqual(["get"]);

    // "Keep" acknowledges the missing operation; saving the selection clears the "new" notice.
    const kept = await call(
      `/api/variants/${variant?.id}`,
      json("PATCH", { acknowledgedMissingOps: ["POST /pets", "GET /never-selected"] }, cookie),
    );
    expect(((await kept.json()) as ApiVariant).drift.acknowledged).toEqual(["POST /pets"]);
    const reviewed = await call(
      `/api/variants/${variant?.id}`,
      json("PATCH", { reviewNewOps: true }, cookie),
    );
    expect(((await reviewed.json()) as ApiVariant).drift.newOperations).toEqual([]);
  });
});

describe("revalidation", () => {
  it("revalidates with the validators the source sent", async () => {
    const { cookie, project, variant } = await publish();
    upstream("GET", SPEC_URL, (request) =>
      request.headers.get("if-none-match") === '"v1"'
        ? new Response(null, { status: 304 })
        : new Response(JSON.stringify(SPEC), { headers: { etag: '"v1"' } }),
    );
    await call(`/api/projects/${project.id}/check`, { method: "POST", headers: { cookie } });
    const etag = (await call(variant.path)).headers.get("etag");

    await expire();
    await call(variant.path);
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
    await expire();
    const response = await call(variant.path);
    expect(response.headers.get("x-proxy-source-status")).toBe("fresh");
    expect(response.headers.get("etag")).toBe(etag);
    expect(mainSource(await getProject(cookie, project.id)).validator).toBe("etag");
  });

  it("keeps serving the last good copy when the source fails, and backs off", async () => {
    const { cookie, project, variant } = await publish();
    upstream("GET", SPEC_URL, () => new Response("boom", { status: 500 }));
    const before = callsTo("GET", SPEC_URL);
    await expire();

    const first = await call(variant.path);
    expect(first.status).toBe(200);
    expect(callsTo("GET", SPEC_URL) - before).toBe(1);

    // The failure is now on record; further requests do not hammer the source.
    for (let i = 0; i < 3; i++) {
      const response = await call(variant.path);
      expect(response.status).toBe(200);
      expect(response.headers.get("x-proxy-source-status")).toBe("stale-error");
      expect(Object.keys(((await response.json()) as { paths: object }).paths)).toEqual(["/pets"]);
    }
    expect(callsTo("GET", SPEC_URL) - before).toBe(1);
    expect((await getProject(cookie, project.id)).lastError).toContain("HTTP 500");

    // Once the backoff has passed and the source is back, it recovers by itself.
    await sql("UPDATE projects SET check_claimed_at = check_claimed_at - ?", 6 * 60_000);
    serveSpec();
    await call(variant.path);
    expect((await call(variant.path)).headers.get("x-proxy-source-status")).toBe("fresh");
  });

  it("checks before answering once a copy is due, but does not wait on a dead source twice", async () => {
    const { variant } = await publish();
    const before = callsTo("GET", SPEC_URL);

    await expire();
    await call(variant.path);
    await expire();
    await call(variant.path);
    expect(callsTo("GET", SPEC_URL) - before).toBe(2);

    await expire();
    upstream("GET", SPEC_URL, () => new Response("boom", { status: 500 }));
    const failed = await call(variant.path);
    expect(failed.status).toBe(200);
    expect(failed.headers.get("x-proxy-source-status")).toBe("stale-error");
    // The failure starts a backoff: the next requests answer from the last good copy at once.
    const next = await call(variant.path);
    expect(next.headers.get("x-proxy-source-status")).toBe("stale-error");
    expect(callsTo("GET", SPEC_URL) - before).toBe(3);
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

describe("version endpoint", () => {
  async function withVersionEndpoint(headers: Record<string, string>) {
    const published = await publish();
    let version = "2026-11-01";
    upstream(
      "HEAD",
      VERSION_URL,
      () => new Response(null, { headers: { ...headers, "x-api-version": version } }),
    );
    const patched = await patchSource(published.cookie, published.project, {
      versionUrl: VERSION_URL,
    });
    expect(patched.status).toBe(200);
    return {
      ...published,
      patched: (await patched.json()) as ApiProject,
      bump: (v: string) => (version = v),
    };
  }

  it("is asked with HEAD first and records a version that matches the stored document", async () => {
    const { patched } = await withVersionEndpoint({});
    expect(mainSource(patched).versionUrl).toBe(VERSION_URL);
    // Saving the endpoint re-fetched the document, so version and body belong together.
    expect(mainSource(patched).lastKnownVersion).toBe("x-api-version: 2026-11-01");
    expect(callsTo("GET", VERSION_URL)).toBe(0);
  });

  it("skips the download while the version is unchanged, and downloads when it moves", async () => {
    const { variant, bump } = await withVersionEndpoint({});
    const downloads = callsTo("GET", SPEC_URL);
    const etag = (await call(variant.path)).headers.get("etag");

    await expire();
    await call(variant.path);
    expect(callsTo("GET", SPEC_URL)).toBe(downloads);
    expect((await call(variant.path)).headers.get("x-proxy-source-status")).toBe("fresh");

    bump("2026-11-02");
    const next = structuredClone(SPEC);
    next.info.version = "1.1.0";
    serveSpec(next);
    await expire();
    await call(variant.path);
    expect(callsTo("GET", SPEC_URL)).toBe(downloads + 1);
    expect((await call(variant.path)).headers.get("etag")).not.toBe(etag);
  });

  it("is not trusted forever: the document itself is compared once a day", async () => {
    const { variant } = await withVersionEndpoint({});
    const downloads = callsTo("GET", SPEC_URL);

    await sql("UPDATE sources SET verified_at = verified_at - ?", 25 * 60 * 60 * 1000);
    await expire();
    await call(variant.path);
    expect(callsTo("GET", SPEC_URL)).toBe(downloads + 1);
  });

  it("stops relying on an endpoint that reports one version for two different documents", async () => {
    // A version number nobody bumps: the classic way this goes wrong.
    const { cookie, project, variant } = await withVersionEndpoint({});
    const methods = async () =>
      Object.keys(
        ((await (await call(variant.path)).json()) as { paths: Record<string, object> }).paths[
          "/pets"
        ] ?? {},
      );
    const changed = structuredClone(SPEC) as { paths: Record<string, Record<string, unknown>> };
    changed.paths["/pets"] = { get: SPEC.paths["/pets"].get };
    serveSpec(changed);

    // Inside the day the endpoint is believed, so the change goes unnoticed.
    await expire();
    expect(await methods()).toEqual(["get", "post"]);

    // The daily comparison finds a new document behind the old version.
    await sql("UPDATE sources SET verified_at = verified_at - ?", 25 * 60 * 60 * 1000);
    await expire();
    expect(await methods()).toEqual(["get"]);
    expect(mainSource(await getProject(cookie, project.id)).versionMismatchAt).toBeGreaterThan(0);

    // From now on every check looks at the document itself, and the endpoint is left alone.
    const probes = callsTo("HEAD", VERSION_URL);
    serveSpec();
    await expire();
    expect(await methods()).toEqual(["get", "post"]);
    expect(callsTo("HEAD", VERSION_URL)).toBe(probes);

    // Saving the endpoint again gives it another chance.
    const saved = await patchSource(cookie, project, { versionUrl: VERSION_URL });
    expect(mainSource((await saved.json()) as ApiProject).versionMismatchAt).toBeNull();
  });

  it("does not blame the endpoint for a deploy that lands between its two requests", async () => {
    const { cookie, project, variant, bump } = await withVersionEndpoint({});
    const next = structuredClone(SPEC);
    next.info.version = "1.1.0";
    // The version is read first; the deploy happens right after, before the download.
    upstream("GET", SPEC_URL, () => {
      bump("2026-11-02");
      return Response.json(next);
    });

    await sql("UPDATE sources SET verified_at = verified_at - ?", 25 * 60 * 60 * 1000);
    await expire();
    await call(variant.path);
    expect(mainSource(await getProject(cookie, project.id)).versionMismatchAt).toBeNull();
  });

  it("reads a version from a small body when there is no header", async () => {
    const { cookie, project } = await publish();
    upstream("HEAD", VERSION_URL, () => new Response(null, { status: 405 }));
    upstream("GET", VERSION_URL, () => new Response(JSON.stringify({ commit: "abc123" })));
    const patched = await patchSource(cookie, project, { versionUrl: VERSION_URL });
    expect(mainSource((await patched.json()) as ApiProject).lastKnownVersion).toBe(
      "commit: abc123",
    );
  });

  it("refuses an endpoint that reports no version", async () => {
    const { cookie, project } = await publish();
    upstream("HEAD", VERSION_URL, () => new Response(null));
    upstream("GET", VERSION_URL, () => new Response(JSON.stringify({ status: "ok" })));
    const patched = await patchSource(cookie, project, { versionUrl: VERSION_URL });
    expect(patched.status).toBe(422);
    expect(((await patched.json()) as { code: string }).code).toBe("no-version");
    expect(mainSource(await getProject(cookie, project.id)).versionUrl).toBeNull();
  });

  it("can be removed again", async () => {
    const { cookie, project } = await withVersionEndpoint({});
    const cleared = await patchSource(cookie, project, { versionUrl: null });
    expect(mainSource((await cleared.json()) as ApiProject)).toMatchObject({
      versionUrl: null,
      lastKnownVersion: null,
    });
  });
});
