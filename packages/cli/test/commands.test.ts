import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { init } from "../src/commands/init.js";
import { operations } from "../src/commands/operations.js";
import { validate } from "../src/commands/validate.js";
import { loadConfig } from "../src/config.js";
import { captured, copyOf, example } from "./helpers.js";

describe("init", () => {
  it("writes a file that is a valid definition, named after the document", async () => {
    const dir = copyOf("in-your-repository");
    const config = join(dir, "fresh.yaml");
    const { out } = await captured(() =>
      init({ config, location: join(dir, "openapi.json"), force: false }),
    );
    expect(out).toContain("8 operations");

    const { definition } = loadConfig(config);
    expect(definition.project).toBe("bookshop");
    expect(definition.sources).toEqual([{ file: "./openapi.json" }]);
    // One variant that serves nothing yet, and the tags to choose from as a comment.
    expect(definition.variants).toEqual({ public: { include: {} } });
    const text = readFileSync(config, "utf8");
    expect(text).toContain("# yaml-language-server: $schema=");
    expect(text).toContain("# Tags in this document: Books (3), Orders (3), Admin (3)");
    expect(await validate({ config, sources: [] })).toBe(0);
  });

  it("says so when the document is at an address on this machine", async () => {
    const dir = copyOf("in-your-repository");
    const document = readFileSync(join(dir, "openapi.json"), "utf8");
    const devServer = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(document);
    });
    await new Promise<void>((resolve) => devServer.listen(0, "127.0.0.1", resolve));
    const address = `http://127.0.0.1:${(devServer.address() as AddressInfo).port}/openapi.json`;
    try {
      const config = join(dir, "from-dev-server.yaml");
      const { err } = await captured(() => init({ config, location: address, force: false }));
      // A pipeline cannot read a dev server. The file and the command both say what to do about it.
      expect(err).toContain(`${address} is on this machine`);
      expect(err).toContain(`openapi-proxy dev --source ${address}`);
      const text = readFileSync(config, "utf8");
      expect(text).toContain(`  - url: ${address}`);
      expect(text).toContain(
        "# This address is on your machine, so a deploy from a pipeline cannot read",
      );
      expect(text).not.toContain("# follow: true");
      expect(loadConfig(config).definition.sources).toEqual([{ url: address }]);
    } finally {
      devServer.close();
    }
  });

  it("does not write over a file unless told to", async () => {
    const dir = copyOf("in-your-repository");
    const config = join(dir, "openapi-proxy.yaml");
    const before = readFileSync(config, "utf8");
    const location = join(dir, "openapi.json");
    await expect(init({ config, location, force: false })).rejects.toThrow("exists already");
    expect(readFileSync(config, "utf8")).toBe(before);
    await captured(() => init({ config, location, force: true }));
    expect(readFileSync(config, "utf8")).not.toBe(before);
  });

  it("says so when there is no document to read", async () => {
    const dir = copyOf("in-your-repository");
    await expect(
      init({ config: join(dir, "x.yaml"), location: join(dir, "missing.json"), force: false }),
    ).rejects.toThrow("could not be read");
    expect(existsSync(join(dir, "x.yaml"))).toBe(false);
  });
});

describe("validate", () => {
  it("passes every example", async () => {
    for (const [name, sources] of [
      ["several-audiences", []],
      ["in-your-repository", []],
      // Its source is an address; the document beside it stands in.
      ["from-a-url", [example("from-a-url", "openapi.json")]],
    ] as const) {
      const config = example(name, "openapi-proxy.yaml");
      const { result, out, err } = await captured(() =>
        validate({ config, sources: [...sources] }),
      );
      expect(result, name).toBe(0);
      expect(out).toContain("is a valid definition");
      expect(err, name).toBe("");
    }
  });

  it("fails on a file that is not a definition, with a line an editor can jump to", async () => {
    const dir = copyOf("in-your-repository");
    const config = join(dir, "openapi-proxy.yaml");
    writeFileSync(
      config,
      readFileSync(config, "utf8").replace("visibility: public", "visibility: open"),
    );
    const { result, err } = await captured(() => validate({ config, sources: [] }));
    expect(result).toBe(1);
    expect(err).toContain(
      `${config}:15  variants.public.visibility "open" is not one of the choices.`,
    );
    expect(err).toContain("Allowed: public, private.");
  });

  it("only warns about names the document does not have", async () => {
    const dir = copyOf("in-your-repository");
    const config = join(dir, "openapi-proxy.yaml");
    writeFileSync(
      config,
      readFileSync(config, "utf8").replace(
        "tags: [Books, Orders]",
        "tags: [Books, Orders, Reviews]",
      ),
    );
    const { result, out, err } = await captured(() => validate({ config, sources: [] }));
    expect(result).toBe(0);
    expect(err).toContain('variants.public.include.tags names "Reviews"');
    expect(err).toContain("That is fine if the API does not have it yet.");
    expect(out).toContain("public: serves 5 of 8 operations, 1 name not found");
  });

  it("still checks the file when a source cannot be read, and says the names were not checked", async () => {
    const config = example("from-a-url", "openapi-proxy.yaml");
    const { result, out, err } = await captured(() =>
      validate({ config, sources: ["./missing.json"] }),
    );
    expect(result).toBe(0);
    expect(out).toContain("is a valid definition");
    expect(err).toContain("The names in the file were not checked against it.");
  });
});

describe("operations", () => {
  const config = example("several-audiences", "openapi-proxy.yaml");
  const run = (options: Partial<Parameters<typeof operations>[0]>) =>
    captured(() =>
      operations({
        config,
        sources: [],
        tag: undefined,
        variant: undefined,
        json: false,
        ...options,
      }),
    );

  it("lists every operation with its tags, and the tags with their counts", async () => {
    const { out, err } = await run({});
    expect(out.trim().split("\n")).toHaveLength(6);
    expect(out).toContain("POST /billing/invoices/{id}/refund  Invoices");
    expect(err).toContain("Tags: Books (2), Orders (1), Admin (1), Invoices (2)");
  });

  it("narrows to a tag, and says what a variant serves", async () => {
    const { out, err } = await run({ tag: "Invoices", variant: "docs" });
    expect(out.trim().split("\n")).toEqual([
      expect.stringMatching(/^served\s+GET \/billing\/invoices\s/),
      expect.stringMatching(/^hidden\s+POST \/billing\/invoices\/\{id\}\/refund\s/),
    ]);
    expect(err).toContain("2 operations tagged Invoices, 1 served by docs.");
  });

  it("gives the same as JSON, with the document each operation came from", async () => {
    const { out } = await run({ json: true, variant: "partner" });
    const listing = JSON.parse(out) as {
      tags: Array<{ name: string; count: number }>;
      operations: Array<{ operation: string; source: string; served: boolean }>;
    };
    expect(listing.tags.map((tag) => tag.name)).toEqual(["Books", "Orders", "Admin", "Invoices"]);
    expect(listing.operations.find((entry) => entry.operation === "GET /books")).toMatchObject({
      source: "core",
      served: true,
    });
    expect(
      listing.operations.find((entry) => entry.operation === "GET /billing/invoices"),
    ).toMatchObject({ source: "billing", served: false });
  });

  it("names the variants there are when asked about one there is not", async () => {
    await expect(run({ variant: "nope" })).rejects.toThrow("It has docs, sdk, partner, internal.");
  });
});
