import type { VariantDefinition } from "@openapi-proxy/core";
import { describe, expect, it } from "vitest";
import { edgeCacheKey } from "../src/server/serve";
import {
  applied,
  call,
  createProject,
  edit,
  getProject,
  login,
  publish,
  SPEC,
  serveSpec,
  sql,
  textOf,
} from "./harness";

/** Change one variant of the project `test`, like a save in the app. */
const setVariant = (cookie: string, slug: string, variant: VariantDefinition) =>
  edit(cookie, "test", (d) => ({ ...d, variants: { ...d.variants, [slug]: variant } }));
const etagOf = async (path: string) => (await call(path)).headers.get("etag");

describe("serving a variant", () => {
  it("serves the filtered document with caching headers", async () => {
    const { variant } = await publish();
    const response = await call(variant.path);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("etag")).toMatch(/^"[0-9a-f]{32}"$/);
    expect(response.headers.get("cache-control")).toContain("stale-while-revalidate");
    expect(response.headers.get("x-proxy-source-status")).toBe("fresh");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("vary")).toBe("Accept");

    const doc = (await response.json()) as {
      paths: Record<string, object>;
      components: { schemas: Record<string, object> };
    };
    expect(Object.keys(doc.paths)).toEqual(["/pets"]);
    expect(Object.keys(doc.components.schemas)).toEqual(["Pet"]);
  });

  it("mirrors the source's JSON formatting", async () => {
    const cookie = await login();

    serveSpec(JSON.stringify(SPEC));
    await createProject(cookie, { variants: { public: {} } });
    expect(await (await call("/v/test/public.json")).text()).not.toContain("\n");

    serveSpec(JSON.stringify(SPEC, null, 2), {}, "https://pretty.example.com/openapi.json");
    await createProject(cookie, {
      project: "pretty",
      sources: [{ url: "https://pretty.example.com/openapi.json", follow: true }],
      variants: { public: {} },
    });
    expect(await (await call("/v/pretty/public.json")).text()).toContain('\n  "openapi": "3.1.0"');
  });

  it("serves YAML by extension or Accept header, with its own ETag", async () => {
    const { variant } = await publish();
    const asJson = await call(`${variant.path}.json`);
    const asYaml = await call(`${variant.path}.yaml`);

    expect(asYaml.headers.get("content-type")).toBe("application/yaml; charset=utf-8");
    expect((await textOf(asYaml)).startsWith("openapi: 3.1.0")).toBe(true);
    expect(asYaml.headers.get("etag")).not.toBe(asJson.headers.get("etag"));
    // A URL that pins the format does not vary.
    expect(asYaml.headers.get("vary")).toBeNull();
    expect((await call(`${variant.path}.yml`)).status).toBe(200);

    const negotiated = await call(variant.path, { headers: { accept: "application/yaml" } });
    expect(negotiated.headers.get("content-type")).toContain("application/yaml");
    expect(negotiated.headers.get("etag")).toBe(asYaml.headers.get("etag"));
  });

  it("answers conditional requests, strong or weak", async () => {
    const { variant } = await publish();
    const etag = (await call(variant.path)).headers.get("etag") as string;

    for (const header of [etag, `W/${etag}`, `"something-else", W/${etag}`, "*"]) {
      const response = await call(variant.path, { headers: { "if-none-match": header } });
      expect(response.status, header).toBe(304);
      expect(response.headers.get("etag")).toBe(etag);
    }
    const miss = await call(variant.path, { headers: { "if-none-match": '"other"' } });
    expect(miss.status).toBe(200);
  });

  it("answers HEAD without a body", async () => {
    const { variant } = await publish();
    const head = await call(`${variant.path}.json`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("etag")).toBeTruthy();
    expect(await head.text()).toBe("");
  });

  it("404s for unknown projects and variants", async () => {
    const { variant } = await publish();
    expect((await call("/v/test/nope")).status).toBe(404);
    expect((await call("/v/nope/public")).status).toBe(404);
    expect((await call("/v/public")).status).toBe(404);
    expect((await call(`${variant.path}.txt`)).status).toBe(404);
  });

  it("changes the ETag and the document when the selection changes", async () => {
    const { cookie, variant } = await publish();
    const before = await call(variant.path);

    await applied(setVariant(cookie, "public", { include: { operations: ["GET /pets"] } }));

    const after = await call(variant.path);
    expect(after.headers.get("etag")).not.toBe(before.headers.get("etag"));
    const doc = (await after.json()) as { paths: Record<string, Record<string, object>> };
    expect(Object.keys(doc.paths["/pets"] ?? {})).toEqual(["get"]);
  });

  it("serves the title, description and servers a variant states instead of the source's", async () => {
    const { cookie, variant } = await publish({ variant: {} });
    const before = await call(variant.path);
    const source = (await before.json()) as { info: { title: string }; servers?: unknown };

    await applied(
      setVariant(cookie, "public", {
        overrides: {
          title: "Petstore, staging",
          servers: [{ url: "https://staging.example.com", description: "Staging" }],
        },
      }),
    );
    const after = await call(variant.path);
    expect(after.headers.get("etag")).not.toBe(before.headers.get("etag"));
    expect(await after.json()).toMatchObject({
      info: { title: "Petstore, staging" },
      servers: [{ url: "https://staging.example.com", description: "Staging" }],
    });

    // Another variant of the same project is a different audience: it says what the source says.
    await applied(setVariant(cookie, "production", {}));
    expect(((await (await call("/v/test/production")).json()) as typeof source).info.title).toBe(
      source.info.title,
    );
    // Taking the overrides away serves the source's own again.
    await applied(setVariant(cookie, "public", {}));
    expect(await (await call(variant.path)).json()).toEqual(source);
    expect((await call(variant.path)).headers.get("etag")).toBe(before.headers.get("etag"));

    const refused = await setVariant(cookie, "public", {
      overrides: { servers: [{ url: "staging.example.com" }] },
    });
    expect(refused.status).toBe(400);
  });

  it("fills in what a variant does not state from its project, key by key", async () => {
    const cookie = await login();
    serveSpec();
    await createProject(cookie, {
      variants: { plain: {}, titled: { overrides: { title: "For partners" } } },
    });
    const doc = async (slug: string) =>
      (await (await call(`/v/test/${slug}.json`)).json()) as {
        info: { title: string; description?: string };
        servers?: Array<{ url: string }>;
      };
    const sourceTitle = (await doc("plain")).info.title;

    // The project says what every variant has at the top.
    await applied(
      edit(cookie, "test", (d) => ({
        ...d,
        overrides: {
          title: "Pets",
          description: "Everything about pets.",
          servers: [{ url: "https://api.example.com" }],
        },
      })),
    );
    expect(await doc("plain")).toMatchObject({
      info: { title: "Pets", description: "Everything about pets." },
      servers: [{ url: "https://api.example.com" }],
    });
    // A variant's own title stays. The rest it did not state comes from the project.
    expect(await doc("titled")).toMatchObject({
      info: { title: "For partners", description: "Everything about pets." },
      servers: [{ url: "https://api.example.com" }],
    });

    // A change to the project's title changes what `plain` serves, and its ETag.
    // `titled` never served that title: its ETag stays, and nothing is rendered again.
    const etags = {
      plain: await etagOf("/v/test/plain.json"),
      titled: await etagOf("/v/test/titled.json"),
    };
    const result = await applied(
      edit(cookie, "test", (d) => ({ ...d, overrides: { ...d.overrides, title: "Pets, v2" } })),
    );
    expect(result.variants.map((variant) => variant.action)).toEqual(["unchanged", "unchanged"]);
    expect(await etagOf("/v/test/plain.json")).not.toBe(etags.plain);
    expect(await etagOf("/v/test/titled.json")).toBe(etags.titled);
    expect((await doc("plain")).info.title).toBe("Pets, v2");

    // Without them, the document speaks for itself again.
    await applied(edit(cookie, "test", ({ overrides: _, ...d }) => d));
    expect((await doc("plain")).info.title).toBe(sourceTitle);
    expect((await doc("titled")).info.title).toBe("For partners");
  });

  it("gives a variant an icon and a name for the navigation, which change nothing that is served", async () => {
    const { cookie, variant } = await publish();
    const before = await call(variant.path);

    const result = await applied(
      setVariant(cookie, "public", {
        name: "Public API",
        icon: "book",
        include: { tags: ["pets"] },
      }),
    );
    expect(result.variants).toMatchObject([{ slug: "public", action: "changed" }]);
    expect((await getProject(cookie)).definition.variants.public).toMatchObject({
      name: "Public API",
      icon: "book",
    });
    expect((await call(variant.path)).headers.get("etag")).toBe(before.headers.get("etag"));
    // Only the icons the app can draw.
    const refused = await setVariant(cookie, "public", { icon: "unicorn" as never });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(await refused.json())).toContain("book");
  });

  it("renders once and then serves the stored output", async () => {
    const { variant } = await publish();
    const first = await call(`${variant.path}.yaml`);
    const etag = first.headers.get("etag") as string;
    const body = await textOf(first);

    const stored = await sql(
      "SELECT format, etag FROM variant_outputs WHERE variant_id = ?",
      variant.id,
    );
    expect(stored.results).toEqual([{ format: "yaml", etag }]);

    // With the source document gone and the edge cache empty, only the stored
    // output can answer.
    await sql("DELETE FROM sources");
    await caches.default.delete(edgeCacheKey(variant.id, "yaml", etag));
    const second = await call(`${variant.path}.yaml`);
    expect(second.status).toBe(200);
    expect(await textOf(second)).toBe(body);

    // Nothing stored for JSON, and no source to render from: a clean error, not a crash.
    const missing = await call(`${variant.path}.json`);
    expect(missing.status).toBe(502);
  });
});

describe("webhooks", () => {
  it("are only served when selected", async () => {
    const cookie = await login();
    serveSpec({
      ...SPEC,
      webhooks: {
        petAdopted: {
          post: {
            tags: ["internal"],
            requestBody: {
              content: { "application/json": { schema: { $ref: "#/components/schemas/Secret" } } },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });
    const project = await createProject(cookie, {
      variants: { public: { include: { tags: ["pets"] } } },
    });
    expect(project.state.operations.map((op) => op.key)).toContain("POST webhook:petAdopted");

    const doc = (await (await call("/v/test/public")).json()) as {
      webhooks: object;
      components: { schemas: object };
    };
    expect(doc.webhooks).toEqual({});
    expect(Object.keys(doc.components.schemas)).toEqual(["Pet"]);
  });
});
