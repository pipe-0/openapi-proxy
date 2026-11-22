# openapi-proxy

**Filter one OpenAPI document into a version for each audience, and serve each one at a stable URL.**

Your backend generates one OpenAPI (Swagger) document for everything it does. Your public API docs, your SDK generator and your partners should each see a different part of it. openapi-proxy sits in between: point it at the document, pick the operations for each audience in a UI, and give each tool a URL of its own. When your API changes, the filtered documents change with it.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/editor-dark.png">
  <img alt="openapi-proxy filtering an OpenAPI document: the operations of the API with checkboxes on the left, the filtered OpenAPI document that is served on the right, and its public URL above both." src="docs/editor-light.png">
</picture>

**[Use it at openapi-proxy.app](https://openapi-proxy.app)** · [Documentation](https://openapi-proxy.app/docs) · [Self-hosting](https://openapi-proxy.app/docs/self-hosting)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/pipe-0/openapi-proxy)

## What you can do with it

- **Hide internal endpoints from your public API docs.** Check the operations, or whole tags, that a variant serves. The document that will be served is on screen while you do, and nothing goes live until you publish.
- **Generate an SDK from a part of your API.** A variant keeps the operations you chose and exactly the schemas, parameters, responses and security schemes they reference. What comes out is a valid, self-contained OpenAPI document.
- **Give a partner only their endpoints.** A project has as many variants as it has audiences, each at its own URL.
- **Merge the OpenAPI documents of several services into one.** Components that share a name but not a meaning are told apart, and you are shown what the merge did.
- **Serve OpenAPI 3.0 to a tool that cannot read 3.1.** Every variant is served in both versions, converted from what your API has. The reader picks one with the URL: `/v/acme/sdk/3.0.json`.
- **Point each environment at its own server.** A variant can state its own title, description and servers, for production, a sandbox or staging.
- **Stay current without a build step.** The proxy checks your API for changes, keeps serving the last good copy when it is down, and emails you when operations are added, changed or removed.
- **Keep internal APIs private.** A variant can be private, read with an API key that opens that variant and nothing else. The proxy fetches your full document with request headers you provide, stored encrypted.
- **Automate it.** Everything the app does is an HTTP API with API keys, and an MCP endpoint offers the same to agents.

It works with anything that reads an OpenAPI document from a URL, such as Swagger UI, Redoc, Scalar, Mintlify or openapi-generator.

## How it works

```
consumer (docs site, SDK generator, curl)
        │  GET /v/pipe0/public-docs.json
        ▼
   openapi-proxy (one Cloudflare Worker and a D1 database)
        │  serves the stored result, and checks your API first when the copy is due
        ▼
   your OpenAPI document
```

- A **project** is one API as its readers know it: one OpenAPI document fetched from a URL, or several merged into one.
- A **variant** is a named selection of the project's operations, served at `/v/<project>/<variant>` as JSON or YAML, in OpenAPI 3.0 or 3.1, to anyone or to readers with a key.
- A **workspace** is the people who share the projects.

## Get started

**Hosted.** Sign in at [openapi-proxy.app](https://openapi-proxy.app), paste the URL of your OpenAPI document, pick operations, and copy the variant's URL. It is free for 3 projects and 15 variants.

**On your own Cloudflare account.** Click **Deploy to Cloudflare** above. [Self-hosting](https://openapi-proxy.app/docs/self-hosting) covers the secrets, sign-in, email and limits.

**On your machine.**

```sh
git clone https://github.com/pipe-0/openapi-proxy && cd openapi-proxy
pnpm install
cp .env.example .env     # sign in with the admin password: admin
pnpm dev                 # http://localhost:7732, no Cloudflare account needed
```

## Documentation

|                                                                         |                                                                                                                                                 |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| [Connecting a document](https://openapi-proxy.app/docs/connecting)      | What the proxy reads, and how it reads a private document                                                                                       |
| [Selecting operations](https://openapi-proxy.app/docs/selecting)        | What a variant serves, today and when your API grows                                                                                            |
| [Serving a variant](https://openapi-proxy.app/docs/serving)             | URLs, formats, ETags and caching, and private variants                                                                                          |
| [Merging documents](https://openapi-proxy.app/docs/merging)             | One project from the documents of several services                                                                                              |
| [Environments and servers](https://openapi-proxy.app/docs/environments) | Production, sandbox and staging                                                                                                                 |
| [OpenAPI versions](https://openapi-proxy.app/docs/versions)             | Every variant as 3.0 and 3.1, picked by the URL                                                                                                 |
| [When your API changes](https://openapi-proxy.app/docs/changes)         | What is served then, and the emails you get                                                                                                     |
| [Keeping in sync](https://openapi-proxy.app/docs/keeping-in-sync)       | How often the proxy looks, and how to make a check nearly free                                                                                  |
| [API and MCP](https://openapi-proxy.app/docs/api-and-mcp)               | Doing all of it from a script or an agent                                                                                                       |
| [Self-hosting](https://openapi-proxy.app/docs/self-hosting)             | Running it on your own Cloudflare account, and [giving a workspace Pro with a query](https://openapi-proxy.app/docs/self-hosting#selling-plans) |

Every instance serves the same pages under `/docs`. Their source is in [`src/web/content/docs`](src/web/content/docs).

## The engine: @openapi-proxy/core

The filter engine is a separate MIT-licensed package with one dependency (`yaml`) and no I/O. The Worker and the browser preview run the same code, and you can use it in your own pipelines to filter, merge and convert OpenAPI documents:

```ts
import { assembleDocument, buildVariant, parseSpec, serialize } from "@openapi-proxy/core";

const { doc } = assembleDocument([
  { name: "Core API", doc: parseSpec(coreText).doc },
  { name: "Billing API", doc: parseSpec(billingText).doc, pathPrefix: "/billing" },
]);
const variant = buildVariant(doc, {
  selection: { mode: "include", operations: ["GET /v1/books"], tags: ["public"] },
  version: "3.0",
});
const yaml = serialize(variant.doc, "yaml");
```

The output is valid and self-contained, the input is never mutated, and key order is preserved. See [packages/core](packages/core).

## Development

Tool versions are pinned in [`mise.toml`](mise.toml) (Node 24, pnpm 11): `mise install`, or bring your own.

```sh
pnpm install
pnpm dev           # Vite, the Worker in workerd and a local D1 database, on :7732
pnpm check         # lint, typecheck, unit and integration tests
pnpm test:e2e      # the product journey in a real browser, fully offline
```

The repository root is the deployable app: `src/server` is the API, the public documents and the hourly check, and `src/web` is the Worker's entry and every page (React on TanStack Start). To change it, read [CONTRIBUTING.md](CONTRIBUTING.md), [ARCHITECTURE.md](ARCHITECTURE.md), [docs/flows.md](docs/flows.md) for the interaction design, [docs/design.md](docs/design.md) for the design system, and [SECURITY.md](SECURITY.md).

## License

- [`packages/core`](packages/core/LICENSE): **MIT**
- Everything else: **[FSL-1.1-MIT](LICENSE.md)**. Free to use, self-host and modify. You may not offer it as a competing hosted service. Each release becomes MIT two years after it is published.
