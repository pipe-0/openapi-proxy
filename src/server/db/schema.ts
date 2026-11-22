import type { MergeNote, OperationEntry, Selection, TargetVersion } from "@openapi-proxy/core";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { organization, user } from "./auth-schema";

/**
 * The data model is organization → project → sources and variants.
 *
 * Users, sessions and organizations belong to better-auth (see
 * auth-schema.ts). Everyone who signs in gets an organization, every project
 * belongs to one, and every query on the tables below filters by it.
 */
export * from "./auth-schema";

/** A request header sent when fetching a source. Values are encrypted at rest. */
export interface StoredHeader {
  name: string;
  value: string;
}

/**
 * Something that assembling a project's document did and its owner should
 * know: an operation two sources both define, a component that had to be
 * renamed, a source that was converted to another OpenAPI version.
 */
export type ProjectNote =
  | MergeNote
  | { kind: "source-converted"; source: string; from: string; to: string };

/**
 * One API as its readers know it. Its document is assembled from one or more
 * sources; what is stored here is what is true of that whole: its operations,
 * the hash that every served ETag derives from, and the state of keeping it
 * current.
 */
export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  /**
   * First segment of the public URL: /v/<project>/<variant>. Unique across
   * the whole deployment, so a public URL never needs to name an organization.
   */
  slug: text("slug").notNull().unique(),
  ttlSeconds: integer("ttl_seconds").notNull().default(300),

  // What assembling the sources last produced.
  /** OpenAPI version of the assembled document, e.g. "3.1". */
  specVersion: text("spec_version").notNull(),
  /** Changes exactly when the assembled document does. */
  bodyHash: text("body_hash").notNull(),
  /** Size of the sources together. */
  bodyBytes: integer("body_bytes").notNull(),
  opIndex: text("op_index", { mode: "json" }).$type<OperationEntry[]>().notNull(),
  notes: text("notes", { mode: "json" }).$type<ProjectNote[]>().notNull().default([]),

  /** Last round of checks in which every source answered. Drives the interval. */
  fetchedAt: integer("fetched_at").notNull(),
  /** Set while a check is in flight, and left in place after a failure as a backoff. */
  refreshClaimedAt: integer("refresh_claimed_at"),
  lastStatus: text("last_status").$type<"ok" | "error">().notNull().default("ok"),
  lastError: text("last_error"),
  createdAt: integer("created_at").notNull(),
});

/**
 * Project slugs that were given up, by renaming a project or deleting it.
 * For a while, only the workspace that had one can take it again. Without
 * this, anyone could claim the slug the moment it is free and put a document
 * of their own behind an address that someone's build still fetches.
 */
export const releasedSlugs = sqliteTable("released_slugs", {
  slug: text("slug").primaryKey(),
  /** Not a foreign key: the hold outlasts the workspace. */
  organizationId: text("organization_id").notNull(),
  releasedAt: integer("released_at").notNull(),
});

/**
 * One OpenAPI document, fetched from a URL: where it is, how to fetch it, and
 * the last good copy of it. A project has at least one. Their order matters:
 * the first is the main document, and where two define the same thing, the
 * earlier one wins.
 */
export const sources = sqliteTable(
  "sources",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    /** What people call it. Also names components that had to be renamed. */
    name: text("name").notNull(),
    url: text("url").notNull(),
    headers: text("headers", { mode: "json" }).$type<StoredHeader[]>().notNull().default([]),
    /** Put in front of every path of this document, e.g. "/billing". */
    pathPrefix: text("path_prefix"),

    /**
     * Optional lightweight endpoint that reports which build is live. While it
     * reports the version we last saw, a check skips the download.
     */
    versionUrl: text("version_url"),
    lastKnownVersion: text("last_known_version"),
    /**
     * When the version endpoint was caught reporting one version for two
     * different documents. From then on it is not used to skip downloads,
     * until someone saves the endpoint again.
     */
    versionMismatchAt: integer("version_mismatch_at"),

    // What the last successful fetch found.
    apiVersion: text("api_version"),
    specVersion: text("spec_version").notNull(),
    upstreamEtag: text("upstream_etag"),
    upstreamLastModified: text("upstream_last_modified"),
    bodyHash: text("body_hash").notNull(),
    bodyBytes: integer("body_bytes").notNull(),
    /** The document, gzip-compressed and base64-encoded. */
    body: text("body").notNull(),
    /** How many operations it defines. */
    operations: integer("operations").notNull(),

    /** Last time the document itself was compared with the source (not just its version). */
    verifiedAt: integer("verified_at").notNull(),
    lastStatus: text("last_status").$type<"ok" | "error">().notNull().default("ok"),
    lastError: text("last_error"),
  },
  (table) => [
    uniqueIndex("sources_project_url").on(table.projectId, table.url),
    index("sources_project").on(table.projectId),
  ],
);

export const variants = sqliteTable(
  "variants",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    selection: text("selection", { mode: "json" }).$type<Selection>().notNull(),
    /** The OpenAPI version to serve ("3.0" or "3.1"). Null serves the project's own. */
    outputVersion: text("output_version").$type<TargetVersion>(),
    /** Incremented whenever what is served can change; part of the served ETag. */
    selectionVersion: integer("selection_version").notNull().default(1),
    /** Operation keys that existed when the selection was last reviewed. */
    opsSnapshot: text("ops_snapshot", { mode: "json" }).$type<string[]>().notNull(),
    acknowledgedMissingOps: text("acknowledged_missing_ops", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default([]),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [uniqueIndex("variants_project_slug").on(table.projectId, table.slug)],
);

/**
 * The rendered document for a variant, per format: gzip, base64. Rendering a
 * large spec (YAML especially) costs real CPU, so it happens once per change
 * rather than once per request. A row is current while its `etag` matches.
 */
export const variantOutputs = sqliteTable(
  "variant_outputs",
  {
    variantId: text("variant_id")
      .notNull()
      .references(() => variants.id, { onDelete: "cascade" }),
    format: text("format").$type<"json" | "yaml">().notNull(),
    etag: text("etag").notNull(),
    body: text("body").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.variantId, table.format] })],
);

export const loginThrottle = sqliteTable("login_throttle", {
  id: integer("id").primaryKey(),
  failures: integer("failures").notNull().default(0),
  lastFailureAt: integer("last_failure_at").notNull().default(0),
});

/**
 * Tokens for scripts and agents: the management API and the MCP endpoint
 * accept one as `Authorization: Bearer <token>`. A token acts as the person
 * who made it, in their workspace, for as long as they are in it. Only its
 * SHA-256 is stored; the token itself is shown once, when it is created.
 */
export const apiTokens = sqliteTable(
  "api_tokens",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Hex SHA-256 of the whole token. */
    tokenHash: text("token_hash").notNull().unique(),
    /** The first characters, to tell tokens apart in a list. */
    prefix: text("prefix").notNull(),
    createdAt: integer("created_at").notNull(),
    lastUsedAt: integer("last_used_at"),
  },
  (table) => [index("api_tokens_organization").on(table.organizationId)],
);

export type ApiTokenRow = typeof apiTokens.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;
export type SourceRow = typeof sources.$inferSelect;
export type VariantRow = typeof variants.$inferSelect;
