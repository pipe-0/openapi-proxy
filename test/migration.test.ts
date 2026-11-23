import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { rows, sql } from "./harness";

const count = async (table: string) =>
  (await rows<{ n: number }>(`SELECT count(*) AS n FROM ${table}`))[0]?.n;
const columns = async (table: string) =>
  (await rows<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`)).map(
    (column) => column.name,
  );

describe("the migration to definitions", () => {
  it("is the only one after the first", () => {
    expect(env.TEST_MIGRATIONS.map((migration) => migration.name)).toEqual([
      "0000_init.sql",
      "0001_definitions.sql",
    ]);
  });

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
