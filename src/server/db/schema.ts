import type {
  AppliedRecord,
  DocumentOverrides,
  OperationEntry,
  ProjectNote,
  Selection,
  TargetVersion,
  VariantIconName,
  Visibility,
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
import type { KeyAccess } from "../../shared/access";
import type { Plan } from "../../shared/plans";
import { organization, user } from "./auth-schema";

/**
 * The data model is organization → project → sources and variants.
 *
 * Users, sessions and organizations belong to better-auth (see
 * auth-schema.ts). Everyone who signs in gets an organization, every project
 * belongs to one, and every query on the tables below filters by it.
 *
 * A project is described by a definition (the format of an
 * `openapi-proxy.yaml`, see packages/core/src/definition). These tables are
 * that definition stored, next to what the service has found out about it:
 * the documents, their operations, the state of checks. The definition is
 * read back from the rows by definition-rows.ts, and written to them by
 * apply.ts, which is the only thing that does.
 */
export * from "./auth-schema";

/** A request header sent when fetching a source. Values are encrypted at rest. */
export interface StoredHeader {
  name: string;
  value: string;
}

/**
 * One API as its readers know it. Its document is assembled from one or more
 * sources; what is stored here is what is true of that whole: its operations,
 * the hash that every served ETag derives from, and the state of keeping it
 * current.
 */
export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /**
     * First segment of the public URL: /v/<project>/<variant>, and the
     * project's identity in a definition. Unique across the whole deployment,
     * so a public URL never needs to name an organization.
     */
    slug: text("slug").notNull().unique(),

    // The definition's own keys.
    /** What it is called. Null: by its slug. */
    name: text("name"),
    /** Who may read its variants unless they say otherwise. Null: the workspace's default. */
    visibility: text("visibility").$type<Visibility>(),
    /** Title, description and servers for every variant that does not state its own. */
    overrides: text("overrides", { mode: "json" }).$type<DocumentOverrides>(),

    /**
     * Where the definition is edited: in the app, or in a file that is
     * deployed. A project that a file was deployed to is not edited in the
     * app until someone says so there.
     */
    managedBy: text("managed_by").$type<"app" | "file">().notNull().default("app"),
    applied: text("applied", { mode: "json" }).$type<AppliedRecord>(),
    /**
     * Counts the definitions applied to the project. A save in the app says
     * which revision it started from, and is refused if the project has moved
     * on. (Its documents can change without it: `bodyHash` says so.)
     */
    revision: integer("revision").notNull().default(0),
    /**
     * A value an apply makes up for itself and writes with the first statement
     * of its transaction. Every other statement of that apply runs only where
     * this is still its own, so that an apply which came too late writes
     * nothing at all. (The revision cannot say that: another apply may have
     * moved it to the same number.)
     */
    writer: text("writer"),

    // What assembling the sources last produced.
    /** OpenAPI version of the assembled document, e.g. "3.1". */
    specVersion: text("spec_version").notNull(),
    /** Changes exactly when the assembled document does. */
    bodyHash: text("body_hash").notNull(),
    /** Size of the sources together. */
    bodyBytes: integer("body_bytes").notNull(),
    opIndex: text("op_index", { mode: "json" }).$type<OperationEntry[]>().notNull(),
    notes: text("notes", { mode: "json" }).$type<ProjectNote[]>().notNull().default([]),

    // Keeping followed sources current.
    /** Last round of checks in which every followed source answered. Null: none yet, or nothing is followed. */
    checkedAt: integer("checked_at"),
    /**
     * When the timer looks at the followed sources next (schedule.ts says how
     * that is decided). Null: never, because nothing is followed. A run takes
     * a project by moving this ahead, which is also what keeps two runs from
     * checking the same project.
     */
    nextCheckAt: integer("next_check_at"),
    /**
     * Set by a deploy to a project with a followed source: until then the
     * timer looks at every run, because the API behind the source is about
     * to change. The first new document ends it.
     */
    watchUntil: integer("watch_until"),
    lastStatus: text("last_status").$type<"ok" | "error">().notNull().default("ok"),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("projects_next_check").on(table.nextCheckAt)],
);

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
 * One OpenAPI document of a project: where it comes from, how it is merged
 * in, and the copy that is served from. A project has at least one.
 */
export const sources = sqliteTable(
  "sources",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** Its place in the definition's list. */
    position: integer("position").notNull(),
    /** What the definition calls it. Null for a project's only source without a name. */
    name: text("name"),
    /** A document at an address, */
    url: text("url"),
    /** or in a file of whoever deployed it: the path as the definition has it. */
    file: text("file"),
    /** The service keeps reading the URL. Otherwise the document changes only with an apply. */
    follow: integer("follow", { mode: "boolean" }).notNull().default(false),
    /** With several sources: the one whose title and servers describe the whole, and that wins a clash. */
    main: integer("main", { mode: "boolean" }).notNull().default(false),
    /** Put in front of every path of this document, e.g. "/billing". */
    pathPrefix: text("path_prefix"),
    /** Request headers sent when the service fetches it. Not part of the definition. */
    headers: text("headers", { mode: "json" }).$type<StoredHeader[]>().notNull().default([]),

    // What the document that is stored says about itself.
    title: text("title"),
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

    /** When this copy was read: fetched by the service, or uploaded. */
    verifiedAt: integer("verified_at").notNull(),
    lastStatus: text("last_status").$type<"ok" | "error">().notNull().default("ok"),
    lastError: text("last_error"),
  },
  (table) => [
    index("sources_project").on(table.projectId),
    // A definition's sources have names of their own. (A project's only source may have none.)
    uniqueIndex("sources_project_name").on(table.projectId, table.name),
  ],
);

export const variants = sqliteTable(
  "variants",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** Second segment of the public URL, and its key in the definition. */
    slug: text("slug").notNull(),
    /** Its place among the project's variants. */
    position: integer("position").notNull().default(0),
    /** What it is called. Null: by its slug. */
    name: text("name"),
    selection: text("selection", { mode: "json" }).$type<Selection>().notNull(),
    /** Title, description and servers this variant states itself, over the project's. Null: none. */
    overrides: text("overrides", { mode: "json" }).$type<DocumentOverrides>(),
    /** The icon it has in the navigation. Null: the plain one. */
    icon: text("icon").$type<VariantIconName>(),
    /** Who may read it at its URL. Null: what the project says, and then the workspace. */
    visibility: text("visibility").$type<Visibility>(),
    /**
     * A hash of everything about the variant that decides what is served: its
     * selection, and the overrides it ends up with once the project's are
     * filled in. Part of the served ETag, so a change to a project default
     * changes exactly the ETags it affects.
     */
    servedHash: text("served_hash").notNull(),
    createdAt: integer("created_at").notNull(),
    /** When its own entry in the definition last changed. */
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
 * API keys, sent as `Authorization: Bearer <key>`. Only a key's SHA-256 is
 * stored; the key itself is shown once, when it is created. There are two
 * kinds (src/shared/access.ts):
 *
 * - A deploy API key belongs to the workspace and applies definitions, which
 *   is what `openapi-proxy deploy` does from a pipeline. It keeps working
 *   when whoever made it leaves.
 * - A user API key reads private variants, all of them or one. It acts for
 *   the person who made it, for as long as they are in the workspace.
 */
export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** Who made it. A user API key is theirs; for a deploy API key this only says who. */
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    /** Hex SHA-256 of the whole key. */
    keyHash: text("key_hash").notNull().unique(),
    /** The first characters, to tell keys apart in a list. */
    prefix: text("prefix").notNull(),
    access: text("access").$type<KeyAccess>().notNull(),
    /**
     * For a user API key: the one variant it reads, or null for every private
     * variant of the workspace. The key goes when the variant does, so that
     * it never comes to read more than it was made for.
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
