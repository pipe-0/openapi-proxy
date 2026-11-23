import type { MergeNote } from "../transforms/merge.js";
import type { OperationEntry, UnmatchedNames } from "../types.js";
import type { EffectiveVisibility } from "./effective.js";
import type { ProjectDefinition } from "./format.js";
import type { Problem } from "./shape.js";

/**
 * What a project's editor talks to: three calls, the same wherever the
 * project lives. The service answers them at `/api/projects/<slug>` for a
 * project in its database, and `openapi-proxy dev` answers them for the
 * definition file it serves.
 *
 *   GET  <slug>            the definition, and what is known about it (ProjectView)
 *   GET  <slug>/document   the project's documents assembled into one
 *   PUT  <slug>            apply a definition (ApplyRequest in, ApplyResult out)
 */

/** Something that assembling a project's document did and its owner should know. */
export type ProjectNote =
  | MergeNote
  | { kind: "source-converted"; source: string; from: string; to: string };

/** Who applied a project's definition last, and from where. */
export interface AppliedRecord {
  at: number;
  by: { kind: "person" | "key"; id: string; name: string };
  /** What a deploy said about where it ran, if anything. */
  origin?: { commit?: string; ref?: string; repository?: string; runUrl?: string };
}

/** What is known about one source, next to its entry in the definition. */
export interface SourceState {
  /** Its name, or "main" for a project's only unnamed source. */
  name: string;
  /** The title its document gives itself. */
  title: string | null;
  /** Names of the request headers sent when the service fetches it. Values never leave the server. */
  headerNames: string[];
  /** What the source sends that lets a check skip the download, if anything. */
  validator: "etag" | "last-modified" | null;
  apiVersion: string | null;
  specVersion: string;
  bodyBytes: number;
  operations: number;
  /** When the copy that is served from was read: fetched, or uploaded. */
  readAt: number;
  lastStatus: "ok" | "error";
  lastError: string | null;
}

/** What is known about one variant, next to its entry in the definition. */
export interface VariantState {
  /** Stays the same for as long as the variant has its slug. */
  id: string;
  /** The public URL, without a format extension. */
  url: string;
  /** Who may read it, and which layer says so. */
  visibility: EffectiveVisibility;
  servedOperations: number;
  totalOperations: number;
  /** Names in its selection that the documents have nothing for. */
  notFound: UnmatchedNames;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectState {
  /** Send it back with a change: the change is refused if the project has moved on. */
  revision: number;
  /** Where the definition is edited: here, or in a file that is deployed. */
  managedBy: "app" | "file";
  /** Who applied the definition last, when, and from where. */
  applied: AppliedRecord | null;
  /** Everything before the project's slug in its public URLs. */
  urlPrefix: string;
  /** OpenAPI version of the assembled document: "3.0", "3.1" or "3.2". */
  specVersion: string;
  /** Changes exactly when the assembled document does. */
  documentHash: string;
  bodyBytes: number;
  /** Every operation of the assembled document. */
  operations: OperationEntry[];
  notes: ProjectNote[];
  /** Keeping followed sources current. Null when no source is followed. */
  check: {
    /** How long a copy may age before the service looks again. */
    intervalSeconds: number;
    checkedAt: number | null;
    nextCheckAt: number | null;
    /** Until when the service looks at every run, after a deploy. */
    watchUntil: number | null;
    lastStatus: "ok" | "error";
    lastError: string | null;
  } | null;
  /** In the order of the definition's sources. */
  sources: SourceState[];
  /** By slug, like the definition's variants. */
  variants: Record<string, VariantState>;
  /** Who may read a variant when neither it nor the project says. */
  defaultVisibility: "public" | "private";
  createdAt: number;
  /**
   * What can be done with this project here. An editor shows only what the
   * backend it talks to can do: a definition file on a laptop has no
   * credentials to keep and no keys to make.
   */
  can: {
    /** Change the definition from this editor. */
    edit: boolean;
    /** Keep request headers for a followed source. */
    credentials: boolean;
    /** Make user API keys for private variants. */
    keys: boolean;
    /** Look at the followed sources now. */
    check: boolean;
  };
}

/** A project as an editor reads it: its definition, and what is known about it. */
export interface ProjectView {
  definition: ProjectDefinition;
  state: ProjectState;
}

/** A document sent along with a definition: as text, or gzip-compressed and base64-encoded. */
export type DocumentInput = { content: string } | { gzip: string };

/** The body of a request to apply a definition. */
export interface ApplyRequest {
  definition: ProjectDefinition;
  /** Documents by the name of their source (`main` for a project's only unnamed one). */
  documents?: Record<string, DocumentInput>;
  /** Request headers for a followed source, by its name. An entry without a value keeps the stored one. */
  credentials?: Record<string, Array<{ name: string; value?: string }>>;
  /** What a deploy says about where it ran. */
  origin?: AppliedRecord["origin"];
  /** Apply only if the project is still at this revision. */
  ifRevision?: number;
  /** On a project that is deployed from a file: edit it here from now on. */
  editInApp?: boolean;
}

export interface SourceReport {
  name: string;
  /** What became of the source's entry. */
  action: "added" | "updated" | "unchanged" | "removed";
  /** Where the document that is stored now came from. */
  document: "uploaded" | "fetched" | "kept";
  follow: boolean;
  bytes: number;
  operations: number;
}

export interface VariantReport {
  slug: string;
  action: "created" | "changed" | "unchanged" | "deleted";
  url: string;
  /** Who may read it, and which layer says so. */
  visibility: EffectiveVisibility;
  servedOperations: number;
  totalOperations: number;
  /** Names in its selection that the documents do not have. Never an error. */
  notFound: UnmatchedNames;
  /** For a deleted variant: how many user API keys were for it alone, and went with it. */
  keysRemoved?: number;
}

/** The answer to applying a definition: what it did, or with a dry run, would do. */
export interface ApplyResult {
  dryRun: boolean;
  /** The project did not exist before. */
  created: boolean;
  /** A file took over a project that was edited in the app. */
  tookOver: boolean;
  project: { slug: string; revision: number; managedBy: "app" | "file" };
  sources: SourceReport[];
  variants: VariantReport[];
  /** What the documents that arrived with this apply changed. */
  operations: { total: number; added: string[]; removed: string[]; changed: string[] };
  /** Things that are probably not what was meant. They stopped nothing. */
  warnings: Problem[];
  /** The definition as it is stored. */
  definition: ProjectDefinition;
}
