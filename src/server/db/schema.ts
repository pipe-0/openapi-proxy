import type {
  DocumentOverrides,
  MergeNote,
  OperationEntry,
  Selection,
  TargetVersion,
} from "@openapi-proxy/core";
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { KeyAccess, Visibility } from "../../shared/access";
import type { Plan } from "../../shared/plans";
import type { VariantIconName } from "../../shared/variant-icons";
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

  // What assembling the sources last produced.
  /** OpenAPI version of the assembled document, e.g. "3.1". */
  specVersion: text("spec_version").notNull(),
  /** Changes exactly when the assembled document does. */
  bodyHash: text("body_hash").notNull(),
  /** Size of the sources together. */
  bodyBytes: integer("body_bytes").notNull(),
  opIndex: text("op_index", { mode: "json" }).$type<OperationEntry[]>().notNull(),
  notes: text("notes", { mode: "json" }).$type<ProjectNote[]>().notNull().default([]),

  /** Last round of checks in which every source answered. The next is due an interval later (schedule.ts). */
  fetchedAt: integer("fetched_at").notNull(),
  /** Set while a check is in flight, and left in place after a failure as a backoff. */
  checkClaimedAt: integer("check_claimed_at"),
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
    /** Title, description and servers this variant states instead of the document's. Null: none. */
    overrides: text("overrides", { mode: "json" }).$type<DocumentOverrides>(),
    /** The icon it has in the navigation (src/shared/variant-icons.ts). Null: the plain one. */
    icon: text("icon").$type<VariantIconName>(),
    /** Who may read it at its URL: anyone, or only an API key of its workspace. */
    visibility: text("visibility").$type<Visibility>().notNull().default("public"),
    /** Incremented whenever what is served can change; part of the served ETag. */
    revision: integer("revision").notNull().default(1),
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
 * What rendering a variant in one format came to, kept while its `etag`
 * matches: the document (gzip, base64), or the reason there is none.
 * Rendering a large spec (YAML especially) costs real CPU, so it happens once
 * per change, not once per request. That holds for a document that cannot be
 * served as well: why not is a property of the document and the selection,
 * which is what the ETag stands for.
 */
export const variantOutputs = sqliteTable(
  "variant_outputs",
  {
    variantId: text("variant_id")
      .notNull()
      .references(() => variants.id, { onDelete: "cascade" }),
    format: text("format").$type<"json" | "yaml">().notNull(),
    /** The OpenAPI version it was converted to, or "own" for the document's own. */
    version: text("version").$type<TargetVersion | "own">().notNull().default("own"),
    etag: text("etag").notNull(),
    body: text("body").notNull(),
    /** Why this cannot be served, if it cannot. The body is empty then. */
    error: text("error"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.variantId, table.format, table.version] })],
);

export const loginThrottle = sqliteTable("login_throttle", {
  id: integer("id").primaryKey(),
  failures: integer("failures").notNull().default(0),
  lastFailureAt: integer("last_failure_at").notNull().default(0),
});

/**
 * Which changes to a project's documents a person is emailed about: "off",
 * "served" (what their variants serve) or "all". Per project, because whether
 * an API's changes matter to someone depends on the API. No row means "served".
 */
export const projectNotifications = sqliteTable(
  "project_notifications",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    scope: text("scope").$type<"off" | "served" | "all">().notNull(),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.userId] })],
);

/** The states a subscription goes through. Stripe's, so that Stripe can write them one day. */
export type SubscriptionStatus =
  | "incomplete"
  | "incomplete_expired"
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "paused";

/**
 * What a workspace pays for. A workspace is on the plan of its subscription
 * while that is in force (see src/server/plans.ts), and on Free otherwise:
 * there is no plan field anywhere else.
 *
 * A workspace has at most one, and the row says what state it is in. The
 * shape is Stripe's subscription object, under the names better-auth's Stripe
 * plugin gives its `subscription` table, so that a webhook can keep these rows
 * one day without the data moving. Until then people do what Stripe would: an
 * upgrade that was asked for is a row that is `incomplete`, and whoever takes
 * the payment makes it `active` (the two statements are in src/server/plans.ts).
 */
export const subscriptions = sqliteTable(
  "subscription",
  {
    // The id and the two dates fill themselves in, so that the statement a
    // person writes by hand names only what it is about.
    id: text("id").primaryKey().default(sql`('sub_' || lower(hex(randomblob(12))))`),
    /** The workspace it belongs to. */
    referenceId: text("reference_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    plan: text("plan").$type<Plan>().notNull(),
    status: text("status").$type<SubscriptionStatus>().notNull().default("incomplete"),
    /** The period that is paid for. It renews at `periodEnd`, or ends there. No end: until it is removed. */
    periodStart: integer("period_start"),
    periodEnd: integer("period_end"),
    /** Set when its owner asked to cancel: it is not renewed at `periodEnd`. */
    cancelAtPeriodEnd: integer("cancel_at_period_end", { mode: "boolean" })
      .notNull()
      .default(false),
    /** When that was asked. */
    canceledAt: integer("canceled_at"),
    /** When it stopped for good. */
    endedAt: integer("ended_at"),
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  // One per workspace: giving a plan, asking for one and removing it all address the same row.
  (table) => [uniqueIndex("subscription_reference").on(table.referenceId)],
);

/**
 * API keys, for scripts, agents and the readers of private variants, sent as
 * `Authorization: Bearer <key>`. A key acts as the person who made it, in
 * their workspace, for as long as they are in it. Only its SHA-256 is stored;
 * the key itself is shown once, when it is created.
 */
export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Hex SHA-256 of the whole key. */
    keyHash: text("key_hash").notNull().unique(),
    /** The first characters, to tell keys apart in a list. */
    prefix: text("prefix").notNull(),
    /** What it may do (src/shared/access.ts): everything a key can, or only read private variants. */
    access: text("access").$type<KeyAccess>().notNull().default("full"),
    /**
     * For a key that only reads: the one variant it reads, or null for every
     * private variant of the workspace. The key goes when the variant does,
     * so that it never comes to read more than it was made for.
     */
    variantId: text("variant_id").references(() => variants.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
    lastUsedAt: integer("last_used_at"),
  },
  (table) => [
    index("api_keys_organization").on(table.organizationId),
    // Deleting a variant takes its keys with it.
    index("api_keys_variant").on(table.variantId),
  ],
);

export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type SubscriptionRow = typeof subscriptions.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;
export type SourceRow = typeof sources.$inferSelect;
export type VariantRow = typeof variants.$inferSelect;
