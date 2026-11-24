---
"@pipe0/openapi-proxy": minor
---

Every project serves its documents as they are, at `/v/<project>/original`. `dev` serves it on localhost and lists it with the variants, `validate` and `deploy` report it first, and the file sets who may read it with `variants.original.visibility`, the one key it takes. `original` is no longer free as the slug of a variant of your own.
