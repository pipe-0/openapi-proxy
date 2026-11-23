import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApplyResult, ProjectView } from "@openapi-proxy/core";
import { describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { copyOf } from "./helpers.js";

const ORIGIN = "http://localhost:7745";

/** A folder that stands for the built page. */
function page(): string {
  const dir = mkdtempSync(join(tmpdir(), "openapi-proxy-page-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>openapi-proxy</title>");
  return dir;
}

/** The several-audiences example in a folder of its own, served with the editor. */
function editing(options: { editor?: boolean } = {}) {
  const dir = copyOf("several-audiences");
  const config = join(dir, "openapi-proxy.yaml");
  const app = createServer({
    config,
    sources: [],
    allowedHosts: [],
    editor: options.editor === false ? undefined : page(),
  });
  const ask = (path: string, init?: RequestInit) =>
    app.fetch(new Request(`${ORIGIN}${path}`, init));
  const view = async () => (await (await ask("/api/projects/bookshop")).json()) as ProjectView;
  const save = (body: unknown, headers: Record<string, string> = {}) =>
    ask("/api/projects/bookshop", {
      method: "PUT",
      headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
      body: JSON.stringify(body),
    });
  return { config, ask, view, save, text: () => readFileSync(config, "utf8") };
}

describe("what the local server answers the editor", () => {
  it("gives the file as a project, in the shape the service gives one", async () => {
    const { ask, view } = editing();
    const project = await view();
    expect(project.definition.project).toBe("bookshop");
    expect(Object.keys(project.definition.variants)).toEqual([
      "docs",
      "sdk",
      "partner",
      "internal",
    ]);
    expect(project.state).toMatchObject({
      managedBy: "file",
      urlPrefix: `${ORIGIN}/v/`,
      check: null,
      // The workspace this file is deployed to is not known here.
      defaultVisibility: null,
      can: { edit: true, credentials: false, keys: false, check: false },
    });
    expect(project.state.sources.map(({ name, operations }) => [name, operations])).toEqual([
      ["core", 4],
      ["billing", 2],
    ]);
    expect(project.state.variants.docs).toMatchObject({
      url: `${ORIGIN}/v/bookshop/docs`,
      visibility: { value: "public", from: "variant" },
      servedOperations: 4,
      totalOperations: 6,
    });
    expect(project.state.variants.partner?.visibility).toEqual({
      value: "private",
      from: "project",
    });
    // Operations of a merged project say which document they came from.
    expect(
      project.state.operations.find((entry) => entry.key === "GET /billing/invoices")?.source,
    ).toBe("billing");

    // The list the page starts from is this one project.
    const listed = (await (await ask("/api/projects")).json()) as ProjectView[];
    expect(listed.map((each) => [each.definition, each.state.revision])).toEqual([
      [project.definition, project.state.revision],
    ]);
    expect((await ask("/api/projects/other")).status).toBe(404);
    const document = await ask("/api/projects/bookshop/document");
    expect(document.status).toBe(200);
    expect(Object.keys(((await document.json()) as { paths: object }).paths)).toContain(
      "/billing/invoices",
    );
  });

  it("saves a changed definition into the file, and says what that did", async () => {
    const { view, save, text } = editing();
    const before = text();
    const project = await view();
    const { partner: _, ...rest } = project.definition.variants;
    const response = await save({
      definition: {
        ...project.definition,
        variants: { ...rest, staff: { name: "Staff", include: { tags: ["Admin"] } } },
      },
      ifRevision: project.state.revision,
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as ApplyResult;
    expect(result.variants.map(({ slug, action }) => [slug, action])).toEqual([
      ["docs", "unchanged"],
      ["sdk", "unchanged"],
      ["internal", "unchanged"],
      ["staff", "created"],
      ["partner", "deleted"],
    ]);
    expect(result.project.revision).not.toBe(project.state.revision);

    const after = text();
    expect(after).toContain("  staff:\n    name: Staff\n    include:\n      tags: [Admin]\n");
    expect(after).not.toContain("partner:");
    // What was not changed is as its author wrote it.
    expect(after).toContain(
      "# Two services merged into one API, and a document for each audience.",
    );
    expect(after).toContain(
      "  # Mounted under /billing in the real API, so its paths get that prefix.",
    );
    expect(after.split("\n").slice(0, 30)).toEqual(before.split("\n").slice(0, 30));
    expect((await view()).state.revision).toBe(result.project.revision);
  });

  it("refuses a save that started from an older file, or that is not a definition", async () => {
    const { view, save, text, config } = editing();
    const project = await view();
    // Someone edits the file in their own editor in the meantime.
    writeFileSync(config, `${text()}\n# a note\n`);
    const before = text();
    const stale = await save({
      definition: project.definition,
      ifRevision: project.state.revision,
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "conflict" });

    const invalid = await save({ definition: { ...project.definition, variants: { "A B": {} } } });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      code: "invalid-definition",
      problems: [{ path: "variants.A B" }],
    });
    // The slug is what the file is deployed as. It is not changed from the page.
    const renamed = await save({ definition: { ...project.definition, project: "other" } });
    expect([400, 404]).toContain(renamed.status);
    // A rehearsal answers and writes nothing.
    const fresh = await view();
    const rehearsal = await editing().ask("/api/projects/bookshop?dryRun=true", {
      method: "PUT",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ definition: { ...fresh.definition, name: "Rehearsed" } }),
    });
    expect(((await rehearsal.json()) as ApplyResult).dryRun).toBe(true);
    expect(text()).toBe(before);
  });

  it("takes a save from its own page only", async () => {
    const { view, save, text, ask } = editing();
    const before = text();
    const body = { definition: { ...(await view()).definition, name: "Taken over" } };
    // Another site, a form's content type, and no word about where it comes from.
    expect((await save(body, { origin: "https://evil.example" })).status).toBe(403);
    expect((await save(body, { "content-type": "text/plain" })).status).toBe(403);
    const anonymous = await ask("/api/projects/bookshop", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(anonymous.status).toBe(403);
    expect(text()).toBe(before);
    // What the page asks is not answered to a script on another site.
    const read = await ask("/api/projects/bookshop", {
      headers: { origin: "https://evil.example" },
    });
    expect(read.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("serves the page, and nothing that writes when started without it", async () => {
    const withPage = editing();
    const index = await withPage.ask("/");
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toContain("text/html");
    expect(index.headers.get("content-security-policy")).toContain("default-src 'self'");
    // Only what the page is made of: nothing else on the disk.
    expect((await withPage.ask("/assets/..%2F..%2Fopenapi-proxy.yaml")).status).toBe(404);

    const without = editing({ editor: false });
    expect((await without.ask("/v/bookshop/docs.json")).status).toBe(200);
    expect((await without.ask("/")).status).toBe(404);
    expect((await without.ask("/api/projects")).status).toBe(404);
    const body = { definition: (await withPage.view()).definition };
    expect([403, 404]).toContain((await without.save(body)).status);
  });
});
