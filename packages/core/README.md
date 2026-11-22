# @openapi-proxy/core

Work with OpenAPI documents as data: merge several into one, keep only some operations, and convert between OpenAPI 3.0 and 3.1. What comes out is a valid document that stands on its own.

```sh
npm install @openapi-proxy/core
```

```ts
import { assembleDocument, buildVariant, parseSpec, serialize } from "@openapi-proxy/core";

// 1. One document out of your sources (one source goes through unchanged).
const { doc, notes } = assembleDocument([
  { name: "Core API", doc: parseSpec(coreText).doc },
  { name: "Billing API", doc: parseSpec(billingText).doc, pathPrefix: "/billing" },
]);

// 2. What one audience gets: some operations, in the version their tools need.
const variant = buildVariant(doc, {
  selection: { mode: "include", operations: ["GET /v1/books"], tags: ["public"] },
  version: "3.0", // leave out to keep the document's own
});

serialize(variant.doc, "yaml");
```

This is the engine behind [openapi-proxy](https://github.com/pipe-0/openapi-proxy), which serves such documents at stable URLs. It has no I/O and one dependency (`yaml`), and runs anywhere JavaScript does: Node, browsers, Workers.

## How it is laid out

A document goes through a short pipeline, and the code is laid out the same way. Each transform is a pure function from documents to a document, usable on its own.

```
text ─▶ parse ─▶ [convert] ─▶ merge ─▶ select ─▶ [convert] ─▶ serialize ─▶ text
                 only if sources          only if another
                 differ in version        version is asked for
```

| Folder            | What is in it                                                                           |
| ----------------- | --------------------------------------------------------------------------------------- |
| `src/document`    | Reading and writing: parse, serialize, JSON pointers, where operations and schemas live |
| `src/inspect`     | Reading facts off a document: its operations, a fingerprint per operation, what changed |
| `src/selection`   | The selection model: which operations it keeps, and editing it by outcome               |
| `src/transforms`  | `select.ts`, `merge.ts` and `convert/`: the steps of the pipeline                       |
| `src/pipeline.ts` | The two stages above as two functions, `assembleDocument` and `buildVariant`            |

A version conversion is a list of small named steps (`nullable becomes the type null`, `const becomes a one-value enum`), each a few lines with its own test. Supporting one more difference between two versions means adding one step to `src/transforms/convert`.

## Merging

`mergeDocuments(parts)` (and `assembleDocument`, which converts first if it must) combines independent APIs into one document. It is not for one API split across files with `$ref`; bundle those first.

The rules are fixed, so that a merge can run unattended whenever a source changes:

- **The first document is the main one.** `info`, `servers` and everything else at the top level come from it.
- **Every operation keeps its security.** Where a part's default `security` differs from the main document's, it is written onto that part's operations.
- **Paths, webhooks, components and tags are combined.** A part can be given a `pathPrefix`, for a service mounted under the main API.
- **The same operation in two documents:** the earlier one is kept, and a note says which was left out.
- **The same component name in two documents:** if both mean the same thing (compared together with everything they reference), they become one. If not, the later one is renamed after its document, `Error` to `BillingError`, and every reference follows: `$ref`s, discriminators (including schemas they find by name alone), security requirements. Example data is left as it is.
- **A repeated `operationId`** is renamed the same way.

The result lists what was done (`notes`) and where each operation came from (`origins`).

`parseSpec` refuses a document that has a key named `__proto__` anywhere, and one that is past `DOCUMENT_LIMITS` when written out (30 MB with indentation, 200 levels of nesting): a file's size in bytes does not bound what it stands for. `assembleDocument` and `buildVariant` measure what they produce the same way (`OUTPUT_LIMITS`). And the work is counted: everything that goes over a document draws from one budget per job (`WORK_BUDGET`, about four times what five megabytes of YAML take to render), so a document that multiplies work ends in a `DocumentTooComplexError`, not in a long wait. A job is one call, or whatever you put `withBudget` around. If you parse documents yourself, the merge is still safe: it never reads a document's keys off an ordinary object it then writes to.

Treat a parsed document as immutable. The engine never changes its input and shares what it does not touch between input and output.

## Converting between versions

`convertDocument(doc, "3.1")` and `convertDocument(doc, "3.0")`.

- **3.0 to 3.1** loses nothing: `nullable`, boolean exclusive bounds and `example` are rewritten as JSON Schema says them.
- **3.1 to 3.0** translates what has an equivalent (lists of types, `const`, "or null", numeric exclusive bounds, `examples`, file and base64 content, references with siblings) and removes what has none (`patternProperties`, `prefixItems`, `if`/`then`/`else`, and so on). Every removal is reported in `losses`, by name and count. Webhooks move to `x-webhooks`.

A document already in the version asked for comes back untouched. Schemas are found by where they stand in the document, never by what they look like, so a property named `nullable` or an example that contains `const` is left alone.

## Selections

```ts
interface Selection {
  mode: "include" | "exclude";
  operations: string[]; // "METHOD path", or "METHOD webhook:name"
  tags: string[];
}
```

An operation matches when its key is listed **or** it carries a listed tag. `include` keeps the matches; `exclude` keeps everything else. Keys are built from method and path, so documents without `operationId`s work. `indexOperations(doc)` lists every key in a document, with tags, summaries and deprecation flags.

## What the output contains

- The kept operations, under `paths` and `webhooks`. A path with no kept operation is gone.
- Exactly the components those operations need, followed transitively: schemas, responses, parameters, examples, request bodies, headers, links, callbacks, path items, media types. Circular references are handled.
- Things that are referenced without a `$ref`: `discriminator.mapping` targets, and security schemes named in `security` requirements.
- Tags (and `x-tagGroups` entries) that a kept operation still uses, with their OpenAPI 3.2 parents.
- Everything else as it was: `info`, `servers`, vendor extensions, component groups it does not know.

If the source points a `$ref` into an operation instead of into `components` (bundlers do this), and that operation is removed, the reference is replaced with a copy of its target.

## Guarantees

Checked by the test suite across real and synthetic documents, with [`@scalar/openapi-parser`](https://github.com/scalar/scalar) as an independent judge of validity:

- **Self-contained.** Every reference in the output resolves in the output, as long as that was true of the input.
- **Non-destructive.** The input is never modified. Untouched parts are shared with it, not copied.
- **Order-preserving.** Keys come out in the order they went in.
- **Idempotent.** Applying the same selection to the output changes nothing.

## Also exported

| Function                                                    | What it does                                                                                             |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `parseSpec(text)`                                           | Parse JSON or YAML; reports format, spec version and whether JSON was minified. Throws `SpecParseError`. |
| `findExternalRefs(doc)`                                     | References that point outside the document, which this package does not resolve.                         |
| `resolveSelection(index, selection)`                        | The set of operation keys a selection keeps.                                                             |
| `computeDrift(selection, snapshot, index)`                  | What changed in a source since a selection was last reviewed.                                            |
| `fingerprintOperations(doc)`                                | One fingerprint per operation that changes when the operation, or anything it references, does.          |
| `setOperationsServed`, `setTagServed`, `pinTag`, `withMode` | Edit a selection by outcome ("serve this", "hide that tag") instead of by rule.                          |
| `slugify(name)`, `isValidSlug(slug)`                        | URL-safe slugs.                                                                                          |
| `TRANSFORM_VERSION`                                         | Changes whenever output bytes can. Fold it into cache keys.                                              |

## Limits

OpenAPI 3.0, 3.1 and 3.2 (conversion covers 3.0 and 3.1; Swagger 2.0 is not read). External and multi-file references are not followed; bundle the document first.

## License

MIT
