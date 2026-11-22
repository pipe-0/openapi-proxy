---
"@openapi-proxy/core": minor
---

Initial release. Work with OpenAPI 3.0, 3.1 and 3.2 documents (JSON or YAML) as data:

- **Select.** Index operations and webhooks by method and path, apply include or exclude selections with dynamic tag rules, and prune `components` to exactly what the kept operations reference (discriminator mappings and implied subtypes, security schemes by name, circular references, path items behind a `$ref`). References that point into a removed operation are inlined, so the output always stands on its own.
- **Merge.** Combine independent documents into one: the first is the main one, an operation defined twice is kept from the earlier document, and a component name used for two different things is renamed with every reference following.
- **Convert.** Between OpenAPI 3.0 and 3.1, as a list of small named steps; what 3.0 cannot express is reported.
- Also: source drift detection, per-operation fingerprints that change when an operation or anything it references changes, helpers for editing a selection by outcome, and serialization to JSON (mirroring the source's indentation) or YAML with key order preserved.
