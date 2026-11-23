import { SLUG_PATTERN } from "../selection/resolve.js";
import type { DocumentOverrides } from "../transforms/override.js";
import { OVERRIDE_LIMITS } from "../transforms/override.js";
import type { SelectionRules } from "../types.js";
import { VARIANT_ICONS, type VariantIconName } from "./icons.js";
import type { Shape } from "./shape.js";

/** The versions of the format this code reads. A file states its own as `version`. */
export const DEFINITION_VERSIONS = [1] as const;

/** Who may read what a variant serves: anyone with the URL, or only an API key that reads it. */
export type Visibility = "public" | "private";
export const VISIBILITIES = ["public", "private"] as const;

export function isVisibility(value: unknown): value is Visibility {
  return value === "public" || value === "private";
}

/** How much a definition may hold. The same on every plan and every instance. */
export const DEFINITION_LIMITS = {
  sources: 10,
  variants: 100,
  /** Operations one side of a selection may list by name. */
  operations: 10_000,
  /** Tags one side of a selection may list. */
  tags: 2_000,
  name: 100,
  /** One operation key, tag, URL or path. */
  text: 2_000,
  pathPrefix: 200,
} as const;

/** One OpenAPI document of a project: where it comes from and how it is merged in. */
export interface SourceDefinition {
  /** What people call it. Required when a project has several. */
  name?: string;
  /** A document at an address. */
  url?: string;
  /** A document in a file, relative to the definition file. It is uploaded with a deploy. */
  file?: string;
  /** With several sources: the one whose title, description and servers describe the whole. */
  main?: boolean;
  /** For a URL: the service keeps reading it, so that the document stays current between deploys. */
  follow?: boolean;
  /** Put in front of every path of this document. */
  pathPrefix?: string;
}

/** One audience's document: a selection of the project's operations, and how it is presented. */
export interface VariantDefinition {
  name?: string;
  icon?: VariantIconName;
  /** Left out: the project's, and then the workspace's. */
  visibility?: Visibility;
  include?: SelectionRules;
  exclude?: SelectionRules;
  /** Per key over the project's `overrides`, which are over what the main document says. */
  overrides?: DocumentOverrides;
}

/** Everything that describes a project: what its document is made of and what is served from it. */
export interface ProjectDefinition {
  version: 1;
  /** The slug: the first part of every public URL, `/v/<project>/<variant>`. The project's identity. */
  project: string;
  name?: string;
  /** The instance this is deployed to, when that is not the hosted service. Used by the CLI only. */
  instance?: string;
  /** The default for this project's variants. */
  visibility?: Visibility;
  /** Defaults for every variant. */
  overrides?: DocumentOverrides;
  sources: SourceDefinition[];
  /** By slug: the second part of the public URL. */
  variants: Record<string, VariantDefinition>;
}

const SLUG_HINT =
  "must be 2 to 64 characters of a-z, 0-9 and hyphens, starting and ending with a letter or digit.";
const text = (doc: string, max: number = DEFINITION_LIMITS.text): Shape => ({
  kind: "text",
  doc,
  max,
});

const rules = (doc: string): Shape => ({
  kind: "object",
  doc,
  fields: {
    tags: {
      kind: "list",
      doc: "Tags. A tag is a rule: it also covers operations that get the tag later.",
      of: text("A tag, exactly as the document spells it."),
      max: DEFINITION_LIMITS.tags,
    },
    operations: {
      kind: "list",
      doc: 'Operations, each by method and path as the document has them, such as "GET /v1/books".',
      of: text(
        'An operation: its method in capitals, a space, and its path. A webhook is "POST webhook:<name>".',
      ),
      max: DEFINITION_LIMITS.operations,
    },
  },
});

const overrides = (doc: string): Shape => ({
  kind: "object",
  doc,
  fields: {
    title: text("The title readers see, instead of the document's.", OVERRIDE_LIMITS.title),
    description: text(
      "The description readers see, instead of the document's.",
      OVERRIDE_LIMITS.description,
    ),
    servers: {
      kind: "list",
      doc: "Where the API is reached, instead of the document's whole list. Tools use the first unless someone picks another.",
      max: OVERRIDE_LIMITS.servers,
      of: {
        kind: "object",
        doc: "One place the API is reached.",
        required: ["url"],
        fields: {
          url: {
            kind: "text",
            doc: "The address, starting with https://, http:// or /.",
            max: OVERRIDE_LIMITS.url,
            pattern: /^(?:https?:\/\/|\/)[^\s{}]*$/,
            hint: "must start with https://, http:// or /, without spaces or {variables}.",
          },
          description: text('What this one is, such as "Production".', 200),
        },
      },
    },
  },
});

const visibility = (doc: string): Shape => ({ kind: "choice", doc, values: VISIBILITIES });

const INCLUDE = rules(
  "What is served. Left out, everything is, and so is what the API adds later. With it, only what it names is served.",
);
const EXCLUDE = rules("What is not served, whatever include says.");

/** A selection by itself: what `include` and `exclude` may hold. */
export const SELECTION_SHAPE: Shape = {
  kind: "object",
  doc: "Which operations are served.",
  fields: { include: INCLUDE, exclude: EXCLUDE },
};

/** The definition format, version 1. */
export const DEFINITION_SHAPE: Shape = {
  kind: "object",
  doc: "An openapi-proxy project: the OpenAPI documents it is made of, and the variants served from them.",
  required: ["version", "project", "sources"],
  fields: {
    version: { kind: "exactly", doc: "The version of this format. Always 1.", value: 1 },
    project: {
      kind: "text",
      doc: "The project's slug: the first part of every public URL, /v/<project>/<variant>. It is the project's identity; a deploy creates the project or updates the one with this slug.",
      pattern: SLUG_PATTERN,
      hint: SLUG_HINT,
    },
    name: text(
      "What the project is called in the app. Left out, it is the slug.",
      DEFINITION_LIMITS.name,
    ),
    instance: {
      kind: "text",
      doc: "The address of the instance this is deployed to, for a self-hosted one. Left out, it is https://openapi-proxy.app.",
      pattern: /^https?:\/\/[^\s/]+(?:\/[^\s]*)?$/,
      hint: "must be an address starting with https:// (or http:// for a local one).",
    },
    visibility: visibility(
      "Who may read this project's variants unless a variant says otherwise. Left out, it is the workspace's default.",
    ),
    overrides: overrides(
      "Title, description and servers for every variant, instead of what the main document says. A variant can state its own.",
    ),
    sources: {
      kind: "list",
      doc: "The OpenAPI documents of the project, merged into one in this order. One source needs only url or file. With several, each has a name and exactly one says main: true.",
      max: DEFINITION_LIMITS.sources,
      of: {
        kind: "object",
        doc: "One OpenAPI document: at a url, or in a file.",
        schema: { oneOf: [{ required: ["url"] }, { required: ["file"] }] },
        fields: {
          name: text(
            "What this document is called. Required with several sources; it also names components that have to be renamed in a merge.",
            DEFINITION_LIMITS.name,
          ),
          url: {
            kind: "text",
            doc: "The address of the document. A deploy reads it where it runs and uploads what it finds.",
            max: DEFINITION_LIMITS.text,
            pattern: /^https?:\/\/\S+$/,
            hint: "must be an address starting with http:// or https://.",
          },
          file: text("The path of the document, relative to this file. A deploy uploads it."),
          main: {
            kind: "flag",
            doc: "With several sources: this is the one whose title, description and servers describe the merged document, and whose operations win where two define the same.",
          },
          follow: {
            kind: "flag",
            doc: "For a url: the service keeps reading it, so the document stays current between deploys. Left out, it changes only with a deploy.",
          },
          pathPrefix: text(
            "Put in front of every path of this document, such as /billing.",
            DEFINITION_LIMITS.pathPrefix,
          ),
        },
      },
    },
    variants: {
      kind: "map",
      doc: "The documents served from the project, by slug: the second part of the public URL.",
      max: DEFINITION_LIMITS.variants,
      key: { pattern: SLUG_PATTERN, hint: `is not a slug: it ${SLUG_HINT}` },
      of: {
        kind: "object",
        doc: "One audience's document.",
        fields: {
          name: text(
            "What the variant is called in the app. Left out, it is the slug.",
            DEFINITION_LIMITS.name,
          ),
          icon: {
            kind: "choice",
            doc: "The icon it has in the app's navigation.",
            values: VARIANT_ICONS,
          },
          visibility: visibility(
            "Who may read it: public (anyone with the URL) or private (an API key that reads it). Left out, it is the project's, then the workspace's default.",
          ),
          include: INCLUDE,
          exclude: EXCLUDE,
          overrides: overrides(
            "Title, description and servers this variant states itself, key by key over the project's.",
          ),
        },
      },
    },
  },
};
