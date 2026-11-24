import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { canonicalJson, effectiveVariant, ORIGINAL_VARIANT } from "@openapi-proxy/core";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/server/codec";
import { rows, sql } from "./harness";

const count = async (table: string) =>
  (await rows<{ n: number }>(`SELECT count(*) AS n FROM ${table}`))[0]?.n;
const columns = async (table: string) =>
  (await rows<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`)).map(
    (column) => column.name,
  );

describe("the migrations", () => {
  it("are these, in this order", () => {
    expect(env.TEST_MIGRATIONS.map((migration) => migration.name)).toEqual([
      "0000_init.sql",
      "0001_definitions.sql",
      "0002_original_variant.sql",
    ]);
  });
});

describe("the migration to definitions", () => {
  it("keeps accounts and workspaces, and starts project data over in the new shape", async () => {
    // A database as the first migration left it, with someone's data in it.
    await reset();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.slice(0, 1));
    const now = Date.now();
    await sql("INSERT INTO user (id, name, email) VALUES ('usr_1', 'Ada', 'ada@example.com')");
    await sql(
      "INSERT INTO organization (id, name, slug, created_at) VALUES ('org_1', 'Ada''s', 'adas', ?)",
      now,
    );
    await sql(
      "INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES ('mem_1', 'org_1', 'usr_1', 'owner', ?)",
      now,
    );
    await sql(
      `INSERT INTO projects (id, organization_id, name, slug, spec_version, body_hash, body_bytes, op_index, fetched_at, created_at)
       VALUES ('prj_1', 'org_1', 'Books', 'books', '3.1', 'h', 1, '[]', ?, ?)`,
      now,
      now,
    );
    await sql(
      `INSERT INTO variants (id, project_id, name, slug, selection, ops_snapshot, created_at, updated_at)
       VALUES ('var_1', 'prj_1', 'Public', 'public', '{"mode":"include","operations":[],"tags":[]}', '[]', ?, ?)`,
      now,
      now,
    );
    await sql(
      `INSERT INTO api_keys (id, organization_id, user_id, name, key_hash, prefix, variant_id, created_at)
       VALUES ('key_1', 'org_1', 'usr_1', 'Partner', 'hash', 'oap_1234', 'var_1', ?)`,
      now,
    );

    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

    expect(await count("user")).toBe(1);
    expect(await count("organization")).toBe(1);
    expect(await count("member")).toBe(1);
    for (const table of ["projects", "sources", "variants", "variant_outputs", "api_keys"]) {
      expect(await count(table), table).toBe(0);
    }
    expect(await columns("projects")).toContain("next_check_at");
    expect(await columns("variants")).not.toContain("ops_snapshot");
    expect(await columns("sources")).not.toContain("version_url");
  });
});

describe("the migration that gives every project its original", () => {
  it("adds it to each project once, as an apply would have", async () => {
    await reset();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.slice(0, 2));
    const now = Date.now();
    await sql(
      "INSERT INTO organization (id, name, slug, created_at) VALUES ('org_1', 'Ada''s', 'adas', ?)",
      now,
    );
    for (const id of ["prj_1", "prj_2"]) {
      await sql(
        `INSERT INTO projects (id, organization_id, slug, spec_version, body_hash, body_bytes, op_index, created_at)
         VALUES (?, 'org_1', ?, '3.1', 'h', 1, '[]', ?)`,
        id,
        id.replace("_", "-"),
        now,
      );
    }
    await sql(
      `INSERT INTO variants (id, project_id, slug, position, selection, served_hash, created_at, updated_at)
       VALUES ('var_1', 'prj_1', 'public', 0, '{"include":{"tags":["Pets"]}}', 'x', ?, ?)`,
      now,
      now,
    );
    // Someone's own variant with the name that is now every project's.
    await sql(
      `INSERT INTO variants (id, project_id, slug, position, selection, served_hash, created_at, updated_at)
       VALUES ('var_2', 'prj_2', 'original', 0, '{"exclude":{"tags":["Admin"]}}', 'y', ?, ?)`,
      now,
      now,
    );

    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    // Applying again changes nothing: the migration is recorded, and its insert skips what has one.
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

    const originals = await rows<{
      project_id: string;
      selection: string;
      overrides: string | null;
      visibility: string | null;
      served_hash: string;
    }>(
      `SELECT project_id, selection, overrides, visibility, served_hash FROM variants WHERE slug = 'original' ORDER BY project_id`,
    );
    expect(originals.map((row) => row.project_id)).toEqual(["prj_1", "prj_2"]);
    const definition = {
      version: 1 as const,
      project: "prj-1",
      sources: [{ url: "https://example.com/openapi.json" }],
      variants: {},
    };
    const servedHash = await sha256Hex(
      canonicalJson(effectiveVariant(definition, ORIGINAL_VARIANT)),
    );
    for (const row of originals) {
      expect(JSON.parse(row.selection)).toEqual({});
      expect(row.overrides).toBeNull();
      expect(row.visibility).toBeNull();
      expect(row.served_hash).toBe(servedHash);
    }
    expect(await count("variants")).toBe(4);
    // It keeps its id (and so its keys) and what it serves, under another slug.
    expect(
      await rows<{ slug: string; selection: string }>(
        "SELECT slug, selection FROM variants WHERE id = 'var_2'",
      ),
    ).toEqual([{ slug: "original-1", selection: '{"exclude":{"tags":["Admin"]}}' }]);
  });
});
