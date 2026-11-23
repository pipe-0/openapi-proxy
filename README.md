# openapi-proxy

**Filter one OpenAPI document into a version for each audience, and serve each one at a stable URL.**

Your backend generates one OpenAPI (Swagger) document for everything it does. Your public API docs, your SDK generator and your partners should each see a different part of it. openapi-proxy sits in between: it keeps the operations each audience should get, with exactly what they reference, and gives each selection a URL of its own. When your API changes, the filtered documents change with it.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/editor-dark.png">
  <img alt="openapi-proxy filtering an OpenAPI document: the operations of the API with checkboxes on the left, the filtered OpenAPI document that is served on the right, and its public URL above both." src="docs/editor-light.png">
</picture>

**[Use it at openapi-proxy.app](https://openapi-proxy.app)** · [Documentation](https://openapi-proxy.app/docs) · [Self-hosting](https://openapi-proxy.app/docs/self-hosting)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/pipe-0/openapi-proxy)

## Two ways to use it

**From a URL.** Your OpenAPI document is at a URL. The service reads it, keeps reading it, and you choose in the app what each audience gets.

**From your repository.** What each audience gets is written in a file next to your code. You serve it on localhost while you work, and deploy it from CI.

```yaml
# openapi-proxy.yaml
version: 1
project: bookshop

sources:
  - file: ./openapi.json

variants:
  public:
    include:
      tags: [Books, Orders]
    exclude:
      operations: [GET /orders/export]
```

```sh
npx @pipe0/openapi-proxy init ./openapi.json   # writes a first openapi-proxy.yaml
npx @pipe0/openapi-proxy dev                   # serves http://localhost:7745/v/bookshop/public.json, and an editor for the file
npx @pipe0/openapi-proxy deploy                # from CI, with a deploy API key
```

Both make the same thing: a project with variants at the same URLs. A project that started in the app can move into a repository later, without rebuilding anything.

## What you can do with it

- **Hide internal endpoints from your public API docs.** Check the operations, or whole tags, that a variant serves. The document that will be served is on screen while you do, and nothing goes live until you publish.
- **Generate an SDK from a part of your API.** A variant keeps the operations you chose and exactly the schemas, parameters, responses and security schemes they reference. What comes out is a valid, self-contained OpenAPI document.
- **Give a partner only their endpoints.** A project has as many variants as it has audiences, each at its own URL.
- **Merge the OpenAPI documents of several services into one.** Components that share a name but not a meaning are told apart, and you are shown what the merge did.
- **Serve OpenAPI 3.0 to a tool that cannot read 3.1.** Every variant of a 3.0 or 3.1 document is served in both versions, converted from what your API has. The reader picks one with the URL: `/v/acme/sdk/3.0.json`.
- **Point each environment at its own server.** A variant can state its own title, description and servers, for production, a sandbox or staging. A project can state them once for all of its variants.
- **Stay current without a build step.** The service keeps reading a URL you tell it to follow, keeps serving the last good copy when your API is down, and emails you when operations are added, changed or removed.
- **Keep internal APIs private.** A variant can be private, read with a user API key that opens that variant and nothing else. The service fetches a protected document with request headers you provide, stored encrypted.
- **Review the selection like code.** The whole project is one `openapi-proxy.yaml`. Your tools read the variants from localhost while you develop, and a deploy from CI uploads the documents your build wrote.

It works with anything that reads an OpenAPI document from a URL, such as Swagger UI, Redoc, Scalar, Mintlify, openapi-typescript or openapi-generator.

## How it works

```
consumer (docs site, SDK generator, curl)
        │  GET /v/pipe0/public-docs.json
        ▼
   openapi-proxy (one Cloudflare Worker and a D1 database)
        │  serves what it has stored
        ▲
   your OpenAPI documents: read from a URL every few minutes, or uploaded by `openapi-proxy deploy`
```

- A **project** is one API as its readers know it: one OpenAPI document, or several merged into one.
- A **variant** is a named selection of the project's operations, served at `/v/<project>/<variant>` as JSON or YAML, in OpenAPI 3.0 or 3.1, to anyone or to readers with a key.
- A **definition** says what a project is: its documents and its variants. It is what the app's editor saves, and it is the content of an `openapi-proxy.yaml`.
- A **workspace** is the people who share the projects.

## Get started

**Hosted, from a URL.** Sign in at [openapi-proxy.app](https://openapi-proxy.app), paste the URL of your OpenAPI document, pick operations, and copy the variant's URL. It is free for 3 projects and 15 variants.

**Hosted, from your repository.** Run `npx @pipe0/openapi-proxy init <url or file>` next to your code and follow [In your repository](https://openapi-proxy.app/docs/in-your-repository). The [`examples`](examples) folder has three definition files to start from.

**On your own Cloudflare account.** Click **Deploy to Cloudflare** above. [Self-hosting](https://openapi-proxy.app/docs/self-hosting) covers the secrets, sign-in, email and limits. A definition file names such an instance with `instance: https://proxy.example.com`.

**On your machine.**

```sh
git clone https://github.com/pipe-0/openapi-proxy && cd openapi-proxy
pnpm install
cp .env.example .env     # sign in with the admin password: admin
pnpm dev                 # http://localhost:7732, no Cloudflare account needed
```

## Documentation

|                                                                                     |                                                                                                                                                 |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| [Start here](https://openapi-proxy.app/docs)                                        | The two ways to use it, and which guide is yours                                                                                                |
| [From a URL](https://openapi-proxy.app/docs/from-a-url)                             | A document at a URL, a few variants, kept current by the service                                                                                |
| [Several documents and audiences](https://openapi-proxy.app/docs/several-documents) | One API from the documents of several services, a variant per audience and environment                                                          |
| [In your repository](https://openapi-proxy.app/docs/in-your-repository)             | The selection in a file, variants on localhost, deploy from CI                                                                                  |
| [Configuration file](https://openapi-proxy.app/docs/configuration)                  | Every key of `openapi-proxy.yaml`                                                                                                               |
| [CLI](https://openapi-proxy.app/docs/cli)                                           | `init`, `dev`, `validate`, `operations`, `deploy`                                                                                               |
| [URLs, formats and versions](https://openapi-proxy.app/docs/urls)                   | What a consumer fetches, ETags and caching                                                                                                      |
| [Selecting operations](https://openapi-proxy.app/docs/selecting)                    | What a variant serves, today and when your API grows                                                                                            |
| [Merging rules](https://openapi-proxy.app/docs/merging)                             | What happens when two documents define the same thing                                                                                           |
| [Following a URL](https://openapi-proxy.app/docs/following-a-url)                   | How the service notices that your API changed, and the emails you get                                                                           |
| [Private variants and keys](https://openapi-proxy.app/docs/private-variants)        | Who may read what, and the two kinds of API key                                                                                                 |
| [Self-hosting](https://openapi-proxy.app/docs/self-hosting)                         | Running it on your own Cloudflare account, and [giving a workspace Pro with a query](https://openapi-proxy.app/docs/self-hosting#selling-plans) |

Every instance serves the same pages under `/docs`, each also as Markdown (`/docs/<page>.md`, listed in `/llms.txt`). Their source is in [`src/web/content/docs`](src/web/content/docs).

## The engine: @openapi-proxy/core

The filter engine is a separate MIT-licensed package in [`packages/core`](packages/core), with one dependency (`yaml`) and no I/O. The Worker, the browser preview and the command line tool run the same code. It is not published to npm; to filter, merge and convert OpenAPI documents in a pipeline of your own, take it from this repository:

```ts
import { assembleDocument, buildVariant, parseSpec, serialize } from "@openapi-proxy/core";

const { doc } = assembleDocument([
  { name: "Core API", doc: parseSpec(coreText).doc },
  { name: "Billing API", doc: parseSpec(billingText).doc, pathPrefix: "/billing" },
]);
const variant = buildVariant(doc, {
  selection: { include: { tags: ["public"] }, exclude: { operations: ["POST /v1/books/import"] } },
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

The repository root is the deployable app: `src/server` is what the app talks to, the served documents and the timer that checks followed URLs, and `src/web` is the Worker's entry and every page (React on TanStack Start). [`packages/cli`](packages/cli) is the command line tool, published to npm as `@pipe0/openapi-proxy`, and [`packages/editor`](packages/editor) is the variant editor that the app and `openapi-proxy dev` both show. To change it, read [CONTRIBUTING.md](CONTRIBUTING.md), [ARCHITECTURE.md](ARCHITECTURE.md), [docs/flows.md](docs/flows.md) for the interaction design, [docs/design.md](docs/design.md) for the design system, and [SECURITY.md](SECURITY.md).

## License

- [`packages/core`](packages/core/LICENSE), [`packages/cli`](packages/cli/LICENSE) and [`packages/editor`](packages/editor/LICENSE): **MIT**
- Everything else: **[FSL-1.1-MIT](LICENSE.md)**. Free to use, self-host and modify. You may not offer it as a competing hosted service. Each release becomes MIT two years after it is published.
