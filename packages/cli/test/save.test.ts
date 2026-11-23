import { readFileSync } from "node:fs";
import { type ProjectDefinition, readDefinition } from "@openapi-proxy/core";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { patchDefinition } from "../src/save.js";
import { example } from "./helpers.js";

/** The definition a text holds, as the tool reads it. */
function definitionOf(text: string): ProjectDefinition {
  const read = readDefinition(parse(text));
  if ("problems" in read) throw new Error(JSON.stringify(read.problems));
  return read.definition;
}

/** Save a change into a text, and check that what was saved reads back as what was meant. */
function save(text: string, change: (definition: ProjectDefinition) => ProjectDefinition): string {
  const before = definitionOf(text);
  const after = change(structuredClone(before));
  const saved = patchDefinition(text, before, after);
  // Whatever it looks like, it has to say exactly what was asked for.
  expect(definitionOf(saved)).toEqual(definitionOf(JSON.stringify(after)));
  return saved;
}

/** The lines of `after` that are not in `before`, and the other way round. */
function diff(before: string, after: string) {
  const a = before.split("\n");
  const b = after.split("\n");
  return {
    removed: a.filter((line) => !b.includes(line)),
    added: b.filter((line) => !a.includes(line)),
  };
}

const FILE = `# yaml-language-server: $schema=https://openapi-proxy.app/schema/definition.v1.json
#
# What the outside world sees of the bookshop.
version: 1
project: bookshop   # the first part of every URL

sources:
  - file: ./openapi.json

variants:
  # For the docs site.
  public:
    name: Public docs
    visibility: public
    include:
      tags: [Books, Orders]   # everything a customer does
    exclude:
      operations:
        - GET /orders/export   # staff only
        - DELETE /books/{id}
    overrides:
      title: "Bookshop: the public API"
      servers:
        - url: https://api.bookshop.example

  # For the people at the till.
  staff:
    icon: lock
    visibility: private
`;

describe("saving a definition into its file", () => {
  it("writes nothing when nothing changed", () => {
    for (const name of ["from-a-url", "several-audiences", "in-your-repository"]) {
      const text = readFileSync(example(name, "openapi-proxy.yaml"), "utf8");
      expect(patchDefinition(text, definitionOf(text), definitionOf(text))).toBe(text);
    }
    expect(save(FILE, (definition) => definition)).toBe(FILE);
  });

  it("changes a list item by item, and leaves every other line as it was written", () => {
    const saved = save(FILE, (definition) => {
      const entry = definition.variants.public;
      if (entry) {
        entry.include = { tags: ["Books", "Gifts", "Orders"] };
        entry.exclude = { operations: ["DELETE /books/{id}", "POST /orders/{id}/refund"] };
      }
      return definition;
    });
    expect(diff(FILE, saved)).toEqual({
      removed: [
        "      tags: [Books, Orders]   # everything a customer does",
        "        - GET /orders/export   # staff only",
      ],
      added: [
        "      tags: [Books, Orders, Gifts] # everything a customer does",
        "        - POST /orders/{id}/refund",
      ],
    });
  });

  it("changes a value where it stands: its quotes and its comment stay", () => {
    const saved = save(FILE, (definition) => {
      const entry = definition.variants.public;
      if (entry) {
        entry.name = "Docs for customers";
        entry.visibility = "private";
        entry.overrides = { ...entry.overrides, title: "Bookshop" };
      }
      return { ...definition, name: "The bookshop" };
    });
    // A key that is new goes where it would be looked for: the name after the slug.
    expect(saved).toContain(
      "project: bookshop   # the first part of every URL\nname: The bookshop\n",
    );
    // (`visibility: private` is a line the file already had, for the other variant.)
    expect(saved).toContain("    name: Docs for customers\n    visibility: private\n");
    expect(diff(FILE, saved)).toEqual({
      removed: [
        "    name: Public docs",
        "    visibility: public",
        '      title: "Bookshop: the public API"',
      ],
      added: ["name: The bookshop", "    name: Docs for customers", '      title: "Bookshop"'],
    });
  });

  it("adds a variant at the end, written the way a person would", () => {
    const saved = save(FILE, (definition) => ({
      ...definition,
      variants: {
        ...definition.variants,
        partners: {
          name: "Partners",
          include: { tags: ["Orders"], operations: ["GET /books/{id}"] },
        },
      },
    }));
    expect(
      saved.endsWith(`  partners:
    name: Partners
    include:
      tags: [Orders]
      operations:
        - GET /books/{id}
`),
    ).toBe(true);
    expect(diff(FILE, saved)).toEqual({
      removed: [],
      added: [
        "  partners:",
        "    name: Partners",
        "      tags: [Orders]",
        "        - GET /books/{id}",
      ],
    });
    // The comments above the variants that were there are still above them.
    expect(saved).toContain("  # For the docs site.\n  public:");
    expect(saved).toContain("  # For the people at the till.\n  staff:");
  });

  it("takes a variant out with the comment that was about it, and keeps the others", () => {
    const saved = save(FILE, ({ variants: { staff: _, ...rest }, ...definition }) => ({
      ...definition,
      variants: rest,
    }));
    expect(saved).not.toContain("staff:");
    expect(saved).not.toContain("For the people at the till.");
    expect(saved).toContain("  # For the docs site.\n  public:");
    expect(saved).toContain("        - GET /orders/export   # staff only");
  });

  it("renames a variant in place", () => {
    const saved = save(FILE, ({ variants: { public: entry, ...rest }, ...definition }) => ({
      ...definition,
      variants: { docs: entry ?? {}, ...rest },
    }));
    expect(diff(FILE, saved)).toEqual({ removed: ["  public:"], added: ["  docs:"] });
  });

  it("puts a new key of a variant where a person would", () => {
    const saved = save(FILE, (definition) => ({
      ...definition,
      variants: {
        ...definition.variants,
        staff: { ...definition.variants.staff, name: "Staff", exclude: { tags: ["Admin"] } },
      },
    }));
    expect(saved).toContain(`  staff:
    name: Staff
    icon: lock
    visibility: private
    exclude:
      tags: [Admin]
`);
  });

  it("removes a key that no longer says anything", () => {
    const saved = save(FILE, (definition) => {
      const { exclude: _, overrides: __, ...entry } = definition.variants.public ?? {};
      return { ...definition, variants: { ...definition.variants, public: entry } };
    });
    expect(saved).not.toContain("exclude");
    expect(saved).not.toContain("overrides");
    expect(saved).toContain("      tags: [Books, Orders]   # everything a customer does");
  });

  it("keeps the indentation the file has", () => {
    const wide = `version: 1
project: wide
sources:
    - file: ./openapi.json
variants:
    public:
        include:
            operations:
                - GET /pets
`;
    const saved = save(wide, (definition) => ({
      ...definition,
      variants: { ...definition.variants, internal: { name: "Internal" } },
    }));
    expect(saved).toBe(`${wide}    internal:\n        name: Internal\n`);

    const flush = `version: 1
project: flush
sources:
- file: ./openapi.json
variants:
  public:
    exclude:
      operations:
      - GET /pets
`;
    const more = save(flush, (definition) => ({
      ...definition,
      variants: { public: { exclude: { operations: ["GET /pets", "POST /pets"] } } },
    }));
    expect(more).toBe(`${flush}      - POST /pets\n`);
  });

  it("changes one line of a file whose first source has several keys", () => {
    // The shape `init` writes for a URL, and the from-a-url example: the first
    // indented line that is not a list item is four columns in.
    const text = readFileSync(example("from-a-url", "openapi-proxy.yaml"), "utf8");
    const saved = save(text, (definition) => {
      const entry = definition.variants.public;
      if (entry) entry.include = { tags: ["Books", "Gifts", "Orders"] };
      return definition;
    });
    expect(diff(text, saved)).toEqual({
      removed: ["      tags: [Books, Orders]"],
      added: ["      tags: [Books, Orders, Gifts]"],
    });
  });

  it("adds and removes a server without losing what is written about the others", () => {
    const text = `version: 1
project: servers
sources:
  - file: ./openapi.json
variants:
  public:
    overrides:
      servers:
        # Where customers go.
        - url: https://api.example.com   # production
          description: Production
        # For trying things out.
        - url: https://sandbox.example.com
`;
    const servers = (definition: ProjectDefinition) =>
      definition.variants.public?.overrides?.servers ?? [];
    const withServers = (definition: ProjectDefinition, next: Array<{ url: string }>) => ({
      ...definition,
      variants: { public: { overrides: { servers: next } } },
    });

    const added = save(text, (definition) =>
      withServers(definition, [...servers(definition), { url: "https://staging.example.com" }]),
    );
    expect(diff(text, added)).toEqual({
      removed: [],
      added: ["        - url: https://staging.example.com"],
    });

    const removed = save(text, (definition) =>
      withServers(definition, servers(definition).slice(0, 1)),
    );
    expect(diff(text, removed)).toEqual({
      removed: ["        # For trying things out.", "        - url: https://sandbox.example.com"],
      added: [],
    });

    // Put first, the new one is first, and the comments stay with their servers.
    const first = save(text, (definition) =>
      withServers(definition, [{ url: "https://staging.example.com" }, ...servers(definition)]),
    );
    expect(first).toContain(`      servers:
        - url: https://staging.example.com
        # Where customers go.
        - url: https://api.example.com   # production
          description: Production
        # For trying things out.
        - url: https://sandbox.example.com
`);

    // An address that changes is still the entry it was.
    const moved = save(text, (definition) =>
      withServers(definition, [
        { url: "https://api.example.org", description: "Production" } as { url: string },
        ...servers(definition).slice(1),
      ]),
    );
    expect(diff(text, moved)).toEqual({
      removed: ["        - url: https://api.example.com   # production"],
      added: ["        - url: https://api.example.org # production"],
    });
  });

  it("keeps a comment after a key, aligned values, and the line ends of the file", () => {
    const text = `version: 1
project:    aligned     # the slug
sources:                # one document
  - file: ./openapi.json
variants:   # by slug
  public:
    name:       "Public"
    visibility: public
`;
    const change = (definition: ProjectDefinition): ProjectDefinition => ({
      ...definition,
      variants: { ...definition.variants, internal: { visibility: "private" } },
    });
    const saved = save(text, change);
    expect(saved).toBe(`${text}  internal:\n    visibility: private\n`);

    const windows = text.replaceAll("\n", "\r\n");
    expect(save(windows, change)).toBe(`${windows}  internal:\r\n    visibility: private\r\n`);
  });

  it("treats a variant's slug as a name like any other", () => {
    const text = `version: 1
project: names
sources:
  - file: ./openapi.json
variants:
  constructor:
    name: Builders
  public: {}
`;
    const without = save(text, ({ variants: { public: entry }, ...definition }) => ({
      ...definition,
      variants: { public: entry ?? {} },
    }));
    expect(without).not.toContain("constructor");
    const renamed = save(text, ({ variants, ...definition }) => ({
      ...definition,
      variants: { builders: { name: "Builders" }, public: variants.public ?? {} },
    }));
    expect(diff(text, renamed)).toEqual({ removed: ["  constructor:"], added: ["  builders:"] });
  });

  it("writes a first variant into a file that had none", () => {
    const bare =
      "version: 1\nproject: bare\nsources:\n  - url: https://api.example.com/openapi.json\n";
    const saved = save(bare, (definition) => ({
      ...definition,
      variants: { public: { include: {} } },
    }));
    expect(saved).toBe(`${bare}variants:\n  public:\n    include: {}\n`);
  });
});
