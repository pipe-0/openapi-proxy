import { parseDocument, visit } from "yaml";
import { isJsonObject, type JsonIndent, type JsonObject, type ParsedSpec } from "../types.js";

export type SpecParseErrorCode =
  | "invalid-syntax"
  | "not-openapi"
  | "too-complex"
  | "unsupported-version"
  | "external-refs";

/**
 * How much structure a document may have. Its size in bytes says little
 * about what it costs to work on: a small file can be nested thousands of
 * levels deep, or use YAML aliases to describe a tree a thousand times its
 * own size. Real documents are nowhere near these numbers.
 */
export const DOCUMENT_LIMITS = {
  /** Levels of nesting. Deeper than this, and code that walks a document by recursion runs out of stack. */
  depth: 200,
  /** Objects and lists, counted with every YAML alias written out. */
  nodes: 1_000_000,
  /**
   * `*name` references in YAML. Each is looked up among all anchors and
   * aliases of the file, so their cost grows with the square of their number.
   */
  yamlAliases: 5_000,
};

export class SpecParseError extends Error {
  readonly code: SpecParseErrorCode;

  constructor(code: SpecParseErrorCode, message: string) {
    super(message);
    this.name = "SpecParseError";
    this.code = code;
  }
}

/**
 * Parse an OpenAPI document from raw text. Sniffs JSON vs YAML by the first
 * non-whitespace character. Accepts OpenAPI 3.x only.
 */
export function parseSpec(input: string): ParsedSpec {
  // A UTF-8 byte order mark is legal in front of a file but not inside JSON.parse.
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const trimmed = text.trimStart();
  if (trimmed === "") {
    throw new SpecParseError("invalid-syntax", "The document is empty.");
  }

  let doc: unknown;
  let format: "json" | "yaml";

  if (trimmed.startsWith("{")) {
    format = "json";
    try {
      doc = JSON.parse(text);
    } catch (error) {
      throw new SpecParseError(
        "invalid-syntax",
        `Not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else {
    format = "yaml";
    doc = parseYaml(text);
  }

  if (!isJsonObject(doc)) {
    throw new SpecParseError("not-openapi", "The document is not an object.");
  }
  assertPlainData(doc);

  if (typeof doc.swagger === "string") {
    throw new SpecParseError(
      "unsupported-version",
      "Swagger 2.0 documents are not supported. Convert the document to OpenAPI 3.x first.",
    );
  }

  const openapi = doc.openapi;
  if (typeof openapi !== "string") {
    throw new SpecParseError(
      "not-openapi",
      "This doesn't look like an OpenAPI document: the `openapi` field is missing.",
    );
  }

  if (!openapi.startsWith("3.")) {
    throw new SpecParseError(
      "unsupported-version",
      `OpenAPI ${openapi} is not supported. Only OpenAPI 3.x documents are.`,
    );
  }

  const specVersion = openapi.split(".").slice(0, 2).join(".");
  return { doc, format, specVersion, indent: format === "json" ? detectJsonIndent(trimmed) : 2 };
}

/** YAML to plain values, refusing a file whose aliases alone would take seconds to resolve. */
function parseYaml(text: string): unknown {
  try {
    const document = parseDocument(text);
    const [problem] = document.errors;
    if (problem) throw problem;

    let aliases = 0;
    visit(document, {
      Alias() {
        aliases += 1;
      },
    });
    if (aliases > DOCUMENT_LIMITS.yamlAliases) {
      throw new SpecParseError(
        "too-complex",
        `The document uses ${aliases.toLocaleString("en-US")} YAML aliases (\`*name\`). Up to ${DOCUMENT_LIMITS.yamlAliases.toLocaleString("en-US")} are accepted. Use \`$ref\` and components instead, or convert the file to JSON.`,
      );
    }
    // What one anchor may expand to in total. The count of nodes below bounds all of them together.
    return document.toJS({ maxAliasCount: 10_000 });
  } catch (error) {
    if (error instanceof SpecParseError) throw error;
    throw new SpecParseError(
      "invalid-syntax",
      `Not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * One walk over everything in a parsed document, to turn away what the rest
 * of the code should never have to think about.
 *
 * A key called `__proto__`. It is the one key that is not safe to carry
 * around in JavaScript: reading it from an ordinary object does not give what
 * the document put there but the prototype that all objects share, and code
 * that then writes into what it read changes every object in the program. No
 * OpenAPI document needs the key. The parsed value is searched, not the
 * text, because in JSON the key can be written with escapes.
 *
 * And more structure than `DOCUMENT_LIMITS` allows. The walk follows YAML
 * aliases like everything else does afterwards, so it counts the document at
 * the size it will be worked on. It stops as soon as a limit is passed.
 */
function assertPlainData(root: JsonObject): void {
  // Two stacks instead of one of pairs: a large document has a million nodes.
  const nodes: unknown[] = [root];
  const depths: number[] = [1];
  let seen = 0;

  while (nodes.length > 0) {
    const node = nodes.pop();
    const depth = depths.pop() as number;
    const children = Array.isArray(node) ? node : isJsonObject(node) ? Object.values(node) : null;
    if (children === null) continue;

    if (!Array.isArray(node) && Object.hasOwn(node as object, "__proto__")) {
      throw new SpecParseError(
        "not-openapi",
        "The document has a key named `__proto__`, which is not accepted. No OpenAPI document needs one.",
      );
    }
    seen += 1;
    if (seen > DOCUMENT_LIMITS.nodes) {
      throw new SpecParseError(
        "too-complex",
        `The document has more than ${DOCUMENT_LIMITS.nodes.toLocaleString("en-US")} objects and lists (counting what its YAML aliases repeat). That is more than this can work with.`,
      );
    }
    if (depth > DOCUMENT_LIMITS.depth) {
      throw new SpecParseError(
        "too-complex",
        `The document is nested more than ${DOCUMENT_LIMITS.depth} levels deep.`,
      );
    }
    for (const child of children) {
      if (typeof child === "object" && child !== null) {
        nodes.push(child);
        depths.push(depth + 1);
      }
    }
  }
}

/**
 * The indentation a JSON text uses, read off its first nested line: a number
 * of spaces, a tab, or 0 when the document is minified.
 */
function detectJsonIndent(text: string): JsonIndent {
  const match = /^[{[]\s*?\n([ \t]*)\S/.exec(text.slice(0, 4096));
  if (!match) return 0;
  const whitespace = match[1] ?? "";
  if (whitespace.includes("\t")) return "\t";
  return Math.min(whitespace.length, 8);
}

/**
 * Collect `$ref` values that point outside the document, i.e. anything that is
 * not a `#...` fragment. Used to reject multi-file specs up front with a clear
 * message instead of serving broken output later.
 */
export function findExternalRefs(doc: JsonObject): string[] {
  const external = new Set<string>();
  const stack: unknown[] = [doc];

  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
      continue;
    }
    if (!isJsonObject(node)) continue;
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string" && !value.startsWith("#")) {
        external.add(value);
      }
      stack.push(value);
    }
  }

  return [...external];
}
