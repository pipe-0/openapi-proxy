import { readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { serve } from "@hono/node-server";
import { afterEach, describe, expect, it } from "vitest";
import { deploy, originOf } from "../src/commands/deploy.js";
import { ConfigError } from "../src/config.js";
import { captured, copyOf } from "./helpers.js";

interface Received {
  path: string;
  authorization: string | null;
  body: {
    definition: { project: string; instance?: string; sources: unknown[] };
    documents: Record<string, { gzip: string }>;
    origin?: Record<string, string>;
  };
}

/** What the service answers to a first deploy of the repository example. */
const CREATED = {
  dryRun: false,
  created: true,
  tookOver: false,
  project: { slug: "bookshop", revision: 1, managedBy: "file" },
  sources: [
    {
      name: "main",
      action: "added",
      document: "uploaded",
      follow: false,
      bytes: 2400,
      operations: 8,
    },
  ],
  variants: [
    {
      slug: "public",
      action: "created",
      url: "https://openapi-proxy.app/v/bookshop/public",
      visibility: { value: "public", from: "workspace" },
      servedOperations: 5,
      totalOperations: 8,
      notFound: {
        include: { operations: [], tags: [] },
        exclude: { operations: ["DELETE /orders/{id}"], tags: [] },
      },
    },
    {
      slug: "old",
      action: "deleted",
      url: "https://openapi-proxy.app/v/bookshop/old",
      visibility: { value: "private", from: "variant" },
      servedOperations: 0,
      totalOperations: 8,
      notFound: { include: { operations: [], tags: [] }, exclude: { operations: [], tags: [] } },
      keysRemoved: 1,
    },
  ],
  operations: { total: 8, added: [], removed: [], changed: [] },
  warnings: [],
};

const servers: Array<ReturnType<typeof serve>> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/** Something that stands where the service does, and remembers what it was sent. */
async function service(answer: (received: Received) => Response = () => Response.json(CREATED)) {
  const received: Received[] = [];
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const started = serve(
      {
        port: 0,
        hostname: "127.0.0.1",
        fetch: async (request) => {
          const url = new URL(request.url);
          const entry = {
            path: `${url.pathname}${url.search}`,
            authorization: request.headers.get("authorization"),
            body: (await request.json()) as Received["body"],
          };
          received.push(entry);
          return answer(entry);
        },
      },
      () => resolve(started),
    );
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, received };
}

/** The repository example, pointed at an instance. */
function repository(instance: string, change: (text: string) => string = (text) => text) {
  const dir = copyOf("in-your-repository");
  const config = join(dir, "openapi-proxy.yaml");
  writeFileSync(config, change(`${readFileSync(config, "utf8")}\ninstance: ${instance}\n`));
  return { dir, config };
}
const KEY = { OPENAPI_PROXY_DEPLOY_KEY: "oap_test" };

describe("deploy", () => {
  it("sends the definition with its documents, and says what the service did", async () => {
    const { url, received } = await service();
    const { dir, config } = repository(url);
    const { result, out, err } = await captured(() => deploy({ config, dryRun: false, env: KEY }));
    expect(result).toBe(0);

    expect(received).toHaveLength(1);
    const [sent] = received;
    expect(sent?.path).toBe("/api/projects/bookshop");
    expect(sent?.authorization).toBe("Bearer oap_test");
    expect(sent?.body.definition.project).toBe("bookshop");
    // The document, byte for byte as it is in the repository.
    const document = gunzipSync(Buffer.from(sent?.body.documents.main?.gzip ?? "", "base64"));
    expect(document.equals(readFileSync(join(dir, "openapi.json")))).toBe(true);
    // Not in a pipeline: nothing to say about where it ran.
    expect(sent?.body.origin).toBeUndefined();

    expect(out).toContain(`Created bookshop on ${url}`);
    expect(out).toMatch(/main\s+uploaded\s+2 kB\s+8 operations\s+read from .*openapi\.json/);
    expect(out).toMatch(
      /public\s+created\s+5 of 8 operations\s+public \(from the workspace\)\s+https:\/\/openapi-proxy\.app\/v\/bookshop\/public/,
    );
    expect(out).toMatch(/old\s+deleted\s+1 user API key for it removed/);
    // A name the document does not have yet is said, with the line it is on.
    expect(err).toMatch(
      /warning .*openapi-proxy\.yaml:\d+ {2}variants\.public\.exclude\.operations names "DELETE \/orders\/\{id\}"/,
    );
  });

  it("uploads a document as the bytes it is, byte order mark and all", async () => {
    const { url, received } = await service();
    const { dir, config } = repository(url);
    // As some tools write JSON: with a mark in front that says it is UTF-8.
    const marked = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      readFileSync(join(dir, "openapi.json")),
    ]);
    writeFileSync(join(dir, "openapi.json"), marked);
    const { result } = await captured(() => deploy({ config, dryRun: false, env: KEY }));
    expect(result).toBe(0);
    const sent = gunzipSync(Buffer.from(received[0]?.body.documents.main?.gzip ?? "", "base64"));
    // What the service stores is what its source would serve, so that a later
    // look at a followed address finds the same document, and not a "new" one.
    expect(sent.equals(marked)).toBe(true);
  });

  it("says where it ran when a pipeline runs it, and rehearses with --dry-run", async () => {
    const { url, received } = await service(() => Response.json({ ...CREATED, dryRun: true }));
    const { config } = repository(url);
    const env = {
      ...KEY,
      GITHUB_ACTIONS: "true",
      GITHUB_SHA: "4f2a9c1",
      GITHUB_REF: "refs/heads/main",
      GITHUB_REPOSITORY: "acme/bookshop",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_RUN_ID: "42",
    };
    const { result, out } = await captured(() => deploy({ config, dryRun: true, env }));
    expect(result).toBe(0);
    expect(received[0]?.path).toBe("/api/projects/bookshop?dryRun=true");
    expect(received[0]?.body.origin).toEqual({
      commit: "4f2a9c1",
      ref: "refs/heads/main",
      repository: "acme/bookshop",
      runUrl: "https://github.com/acme/bookshop/actions/runs/42",
    });
    expect(out).toContain("Dry run:");
    expect(out).toContain("Nothing was changed.");

    expect(
      originOf({
        GITLAB_CI: "true",
        CI_COMMIT_SHA: "abc",
        CI_COMMIT_REF_NAME: "main",
        CI_PROJECT_PATH: "acme/bookshop",
        CI_PIPELINE_URL: "https://gitlab.com/acme/bookshop/-/pipelines/7",
      }),
    ).toEqual({
      commit: "abc",
      ref: "main",
      repository: "acme/bookshop",
      runUrl: "https://gitlab.com/acme/bookshop/-/pipelines/7",
    });
    expect(originOf({})).toEqual({});
  });

  it("needs a key, and says where one comes from", async () => {
    const { url, received } = await service();
    const { config } = repository(url);
    const { result, err } = await captured(() => deploy({ config, dryRun: false, env: {} }));
    expect(result).toBe(1);
    expect(err).toContain("OPENAPI_PROXY_DEPLOY_KEY is not set");
    expect(err).toContain(`${url}/workspace`);
    expect(received).toEqual([]);
  });

  it("does not send what is in the variable unless it is a key of this service", async () => {
    const { url, received } = await service();
    const { config } = repository(url);
    // A secret of something else, stored under this name by mistake.
    const { result, err } = await captured(() =>
      deploy({
        config,
        dryRun: false,
        env: { OPENAPI_PROXY_DEPLOY_KEY: "ghp_someone-elses-secret" },
      }),
    );
    expect(result).toBe(1);
    expect(err).toContain(
      "OPENAPI_PROXY_DEPLOY_KEY does not hold a deploy API key of openapi-proxy",
    );
    expect(err).toContain("Nothing was sent");
    expect(err).not.toContain("ghp_someone-elses-secret");
    expect(received).toEqual([]);
  });

  it("does not send a key over plain HTTP, except to this machine", async () => {
    const { config } = repository("http://proxy.example.com");
    const refused = await deploy({ config, dryRun: false, env: KEY }).catch((error) => error);
    expect(refused).toBeInstanceOf(ConfigError);
    expect((refused as ConfigError).problems).toMatchObject([
      { path: "instance", message: expect.stringContaining("https://") },
    ]);
  });

  it("stops when a document cannot be read here, unless the service follows it", async () => {
    const { url, received } = await service();
    const missing = repository(url, (text) => text.replace("./openapi.json", "./nowhere.json"));
    const stopped = await captured(() =>
      deploy({ config: missing.config, dryRun: false, env: KEY }),
    );
    expect(stopped.result).toBe(1);
    expect(stopped.err).toContain("nowhere.json could not be read");
    expect(received).toEqual([]);

    // A followed address that does not answer from here: the service reads it itself.
    const followed = repository(url, (text) =>
      text.replace(
        "- file: ./openapi.json",
        "- url: http://127.0.0.1:9/openapi.json\n    follow: true",
      ),
    );
    const sent = await captured(() => deploy({ config: followed.config, dryRun: false, env: KEY }));
    expect(sent.result).toBe(0);
    expect(sent.err).toContain("It is followed, so the service reads it itself.");
    expect(received).toHaveLength(1);
    expect(received[0]?.body.documents).toEqual({});
  });

  it("passes on why the service refused", async () => {
    const answers: Array<[number, object]> = [
      [401, { code: "unauthorized", error: "This API key is not valid." }],
      [409, { code: "slug-taken", error: '"bookshop" is already taken.' }],
      [
        400,
        {
          code: "invalid-definition",
          error: "…",
          problems: [{ path: "variants.public.icon", message: "is not one of the icons." }],
        },
      ],
      [
        402,
        { code: "plan-limit", error: "The Free plan includes 3 projects. Pro lifts this limit." },
      ],
    ];
    const { url } = await service(() => {
      const [status, body] = answers.shift() as [number, object];
      return Response.json(body, { status });
    });
    const { config } = repository(url);
    const attempt = async () => {
      const { result, err } = await captured(() => deploy({ config, dryRun: false, env: KEY }));
      expect(result).toBe(1);
      return err;
    };
    expect(await attempt()).toContain("did not accept the key in OPENAPI_PROXY_DEPLOY_KEY");
    expect(await attempt()).toContain('"bookshop" belongs to another workspace');
    expect(await attempt()).toMatch(
      /openapi-proxy\.yaml:\d+ {2}variants\.public\.icon is not one of the icons\./,
    );
    expect(await attempt()).toContain("The Free plan includes 3 projects.");
  });

  it("says so when the service is not there", async () => {
    const { config } = repository("http://127.0.0.1:9");
    const { result, err } = await captured(() => deploy({ config, dryRun: false, env: KEY }));
    expect(result).toBe(1);
    expect(err).toContain("http://127.0.0.1:9 could not be reached");
  });
});
