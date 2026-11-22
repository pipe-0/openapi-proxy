import { isAlias, isMap, isPair, isScalar, isSeq, LineCounter, parseDocument } from "yaml";
import { isJsonObject, type JsonObject, type ParsedSpec } from "../types.js";
import { spend, spendText, withBudget } from "./budget.js";
import { DOCUMENT_LIMITS, DocumentTooComplexError, measure, tooDeep } from "./limits.js";

export type SpecParseErrorCode =
  | "invalid-syntax"
  | "not-openapi"
  | "too-complex"
  | "unsupported-version"
  | "external-refs";

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
  return withBudget(() => {
    try {
      return parse(input);
    } catch (error) {
      // Turned away here, once, so that nothing after this has to think about
      // a document that is too much to work on or holds more than data.
      if (!(error instanceof DocumentTooComplexError)) throw error;
      throw new SpecParseError(
        error.code === "not-plain-data" ? "not-openapi" : "too-complex",
        error.message,
      );
    }
  });
}

function parse(input: string): ParsedSpec {
  // A UTF-8 byte order mark is legal in front of a file but not inside JSON.parse.
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const trimmed = text.trimStart();
  if (trimmed === "") {
    throw new SpecParseError("invalid-syntax", "The document is empty.");
  }
  spendText(text.length);

  let doc: unknown;
  let format: "json" | "yaml" = "yaml";

  if (trimmed.startsWith("{")) {
    try {
      doc = JSON.parse(text);
      format = "json";
    } catch (error) {
      // A brace also opens a map in YAML. If it is not that either, the
      // document was meant to be JSON, and the first problem is the one to report.
      try {
        doc = parseYaml(text);
      } catch (yamlError) {
        if (yamlError instanceof DocumentTooComplexError) throw yamlError;
        throw new SpecParseError(
          "invalid-syntax",
          `Not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } else {
    doc = parseYaml(text);
  }

  if (!isJsonObject(doc)) {
    throw new SpecParseError("not-openapi", "The document is not an object.");
  }
  measure(doc, DOCUMENT_LIMITS, { plainDataOnly: true });

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
  // JSON on one line: nothing follows the opening brace but the first key.
  const minified = format === "json" && !/^\{\s*\n/.test(trimmed.slice(0, 4096));
  return { doc, format, specVersion, minified };
}

/**
 * YAML to plain values.
 *
 * Read as YAML 1.2 with its core schema, whatever the file declares: that is
 * the YAML which is JSON with another syntax, and the one OpenAPI asks for.
 * The 1.1 features that go beyond it (merge keys, sets, dates, binary) would
 * give values a JSON document cannot hold.
 *
 * The library reads the text. Turning what it read into values is done here,
 * in one pass, because its own conversion looks every alias up among all
 * anchors of the file and handles a map's keys in ways that cost the square
 * of what a file holds. Here an alias is a lookup, and what it gives is the
 * very object the anchor made: nothing is copied, and `measure` afterwards
 * counts every mention.
 */
function parseYaml(text: string): unknown {
  // Reading YAML takes several times what reading JSON takes, per character.
  spend(text.length >>> 2);
  const lines = new LineCounter();
  let document: ReturnType<typeof parseDocument>;
  try {
    document = parseDocument(text, {
      schema: "core",
      lineCounter: lines,
      // Would compare every key of a map with all the keys before it. A key
      // that is written twice counts once, the later value, as in JSON.
      uniqueKeys: false,
      // Would cut the line concerned out of the text again for every error
      // and every warning. Where the first error is, is worked out below.
      prettyErrors: false,
    });
  } catch (error) {
    throw invalidYaml(error instanceof Error ? error.message : String(error));
  }
  const [problem] = document.errors;
  if (problem) {
    const { line, col } = lines.linePos(problem.pos[0]);
    throw invalidYaml(`${problem.message} (line ${line}, column ${col})`);
  }

  /** Anchor → the value it is on, or `building` while that value is being put together. */
  const anchors = new Map<string, unknown>();
  const building = Symbol("building");

  const convert = (node: unknown, depth: number): unknown => {
    spend();
    if (depth > DOCUMENT_LIMITS.depth) throw tooDeep(DOCUMENT_LIMITS.depth);
    if (isAlias(node)) {
      if (!anchors.has(node.source)) throw invalidYaml(`*${node.source} has no anchor before it.`);
      const value = anchors.get(node.source);
      if (value === building) {
        throw invalidYaml(`*${node.source} refers to the value it is inside of.`);
      }
      return value;
    }

    // An alias means the nearest anchor of its name before it, and an anchor
    // comes before everything inside the value it is on.
    const anchor = (node as { anchor?: unknown } | null)?.anchor;
    if (typeof anchor === "string") anchors.set(anchor, building);

    let value: unknown = null;
    if (isSeq(node)) {
      value = node.items.map((item) =>
        // `[a: 1]` is a list of one map.
        isPair(item) ? field({}, item, depth + 1) : convert(item, depth + 1),
      );
    } else if (isMap(node)) {
      const object: JsonObject = {};
      for (const pair of node.items) field(object, pair, depth + 1);
      value = object;
    } else if (isScalar(node)) {
      value = node.value;
    }
    // Unless something inside took the name for itself.
    if (typeof anchor === "string" && anchors.get(anchor) === building) anchors.set(anchor, value);
    return value;
  };
  /** Add one `key: value` of a map. Keys are text, as in JSON. */
  const field = (object: JsonObject, pair: { key: unknown; value: unknown }, depth: number) => {
    const key = convert(pair.key, depth);
    if (typeof key === "object" ? key !== null : typeof key === "symbol") {
      throw new SpecParseError(
        "not-openapi",
        "The document uses a list, a map or a tagged value as the key of a YAML map. Keys have to be text.",
      );
    }
    // Defined, not assigned: a key called `__proto__` becomes a field like
    // any other (and is refused afterwards), not the object's prototype.
    Object.defineProperty(object, key === null ? "" : String(key), {
      value: convert(pair.value, depth),
      enumerable: true,
      writable: true,
      configurable: true,
    });
    return object;
  };

  return convert(document.contents, 1);
}

const invalidYaml = (message: string) =>
  new SpecParseError("invalid-syntax", `Not valid YAML: ${message}`);
