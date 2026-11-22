# Architecture

## Shape

One Cloudflare Worker, one D1 database. The Worker's entry is [`src/web/server.ts`](src/web/server.ts), and it does five things:

```
consumer ── GET /v/<project>/<variant> ──▶ src/server/serve.ts ──▶ D1
                                                 │
app      ── /api/* ──▶ session or token ──▶ src/server/routes/* ──▶ D1
agent    ── /mcp ──▶ token ──▶ src/server/mcp.ts ──▶ the same routes
                                                 │
cron     ── hourly ──▶ src/server/scheduled.ts ──┴──▶ the source document (src/server/upstream.ts)

browser  ── every page ──▶ TanStack Start (src/web)
```

- `/v/*` is public, unauthenticated and cacheable. It never writes anything a consumer could observe, and it does not fail once a project has been fetched.
- `/api/*` is the API behind a session or an API token. `/api/auth/*` belongs to better-auth, including the redirect URI registered with Google (`/api/auth/callback/google`).
- `/mcp` is a Model Context Protocol endpoint that offers the API as tools.
- The cron trigger checks sources that no reader has caused a check of lately.
- Pages are rendered by TanStack Start. The app (everything behind sign-in) is rendered in the browser; the server sends its shell. The landing page and the blog are rendered on the server, and only exist when `PUBLIC_SITE` is on.

`/v`, `/api` and `/mcp` are a Hono app ([`src/server/index.ts`](src/server/index.ts)) that knows nothing about pages, which is why the tests can call it directly.

All filtering lives in [`@openapi-proxy/core`](packages/core), a pure package with no I/O. The Worker and the browser preview run the same code, which is why the preview is exact rather than an estimate.

## Data model

```
user ── member ── organization ─┬─ projects ─┬─ sources            each document: where it is, its last good copy
  (exactly one)        │        │            └─ variants ── variant_outputs   rendered documents, per format
                       │        ├─ invitation
                       │        └─ api_tokens
                       └─ plan
```

| Table                                        | Holds                                                                                                                                                                                                    |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user`, `session`, `account`, `verification` | better-auth's: who people are and how they signed in.                                                                                                                                                    |
| `organization`, `member`, `invitation`       | better-auth's organization tables: the workspace, who is in it, who was asked to join. Extended with a plan and a notification preference.                                                               |
| `api_tokens`                                 | Tokens for scripts and agents, as SHA-256 hashes. A token acts as the person who made it, for as long as they are in the workspace.                                                                      |
| `projects`                                   | One API as its readers know it: what is true of its assembled document (its operations with a fingerprint each, the hash every ETag derives from, what merging did) and the state of keeping it current. |
| `sources`                                    | One OpenAPI document of a project: its URL, how to fetch it, what the last fetch found, and its last good copy (gzip + base64). Ordered; the first is the main one.                                      |
| `variants`                                   | A selection (`mode`, `operations`, `tags`), the OpenAPI version to serve it in, its slug, and the bookkeeping for drift.                                                                                 |
| `released_slugs`                             | Project slugs given up by a rename or a deletion, held for the workspace that had them for 90 days, so a public URL cannot be taken over by someone else the moment it is free.                          |
| `variant_outputs`                            | The rendered document for a variant in one format, valid while its `etag` matches.                                                                                                                       |

Project slugs are unique across the deployment, variant slugs within their project. That makes `/v/<project>/<variant>` a complete address: a public URL never has to name a workspace, and stays the same if the workspace is renamed.

The assembled document of a project is not stored. It is what the sources give when put together, and it is put together where it is needed: when a variant is rendered (once per change, then stored as output) and when the editor asks for it.

## Identity and tenancy

Everything about who is asking lives in [`src/server/auth.ts`](src/server/auth.ts).

- **Sessions and users are better-auth's**, on D1 through its Drizzle adapter. Google is the sign-in method. `ADMIN_PASSWORD` adds a second door, a single built-in admin, as a small better-auth plugin: it produces an ordinary session for an ordinary user, so nothing downstream can tell the two apart.
- **A person belongs to exactly one workspace.** It is the one they were invited into, or one of their own, created the first time it is needed. The rule is a unique index on `member.user_id`, so it holds whatever the code does. Projects belong to workspaces, never to people.
- **Membership is read on every request, not taken from the session.** A session lasts for weeks; membership can end this minute. `requireSession` looks the member row up, puts `organizationId` and `role` on the request context, and every query in `src/server/routes` filters by that organization. Tests sign in two people and check that neither can list, read, change, delete or take over anything of the other's, and that someone removed from a workspace loses it on their next request with the same cookie.
- **Joining means moving.** Accepting an invitation takes a person out of the workspace they are in and into the new one, in one transaction. It is refused if that would leave projects behind, and for any address other than the invited one.
- **The allow list** (`ALLOWED_EMAILS`) is checked when an account is created, on every Google sign-in against the email Google reports at that moment, and on every request, for sessions and tokens alike. A pending invitation counts as being on the list, which is how a closed instance grows, and a member of someone's workspace is let in by its owner. For everyone on the list, and on an instance without one, the per-request check reads nothing.
- **better-auth's own organization endpoints are not reachable.** They can create organizations, switch between them and accept invitations without knowing the one-workspace rule, so `/api/auth/organization/*` answers 404 and [`routes/workspace.ts`](src/server/routes/workspace.ts) is the only way to change who is in what.

**API tokens** are the second way a request gets its principal. `requireSession` is the one place that decides who is asking, by either door:

- a session cookie, checked for CSRF as before;
- `Authorization: Bearer oap_...`. Only the token's SHA-256 is stored. A request that carries this header is authenticated by the token alone, its cookies are not read, and the CSRF check (which is about cookies) does not apply to it. A token acts as the person who made it and is looked up together with their membership, so it stops working the moment they leave the workspace, and it is deleted when they do. A token reaches projects and variants. The routes that decide who is in a workspace and what may act for it (members, invitations, tokens) are behind `sessionOnly`: if a token could invite someone or make another token, revoking it would not end the access it gave.

Route handlers cannot tell the two doors apart, except through `via` where it matters.

Roles are deliberately two: the owner (who created the workspace) can remove people; everyone can invite, and can leave.

The auth instance is built per request, because its configuration (the database binding, the secrets, the request's own origin as base URL) only exists per request on Workers.

## Plans

[`src/shared/plans.ts`](src/shared/plans.ts) defines what a workspace may do: how many projects (OpenAPI documents) and how many variants. The server enforces it and the web app and landing page explain it from the same numbers.

- Plans exist only where the operator turns them on with `DEFAULT_PLAN=free`. A self-hosted instance leaves it unset, and every workspace is on Pro.
- A workspace's own plan (`organization.plan`) overrides the default. There is no checkout: putting a workspace on Pro is `UPDATE organization SET plan = 'pro' WHERE id = ...`.
- Limits apply when something is created, never to serving.
- A limit is checked after the insert, by position ([`limits.ts`](src/server/limits.ts)): a row is within a limit of N if it is one of the first N of its kind in the order the database stored them, and whoever is later takes their row back out. Counting first and inserting afterwards would let requests that arrive together all pass. The invitation and token caps work the same way.
- The free limits are set from what hosting costs. Per workspace that is mostly storage, a compressed copy of each source and of each rendered variant, plus one check per source per interval, of which a check against an unchanged source parses nothing. Three documents and fifteen variants stay well inside a few megabytes and a few hundred checks a day.

## Noticing changes

A check that finds a different document compares the old and new operation lists (`diffOperations` in [`src/server/notify.ts`](src/server/notify.ts)): added, removed, and changed.

"Changed" needs more than comparing operation objects, because an operation mostly changes through a schema it uses. `fingerprintOperations` in the engine gives each operation one hash over its own definition, what its path item shares, the document's default security, and every component it reaches, however indirectly, with key order ignored. Fingerprints are stored with the operation index, so the comparison costs nothing at check time.

The result goes out by email to the members of the workspace, each at their own setting: nothing, new operations plus whatever touches what a variant serves (the default), or everything in the source. Every check, whoever starts it, goes through `checkProject`, and the write that stores a new document is conditional on the project still being where the check found it. Of two checks that overlap, one stores the document and reports; the other sees there is nothing left to do.

A change is only noticed when something looks. Readers cause checks, but a docs build may not come by for days, and the email "there is a new operation that is not in your public docs" is worth most before that build. So the Worker's cron trigger checks, once an hour, every project that has a variant and has not been looked at for 50 minutes.

The run takes projects in the order they were last looked at, whether that look succeeded or not, so projects whose sources are down take their turn like everyone else and cannot keep the run from reaching the rest. It does as much as the platform lets one invocation do and stops there: on Cloudflare's free plan that is 50 requests out and 50 database queries, a handful of projects an hour, and on a paid plan the 40 projects a run takes at most. What it did not reach is first in line the next hour. Running into the platform's ceiling is never recorded as a source's failure.

Email is optional, and goes through Cloudflare Email Sending when it is on ([`src/server/email.ts`](src/server/email.ts)). Without `CLOUDFLARE_EMAIL_TOKEN`, `CLOUDFLARE_EMAIL_ACCOUNT_ID` and `EMAIL_FROM` nothing is sent and nothing else changes; an invitation is then a link to pass on.

## Serving a variant

`GET /v/pipe0/public-docs.json`, in order:

1. One query resolves project and variant by slug and reads only what serving needs (not the operation index, which can be large).
2. If the copy is older than the project's check interval (or than the requester's own `Cache-Control: no-cache` / `max-age`, floored at 10 seconds), the request tries to **claim** the check with a single conditional `UPDATE`. Exactly one concurrent request wins.
   - The winner checks the source and answers with the result. It waits at most 5 seconds; a slower check carries on under `waitUntil` and the answer comes from the copy.
   - The others wait for the winner by watching the project row, since the winner usually runs in another isolate. Exception: a copy that crossed its interval less than 30 seconds ago is as good as it was a moment earlier, so they are answered from it at once. That keeps a busy variant from stalling once per interval.
   - A source already known to be failing is never waited on. One request per 30 seconds retries in the background.
3. The ETag is a hash of the engine version, the source body hash, the variant, its selection version and the format. Nothing else can change the bytes, so nothing else changes the ETag. A matching `If-None-Match` ends here with a 304.
4. Otherwise the body comes from the first of: the edge cache (custom domains), the `variant_outputs` row with this ETag, or a fresh render that is then stored. A render reads the document and the hash that describes it in one query, and the response carries the ETag of what was actually rendered, so a refresh landing mid-request cannot pair one document with another's validator.

Why not simply serve the copy and refresh afterwards? Because the readers of an OpenAPI document are mostly builds that run a few times a day. With stale-while-revalidate and no bound, each of them would receive the document as of the previous build.

Rendering (parse the source, filter, serialize) costs real CPU on large documents, YAML most of all. Storing the result means it happens once per change per format rather than once per request or per edge location.

## Keeping a project current

Two modules: [`upstream.ts`](src/server/upstream.ts) talks to one source, [`assemble.ts`](src/server/assemble.ts) puts a project's sources together and stores the result.

A round of checks looks at every source of the project, in parallel. For each, `checkSource` tries the cheapest check first and stops when one settles it:

1. **Version endpoint**, if configured: `HEAD`, then `GET`; a version header, a small JSON body, or plain text. The same value as last time means the document is not downloaded.
2. **Conditional GET** with the validators the source sent. A 304 transfers nothing.
3. **Download** and hash. The same bytes as the stored copy end here, without the document being parsed: for a source that sends no validators this is the usual outcome, and parsing is most of what a check would cost.
4. **Parse** and validate.

If any source has a new document, `refreshProject` assembles all of them again (the new documents, and the stored copies of the others), indexes and fingerprints the result, and writes it in one D1 batch: the project's new hash and operation list, and each new document.

Details that matter:

- A version is only ever recorded together with a document that was fetched after observing it, so the pair cannot disagree in the dangerous direction.
- The version shortcut is trusted for 24 hours at a time. Many APIs change without bumping a version; the daily comparison bounds the damage. If it finds a new document behind an unchanged version (and the version still has not moved when asked again, which rules out a deploy landing between the two requests), the endpoint is marked as unreliable and skipped until someone saves it again.
- The project's hash covers every source's bytes, name and path prefix: everything the assembled document depends on. Every ETag derives from it, and it is written in the same batch as the documents it describes.
- Everything a check writes is conditional on the project still being at the hash the check found it at (`projectAt`). Of two checks that overlap, one stores and reports; the other finds nothing left to do. A check that overlaps with an edit to the sources writes nothing: what it looked at is no longer what the project is made of.
- A source that fails keeps its last good copy in the merge. The others are still updated. The failure is recorded on the source and on the project, and the next attempt waits 30 seconds.
- New documents that cannot be put together (too large, for instance) are not stored: the project keeps serving what it had and says why.
- Requests go out with a timeout, the body is read with a size cap, and redirects are followed by hand so that a source's credentials are only sent to the origin they were configured for.
- The document itself gets 25 seconds. Frameworks build it on the first request after a deploy, and for a large API that can take ten seconds or more; the moment after a deploy is exactly when a check matters.

Adding, removing or reordering a source, or changing its name or path prefix, goes through `editSources` in [`routes/projects.ts`](src/server/routes/projects.ts): the project is assembled again from the stored copies, and its new description and the change to its sources are written in one transaction, only if the project is still at the hash the edit read. If a check got there first, nothing is written and the edit is planned again from what is stored now. Whichever comes first, a project's operations and hash never describe documents it does not have. A document that cannot be merged is refused before anything is written.

## The engine

Everything that happens to a document is in [`packages/core`](packages/core), laid out as the pipeline it is:

```
text ─▶ parse ─▶ [convert] ─▶ merge ─▶ select ─▶ [convert] ─▶ serialize ─▶ text
                 only if sources          only if the variant
                 differ in version        asks for another version
```

`assembleDocument(sources)` is the first half, `buildVariant(document, { selection, version })` the second. Nothing is converted that does not have to be: one source served in its own version goes through unchanged, byte for byte.

**Merging** (`transforms/merge.ts`) follows fixed rules, because it runs unattended whenever a source changes. The first document is the main one and supplies everything at the top level. What holds throughout is that an operation means in the merged document what it meant in its own: it keeps its schemas, under whatever name, and the security its document gave it, written onto the operation where that was a document-wide default. An operation defined twice is kept from the earlier document. For a component name used twice, the two are compared by meaning, a digest of the component and everything it references: equal ones are shared, different ones are renamed after their document, with every `$ref`, discriminator and security requirement following. The walk that does this covers the whole document and knows the two kinds of places where a key is not a keyword: maps of names (a response called `default`) and literal data (an example that happens to contain `$ref`). What was done comes back as notes, which the project stores and the Sources page shows.

**Selecting** (`transforms/select.ts`):

1. Index every operation under `paths` and `webhooks` (including OpenAPI 3.2's `query` and `additionalOperations`, and path items behind a `$ref`) and resolve the selection to a set of operation keys.
2. Drop unselected operations. A path item left with none is dropped too.
3. Find `$ref`s that pointed into something just removed (bundlers emit refs like `#/paths/~1users/get/...`) and replace each with a copy of its target.
4. Compute what the remaining document references, transitively, and prune the standard component groups to that. Unknown groups and vendor extensions pass through untouched and count as references themselves.
5. Drop tags and `x-tagGroups` entries that no kept operation uses.

**Converting** (`transforms/convert/`) between 3.0 and 3.1 is a list of small named steps per direction, each a few lines with its own test (`nullable becomes the type null`, `const becomes a one-value enum`). Steps are applied to schemas found by where they stand in the document (`document/schemas.ts`), never by what they look like, so a property named `nullable` is left alone. Going down, whatever 3.0 cannot express is removed and reported by name. Selecting happens first, so only what a variant serves is converted and reported.

The input is never mutated and untouched subtrees are shared, not copied.

A selection is stored as "what matches" plus a mode. People think in outcomes instead: is this served, and what happens to what comes later. `selection/edit.ts` translates between the two, so the UI can offer one meaning for a checkbox and still store rules.

## The web app

React on TanStack Start, with TanStack Query, Tailwind, and shadcn's Base UI components restyled through one set of tokens and materials; see [docs/design.md](docs/design.md).

```
src/web/routes/        the route tree, one thin file per URL
  _site/               server-rendered: /, /blog, /blog/<slug>
  _client/             rendered in the browser (ssr: false): /login, /invite/<id>
    _app/              behind sign-in, inside the app shell: /app, /connect, /workspace, /p/...
src/web/pages/         the screens of the app
src/web/site/          the landing page and the blog's pages
src/web/content/blog/  posts, as MDX (compiled by Fumadocs)
src/web/components/    the design system and the app's own components
```

- **Two kinds of route, chosen by directory.** Everything under `_client` inherits `ssr: false`: the server answers with the shell and the browser does the rest, exactly like a single-page app, including the sign-in guard. Everything under `_site` is rendered on the server per request, so it is readable without JavaScript and by crawlers.
- **The site switch is in the Worker entry.** With `PUBLIC_SITE` off, `/` redirects to `/app` and `/blog` does not exist. With it on, `/` is the landing page for visitors and still redirects for anyone who carries a session cookie.
- **Security headers are set by the root route**, because pages now come from the Worker and `public/_headers` only reaches static files. Start needs two inline scripts to hydrate a page; they carry a nonce that is generated per request, so the policy stays `script-src 'self' 'nonce-...'` with no `unsafe-inline`.
- **The editor loads on demand**, since it carries the filter engine and the YAML library.
- **Blog posts with `draft: true`** are rendered while developing and are neither listed nor reachable in a production build.

## API and MCP

There is one API. The app uses it with a session, a script with a token, and an agent through `/mcp`.

[`src/server/mcp.ts`](src/server/mcp.ts) is a Model Context Protocol server over Streamable HTTP, stateless, in one file: JSON-RPC over `POST`, one JSON answer per request, no sessions or streams. It speaks the current revision (`2026-07-28`) and the earlier ones that open with a handshake. Each tool is a few lines that dispatch a request to the Hono app with the caller's token, so tenancy, plans and validation exist exactly once and a tool can never do what the API would refuse. Adding a tool is adding an entry to a table. The official MCP client drives it in the tests.

## Rate limiting

Counting is left to Cloudflare: the Worker has a [rate limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/), `API_RATE_LIMIT`, declared in `wrangler.jsonc` together with the budget (300 per minute). [`src/server/rate-limit.ts`](src/server/rate-limit.ts) decides the three things that are ours to decide:

- **For whom:** the key is the workspace. Ten tokens of one workspace share a budget; two workspaces behind one office address do not.
- **What is counted:** every authenticated request to the API, charged by one middleware right after `requireSession`. The MCP endpoint charges each request it receives, and its tools are charged again by the API they call.
- **What it costs:** one, or ten for the four routes that make the instance fetch from a source (marked `contactsSource` where they are defined). Outbound requests to a URL of the customer's choosing are the scarce thing, not requests to us.

If the binding is missing or fails, nothing is limited: a guard against abuse should not be able to take the API down. Unauthenticated routes are not counted here; that is the job of the network in front of the Worker.

## Toward a hosted product

In place: users, workspaces with several members, isolation enforced in every query, plans with limits, public URLs that need no tenant, customer secrets encrypted at rest, change notifications, API tokens, an MCP endpoint. What is not built, and where it attaches:

| Addition                 | Where it attaches                                                                                  |
| ------------------------ | -------------------------------------------------------------------------------------------------- |
| Billing                  | `organization.plan` is the one thing a Stripe webhook has to set; everything else already reads it |
| OAuth for MCP clients    | better-auth can act as the authorization server; `requireSession` gains a third door               |
| Swagger 2.0 sources      | One more conversion in `packages/core/src/transforms/convert`, run before a source is assembled    |
| Usage metering           | `serve.ts` has the variant id at the point a request is answered                                   |
| Teams inside a workspace | better-auth's organization plugin has them; nothing here assumes their absence                     |

## Custom domains

Not built. This is the design, and what is already in place for it.

**What a customer gets.** Their variants at an address of their own, `https://api-docs.acme.com/<project>/<variant>.json`: the same paths as today without the `/v`.

**How it would work.**

1. A `domains` table: hostname, organization, verification status, created at. A workspace adds a hostname in the app.
2. The customer points a CNAME at the service. Cloudflare for SaaS (custom hostnames on the operator's zone) issues the certificate and routes the traffic to this Worker; the app adds and removes hostnames through Cloudflare's API and shows the verification status.
3. The Worker entry, [`src/web/server.ts`](src/web/server.ts), checks the hostname before anything else. A known customer hostname gets only documents: `/<project>/<variant>` goes to `serveVariant` in [`serve.ts`](src/server/serve.ts), restricted to that workspace's projects, and everything else is a 404. No app, no sign-in and no `/api` is ever served on a customer's hostname, so their domain cannot be used to phish for sessions of the service.
4. [`urlPrefix`](src/server/public-url.ts) returns the customer's hostname for projects that have one, so every URL the app shows, copies and emails is the right one.

**What is already in place.** Nothing in the current design stands in the way:

- The app never builds a public URL. The API hands out `urlPrefix` for each project and `url` for each variant, from one function.
- Serving is a function of a project slug and a variant, callable from any route.
- Rendered documents and the edge cache are keyed by variant and ETag, not by hostname, so one variant served at two addresses shares its stored output.
- Sessions and the OAuth redirect belong to the service's own origin (`APP_URL`), never to the address a request came in on, once the hostname check in step 3 is in front.
- Project slugs are unique across the deployment. On a customer domain they would only need to be unique within the workspace, which the global rule already guarantees.

## Deploying

`pnpm run deploy` builds in Vite's "deploy" mode, applies D1 migrations to the remote database, and uploads the Worker. The repository carries no account-specific values: the database id, an optional custom domain and the settings of a public service (`DEFAULT_PLAN`, `PUBLIC_SITE`, `EMAIL_FROM`, ...) come from a gitignored `.env.deploy` (or the environment) and are merged into the Worker's configuration at build time, in [`vite.config.ts`](vite.config.ts). Secrets are never in that file; they are set with `wrangler secret put`. "Deploy to Cloudflare" does not need the file, because Cloudflare writes the id of the database it creates into `wrangler.jsonc` of the copy it makes.

## Storage notes

- Each source's document is stored gzip-compressed and base64-encoded in a D1 text column. OpenAPI JSON compresses 10 to 20 times, so the 2 MB row limit is far away; the 5 MB cap on a project's sources together comes from Worker memory and CPU instead, since the whole assembled document is in memory when a variant is rendered. R2 is the escape hatch if that ever needs to grow.
- Output is rendered lazily, on the first request after a change, not eagerly on refresh. A project with many variants therefore costs nothing until someone asks. Rendering runs the whole pipeline once (assemble, select, convert) and stores the result.
- Deleting a project cascades to its sources, its variants and their outputs through foreign keys.
