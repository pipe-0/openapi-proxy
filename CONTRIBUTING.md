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

| Path             | What lives there                                                                                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core`  | The engine: merge, select and convert OpenAPI documents. Pure functions, no I/O, one dependency (`yaml`). MIT. Not published to npm: it is used from this repository. |
| `src/server`     | Everything that is not a page (Hono): sign-in (better-auth), workspaces, fetching sources, the admin API, public serving, the hourly check, email.                    |
| `src/web`        | The Worker's entry (`server.ts`) and every page (React on TanStack Start).                                                                                            |
| `src/web/routes` | The route tree: `_site` is rendered on the server, `_client` in the browser. Files here are thin.                                                                     |
| `src/web/pages`  | The screens of the app. `src/web/site` is the landing page and blog, `src/web/content` the posts.                                                                     |
| `src/shared`     | What server and web must agree on: the plans and their limits.                                                                                                        |
| `migrations`     | D1 schema, generated from `src/server/db/schema.ts` with `pnpm db:generate`.                                                                                          |
| `test`           | Worker integration tests. They run inside workerd against a real local D1.                                                                                            |
| `e2e`            | The product journeys in a browser, plus the local fixture server they run against.                                                                                    |

The app imports `@openapi-proxy/core` straight from its TypeScript source, so there is no build step between editing the engine and seeing the result in the app.

To add a screen to the app, create a file under `src/web/routes/_client/_app/` that points at a component in `src/web/pages/`. To add a public, server-rendered page, create it under `src/web/routes/_site/` and add its path to `isSitePath` in `src/web/server.ts`. `src/web/routeTree.gen.ts` is generated; commit it.

## Working on the engine

`packages/core` is laid out as the pipeline a document goes through; its [README](packages/core/README.md) has the map. Three things to know:

- **A transform is a pure function** from documents to a document. It never changes its input, and it shares what it does not touch.
- **A version conversion is a list of steps** in `src/transforms/convert`. To support one more difference between two versions, add a step: a name that says what it does, a few lines, and a row in the table of `test/convert.test.ts`. If something cannot be expressed in the target version, remove it and `report` it.
- **Schemas are found by where they stand**, through `mapSchemas` in `src/document/schemas.ts`. Do not search a document for keys: a property can be named `nullable`, and an example can contain anything.

## Checks

CI runs all of these on every pull request:

```sh
pnpm lint          # biome: formatting and lint
pnpm typecheck     # the engine, the Worker, the UI, and the tooling
pnpm test          # engine unit tests + Worker integration tests
pnpm build
pnpm test:e2e      # needs `pnpm exec playwright install chromium` once
```

`E2E_PREVIEW=1 pnpm test:e2e` runs the same journeys against the production build. It is the run that exercises the Content-Security-Policy, which the development server does not send.

`pnpm check` runs the first three.

### How things are tested

- **Engine guarantees are invariants, not examples.** Self-contained output, preserved key order, untouched input and idempotence are asserted across every fixture and a set of generated selections. Selection editing is checked against a simple model over hundreds of random edits. If you add a capability, add a case that would break without it.
- **"Valid" is judged by someone else.** Outputs are checked with `@scalar/openapi-parser`, and the MCP endpoint is driven by the official MCP client. Both are dev dependencies that never ship, so validity is not just our own opinion.
- **Worker tests exercise real behaviour.** They call the Worker's `fetch` handler, wait for everything it scheduled with `waitUntil`, and stub only the outside world: the source servers, Google's token endpoint and the email provider. Sign-in runs through better-auth for real. See `test/harness.ts`.
- **Promises are tests.** "A reader never gets a copy older than the interval", "a change is emailed once, whoever notices it", "someone removed from a workspace loses it with their next request": each is a test with that sentence as its name.
- **The end-to-end suite is hermetic.** It starts a fixture server that plays "your backend", a fresh local database and its own secrets, so it needs no network, ignores your `.env`, and gives the same result every time.

## Working on the interface

Read [docs/design.md](docs/design.md) first; it is short. The rules that get broken most easily: one solid button per screen, status as a word with nothing in front, no raw colors in components (use the tokens), monospace only for paths and documents, and never all caps.

Primitives in `src/web/components/ui` come from shadcn (`pnpm dlx shadcn@latest add <name>`, then `pnpm lint:fix`). Everything else in `src/web/components` is ours.

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

From your machine it reads `.env.deploy` (see [`vite.config.ts`](vite.config.ts)). From GitHub it runs as the last job of [CI](.github/workflows/ci.yml): on a push to `main`, after the checks and the browser journeys passed, in a repository that has the variable `OPENAPI_PROXY_D1_DATABASE_ID`. The settings and the two secrets it needs are listed on the [Self-hosting](src/web/content/docs/self-hosting.mdx) page of the docs.

If a deploy goes wrong after its migration ran, D1 keeps every minute of the last 30 days (7 on the free plan): `wrangler d1 time-travel restore openapi-proxy --timestamp=<unix time>` puts the database back, and `wrangler rollback` the Worker.

`src/server/db/auth-schema.ts` is generated by better-auth's CLI and then extended in three marked places; the command and the list are in its header. Carry the additions over when you regenerate it.

## Changing the engine's output

If a change alters the bytes `applyVariant` or `serialize` produce for the same input, bump `TRANSFORM_VERSION` in `packages/core/src/types.ts`. It is part of every served ETag, so deployments drop their stored output and re-render after upgrading.

## Style

Conventional-ish commit subjects (`feat:`, `fix:`, `docs:`). Keep pull requests focused and describe the change in behaviour a user would notice. In user-facing text, write plainly: short sentences, no decoration.
