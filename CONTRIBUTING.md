# Contributing

Thanks for wanting to improve openapi-proxy.

## Setup

Tool versions are pinned in `mise.toml`. With [mise](https://mise.jdx.dev) installed, `mise install` gives you the right Node and pnpm. Otherwise any Node 22.18+ and pnpm 11 will do.

```sh
pnpm install
cp .env.example .env
pnpm dev
```

`pnpm dev` runs Vite with the Worker inside workerd and a local D1 database. No Cloudflare account is needed. Sign in at http://localhost:7732 with the password `admin`.

To try Google sign-in locally, put a client ID and secret into `.env` and register `http://localhost:7732/api/auth/callback/google` as a redirect URI of that client. The password works on any port (`PORT=3000 pnpm dev`); Google only on the registered one.

## Layout

| Path              | What lives there                                                                                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/core`   | The engine: merge, select and convert OpenAPI documents, and the definition format. Pure functions, no I/O, one dependency (`yaml`). MIT. Not published to npm: it is used from this repository. |
| `packages/cli`    | The command line tool, published to npm as `@pipe0/openapi-proxy`: `init`, `dev`, `validate`, `operations`, `deploy`. `page/` is the page that `dev` serves. MIT.                                |
| `packages/editor` | The variant editor and the primitives it is drawn with (`src/ui`), shown by the app and by `openapi-proxy dev`. MIT, not published.                                                              |
| `examples`        | Three definition files that run as they are. The docs show them, and the tests check them.                                                                                                       |
| `src/server`      | Everything that is not a page (Hono): sign-in (better-auth), workspaces, applying a definition, fetching sources, serving variants, the timer, email.                                            |
| `src/web`         | The Worker's entry (`server.ts`) and every page (React on TanStack Start).                                                                                                                       |
| `src/web/routes`  | The route tree: `_site` is rendered on the server, `_client` in the browser. Files here are thin.                                                                                                |
| `src/web/pages`   | The screens of the app. `src/web/site` is the landing page and blog, `src/web/content` the posts and the docs.                                                                                   |
| `src/shared`      | What server and web must agree on: the plans and their limits, the kinds of key.                                                                                                                 |
| `migrations`      | D1 schema, generated from `src/server/db/schema.ts` with `pnpm db:generate`.                                                                                                                     |
| `test`            | Worker integration tests. They run inside workerd against a real local D1.                                                                                                                       |
| `e2e`             | The product journeys in a browser, plus the local fixture server they run against.                                                                                                               |

The app and the command line tool import `@openapi-proxy/core` and the editor straight from their TypeScript source, so there is no build step between editing either and seeing the result in the app. The command line tool is built (`pnpm --filter @pipe0/openapi-proxy build`) into one file with nothing to install beside it; the browser journeys build it themselves and run what people will install.

To add a screen to the app, create a file under `src/web/routes/_client/_app/` that points at a component in `src/web/pages/`. To add a public, server-rendered page, create it under `src/web/routes/_site/` and add its path to `isSitePath` in `src/web/server.ts`. `src/web/routeTree.gen.ts` is generated; commit it.

## Working on the engine

`packages/core` is laid out as the pipeline a document goes through; its [README](packages/core/README.md) has the map. Three things to know:

- **A transform is a pure function** from documents to a document. It never changes its input, and it shares what it does not touch.
- **A version conversion is a list of steps** in `src/transforms/convert`. To support one more difference between two versions, add a step: a name that says what it does, a few lines, and a row in the table of `test/convert.test.ts`. If something cannot be expressed in the target version, remove it and `report` it.
- **Schemas are found by where they stand**, through `mapSchemas` in `src/document/schemas.ts`. Do not search a document for keys: a property can be named `nullable`, and an example can contain anything.

## Working on the definition format

The format of an `openapi-proxy.yaml` is described once, in `packages/core/src/definition/format.ts`. The validator, its messages and the JSON Schema that editors use all come from that description. To add a key:

1. Add it to the description, and to the types next to it.
2. Run `pnpm schema`. It writes `public/schema/definition.v1.json`, which the command line tool copies into its package when it is built. A test fails while the file is stale.
3. Describe it in `src/web/content/docs/configuration.mdx`. A test fails while the reference misses a key the validator knows.
4. Store it: a column in `src/server/db/schema.ts`, and both directions in `src/server/definition-rows.ts`, where a test holds the round trip to be lossless.

A key that changes what a variant serves has to be part of `effectiveVariant`, because the hash of its result is what a variant's ETag is made from.

## Working on the command line tool

```sh
pnpm --filter @pipe0/openapi-proxy build
node packages/cli/dist/cli.js dev --config examples/several-audiences/openapi-proxy.yaml
```

Everything it needs is bundled, so its `package.json` has development dependencies only. What it prints is part of the docs: the pages show commands with the output to expect. The repository guide and the CLI reference are held to what the tool prints for the example they use: `packages/cli/test/docs.test.ts` compares `init` and `validate`, and `e2e/repository.spec.ts` compares `dev` and a real deploy. Change the output and the pages together.

What it bundles is listed with its licenses in `THIRD-PARTY-NOTICES.txt`, one per bundle, written by the build ([`notices.ts`](packages/cli/notices.ts)) from the modules that went in. A stylesheet or font that a stylesheet brings in is not a module: name its package in `vite.page.config.ts`.

## Checks

CI runs all of these on every pull request:

```sh
pnpm lint          # biome: formatting and lint
pnpm typecheck     # the engine, the Worker, the UI, and the tooling
pnpm test          # engine unit tests + Worker integration tests
pnpm build
pnpm test:e2e      # needs `pnpm exec playwright install chromium` once
```

`E2E_PREVIEW=1 pnpm test:e2e` runs the same journeys against the production build. It is the run that exercises the Content-Security-Policy, which the development server does not send. In CI that run is the one that counts; the run against the development server reports without failing the build, because a cold development server on a CI machine has lost clicks while compiling a page.

`pnpm check` runs the first three.

### How things are tested

- **Engine guarantees are invariants, not examples.** Self-contained output, preserved key order, untouched input and idempotence are asserted across every fixture and a set of generated selections. Selection editing is checked against a simple model over hundreds of random edits. If you add a capability, add a case that would break without it.
- **"Valid" is judged by someone else.** Outputs are checked with `@scalar/openapi-parser`, a dev dependency that never ships, so validity is not just our own opinion.
- **Worker tests exercise real behaviour.** They call the Worker's `fetch` handler, wait for everything it scheduled with `waitUntil`, and stub only the outside world: the source servers, Google's token endpoint and the email provider. Sign-in runs through better-auth for real. See `test/harness.ts`.
- **Promises are tests.** "No request for a variant makes the service fetch anything", "a change is emailed once, whoever notices it", "someone removed from a workspace loses it with their next request": each is a test, named after what it holds (`test/check.test.ts`, `test/notifications.test.ts`, `test/workspace.test.ts`).
- **Localhost and the service serve the same bytes.** A browser journey deploys an example with the built command line tool, then fetches every variant in every format and version from `openapi-proxy dev` and from the app, and compares.
- **The package is tested as it is installed.** `pnpm --filter @pipe0/openapi-proxy test:packed` packs it the way a release does, installs the tarball into an empty folder outside the repository, and runs `init`, `validate` and `dev` there. CI runs it a second time with the oldest Node the package says it supports.
- **The end-to-end suite is hermetic.** It starts a fixture server that plays "your backend", a fresh local database and its own secrets, so it needs no network, ignores your `.env`, and gives the same result every time.

## Working on the interface

Read [docs/design.md](docs/design.md) first; it is short. The rules that get broken most easily: one solid button per screen, status as a word with nothing in front, no raw colors in components (use the tokens), monospace only for paths and documents, and never all caps.

Primitives come from shadcn (`pnpm dlx shadcn@latest add <name>`, then `pnpm lint:fix`). The ones the editor is drawn with live in `packages/editor/src/ui`, the rest in `src/web/components/ui`. Everything else in `src/web/components` and `packages/editor/src/components` is ours. A component belongs in the editor package when `openapi-proxy dev` shows it too; it then takes what differs between the two hosts as props, and knows neither the router nor the API.

Look at what you changed, in both color schemes:

```sh
SCREENSHOTS_DIR=/tmp/shots pnpm test:e2e
```

That is also how the README and landing page images are made: `docs/editor-*.png` and `public/site/editor-*.png` are `04-editor-*.png` from that run.

## Writing for the blog

Posts are MDX files in `src/web/content/blog`, with `title`, `description` and `date` in their front matter. A post with `draft: true` shows up while developing and nowhere in a production build; remove the flag to publish.

## Changing the schema

Edit `src/server/db/schema.ts`, run `pnpm db:generate`, commit the new file in `migrations/`. Migrations are applied by `pnpm dev` locally and by `pnpm run deploy` remotely. Every table that holds customer data must be reachable from an organization, and every query on it must filter by one (see [ARCHITECTURE.md](ARCHITECTURE.md)).

Three rules, because a push to `main` applies migrations to the live database (see [Deploying](#deploying)):

- **A migration is a new file.** Files in `migrations/` that have been deployed are never edited, renamed or folded together: the database remembers them by name and will not run them again. CI fails when the schema has a change that no file carries.
- **A migration has to work with the code that is live when it runs.** The database is migrated first and the Worker is replaced a few seconds later, so for that moment the previous version runs on the new schema. Add tables and columns in one release, and remove what is no longer used in a later one.
- **A new column on a table that has rows needs a default, or allows null.**

## Deploying

`pnpm run deploy` builds for one deployment, applies the migrations its database does not have yet, and replaces the Worker, in that order. A migration that fails is rolled back by D1, the command stops, and the Worker that is live stays as it is. Secrets set with `wrangler secret put` are kept across deploys.

From your machine it reads `.env.deploy` (see [`vite.config.ts`](vite.config.ts)). From GitHub it runs as the last job of [CI](.github/workflows/ci.yml): on a push to `main`, after the checks and the browser journeys against the production build passed, in a repository that has the variable `OPENAPI_PROXY_D1_DATABASE_ID`. Only the newest commit on `main` deploys: a run that is started again after `main` moved on skips the deploy, so older code never replaces newer. The settings and the two secrets it needs are listed on the [Self-hosting](src/web/content/docs/self-hosting.mdx) page of the docs.

If a deploy goes wrong after its migration ran, D1 keeps every minute of the last 30 days (7 on the free plan): `wrangler d1 time-travel restore openapi-proxy --timestamp=<unix time>` puts the database back, and `wrangler rollback` the Worker.

`src/server/db/auth-schema.ts` is generated by better-auth's CLI and then extended in three marked places; the command and the list are in its header. Carry the additions over when you regenerate it.

## Releasing the command line tool

`@pipe0/openapi-proxy` is versioned and published with [Changesets](https://changesets.dev), by [`release.yml`](.github/workflows/release.yml). Nobody edits its version by hand.

1. **A change that users of the tool will notice comes with a changeset.** `pnpm changeset` asks what changed. Without the questions: `pnpm changeset --patch @pipe0/openapi-proxy -m "What changed, for someone who uses the tool"`. It writes a small file into `.changeset/`; commit it with the change. `--patch` is for a fix, `--minor` for something new and, before 1.0, for a change that breaks something.
2. **A push to `main` with changesets opens the pull request "Version Packages"**, or updates it. It turns the changesets into the next version and into `packages/cli/CHANGELOG.md`.
3. **Merging that pull request publishes.** The workflow runs the tests of the engine and the tool and the packed-artifact test, packs the tool, publishes it to npm, tags the commit `@pipe0/openapi-proxy@<version>` and writes a GitHub release.

The tool bundles the engine and the editor. A change in `packages/core` or `packages/editor` that the tool's users notice needs a changeset too, named for `@pipe0/openapi-proxy`: nothing works that out for you. A change to the app or the service alone needs none.

No npm token is stored anywhere. npm trusts the workflow by its file name (trusted publishing, in the package's settings on npmjs.com), so the file has to stay `.github/workflows/release.yml`. Only `@pipe0/openapi-proxy` is published: every other package in the workspace says `"private": true`, and a new one has to say so as well, or the workflow tries to publish it.

Pull requests opened by a workflow do not start other workflows, so CI does not run on "Version Packages". That pull request only changes the version and the changelog, and the release workflow tests the tool before it publishes.

The app and the tool are released separately. A push to `main` deploys the service; the tool is published when its version changes. What a tool of one version may send to a service of another is the definition format, which has a version of its own (`version: 1` in the file).

## Changing the engine's output

If a change alters the bytes `buildVariant` or `serialize` produce for the same input, bump `TRANSFORM_VERSION` in `packages/core/src/types.ts`. It is part of every served ETag, so deployments drop their stored output and re-render after upgrading.

## Style

Conventional-ish commit subjects (`feat:`, `fix:`, `docs:`). Keep pull requests focused and describe the change in behaviour a user would notice. In user-facing text, write plainly: short sentences, no decoration.
