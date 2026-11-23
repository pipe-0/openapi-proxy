# Architecture

## Shape

One Cloudflare Worker, one D1 database, and a command line tool. The Worker's entry is [`src/web/server.ts`](src/web/server.ts), and it does four things:

```
consumer ── GET /v/<project>/<variant> ──▶ src/server/serve.ts ──▶ D1
                                                 │
app      ── /api/* ── session ───────────▶ src/server/routes/* ─▶ src/server/apply.ts ──▶ D1
pipeline ── PUT /api/projects/<slug> ── deploy API key ──────────▶        (the same)
                                                 │
cron     ── every 5 minutes ──▶ src/server/scheduled.ts ──┴──▶ followed sources (src/server/upstream.ts)

browser  ── every page ──▶ TanStack Start (src/web)
```

- `/v/*` serves variants. A public one is unauthenticated and cacheable; a private one is read with a user API key. It reads what is stored and nothing else: no request for a variant makes the service fetch anything, and it does not fail once a project has its documents.
- `/api/*` is what the app talks to, behind a session. `/api/auth/*` belongs to better-auth, including the redirect URI registered with Google (`/api/auth/callback/google`). One route also takes a deploy API key: `PUT /api/projects/<slug>`, where `openapi-proxy deploy` sends a definition. There is no other public API.
- The cron trigger is the only thing that looks at sources unasked.
- Pages are rendered by TanStack Start. The app (everything behind sign-in) is rendered in the browser; the server sends its shell. The landing page and the blog are rendered on the server, and only exist when `PUBLIC_SITE` is on.

`/v` and `/api` are a Hono app ([`src/server/index.ts`](src/server/index.ts)) that knows nothing about pages, which is why the tests can call it directly.

Everything that happens to a document lives in [`@openapi-proxy/core`](packages/core), a pure package with no I/O. The Worker, the browser preview and the command line tool run the same code, which is why the preview is exact and why localhost serves the same bytes as the service.

The packages:

| Package                              | What it is                                                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| [`packages/core`](packages/core)     | The engine: parse, merge, select, convert, serialize, and the definition format. MIT.                               |
| [`packages/editor`](packages/editor) | The variant editor as React components, shown by the app and by the command line tool. MIT, not published.          |
| [`packages/cli`](packages/cli)       | The command line tool, published as `@pipe0/openapi-proxy`: `init`, `dev`, `validate`, `operations`, `deploy`. MIT. |
| the root                             | The Worker and the app.                                                                                             |

## A project is its definition

A project is described by a **definition**: its documents (sources) and the variants served from them. It is the content of an `openapi-proxy.yaml` in a repository, and it is what the app's editor saves. There is one way to create or change a project, whoever does it: **apply a definition** ([`src/server/apply.ts`](src/server/apply.ts), `PUT /api/projects/<slug>`).

```
the app's editor ──┐
openapi-proxy deploy ──┼──▶ a whole definition (+ documents) ──▶ applyDefinition ──▶ rows
the local editor ──┘        (the last one writes a file instead)
```

The rows are the stored form of the definition ([`definition-rows.ts`](src/server/definition-rows.ts) maps both ways, and a test holds the round trip to be lossless), next to what the service has found out: the documents, their operations, the state of checks. Rows are kept, not replaced, so that a variant keeps its id from apply to apply: the keys that read it and its stored output hang on that id.

What an apply does, in order:

1. Validate the definition (the engine's validator) and read the documents that came with it.
2. Read the project by its slug. Refuse what is refused without writing: a slug of another workspace, a project that is deployed from a file and edited from the app without the switch, a save that started from an older revision (`ifRevision`; 0 means "there must be no such project").
3. Match sources to stored rows by name, then by address, and variants by slug.
4. Decide each source's document: the one that was uploaded, else the stored copy if the source is where it was, else a fetch if the source is followed, else the apply is refused (`document-missing`).
5. Assemble the documents again only if the set, the order, a name, a prefix or the bytes changed, and compare the operations with the ones before.
6. Work out each variant's `served_hash`: a hash of its selection and of the overrides it ends up with once the project's are filled in.
7. A dry run answers here, with what the real apply would answer.
8. Write, in one D1 batch. For an update, the first statement only matches while the project is still at the revision and the document hash that were read, and writes a token of its own (`projects.writer`); every other statement runs only where that token is. An apply that came too late therefore writes nothing at all, and starts over from what is there now, up to three times. For a new project the limits are part of the batch: a project that is one too many is taken out again before the transaction ends.

Two numbers say what a project is made of: `revision`, which counts applies, and `body_hash`, which changes when its documents do. A check moves the second and not the first, so a save in the app is not refused because the timer found a new document meanwhile.

A project remembers where its definition is edited (`managed_by`): in the app, or in a file. A deploy makes it the file's, whatever it was. The app then shows it read-only, with who deployed it last and from which commit, and one switch that makes it the app's again.

## Data model

```
user ── member ── organization ─┬─ projects ─┬─ sources            each document: where it comes from, the copy that is served from
  (exactly one)        │        │            └─ variants ── variant_outputs   rendered documents, per format and version
                       │        ├─ invitation
                       │        ├─ api_keys
                       │        └─ subscription      what it pays for, and until when
```

| Table                                        | Holds                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user`, `session`, `account`, `verification` | better-auth's: who people are and how they signed in.                                                                                                                                                                                                                                                            |
| `organization`, `member`, `invitation`       | better-auth's organization tables: the workspace, who is in it, who was asked to join. The workspace also says who may read a variant when nothing closer does (`default_visibility`).                                                                                                                           |
| `api_keys`                                   | Deploy API keys and user API keys, as SHA-256 hashes. `access` says which kind; a user API key may be for one variant (`variant_id`).                                                                                                                                                                            |
| `subscription`                               | What a workspace pays for: plan, status, the period it is paid for, whether it renews. The workspace's plan is read from it.                                                                                                                                                                                     |
| `project_notifications`                      | What each person wants to be emailed about, per project: nothing, what their variants serve, or everything. No row means the middle one.                                                                                                                                                                         |
| `projects`                                   | The definition's own keys (slug, name, visibility, overrides), where it is edited and who applied it last, its revision, what is true of its assembled document (its operations with a fingerprint each, the hash every ETag derives from, what merging did), and the state of keeping followed sources current. |
| `sources`                                    | One document of a project: its name, its `url` or `file`, whether it is followed, whether it is the main one, its path prefix, the request headers for fetching it (encrypted), and the copy that is served from (gzip + base64).                                                                                |
| `variants`                                   | A variant's entry in the definition (slug, name, icon, visibility, selection, overrides), its place among the others, and its `served_hash`.                                                                                                                                                                     |
| `released_slugs`                             | Project slugs given up by a deletion, held for the workspace that had them for 90 days, so a public URL cannot be taken over by someone else the moment it is free.                                                                                                                                              |
| `variant_outputs`                            | The rendered document for a variant in one format and version, or the reason it could not be rendered; valid while its `etag` matches.                                                                                                                                                                           |

Project slugs are unique across the deployment, variant slugs within their project. That makes `/v/<project>/<variant>` a complete address: a public URL never has to name a workspace, and stays the same if the workspace is renamed. A slug is the identity of a project in a definition, so it is never renamed.

The assembled document of a project is not stored. It is what the sources give when put together, and it is put together where it is needed: when a variant is rendered (once per change, then stored as output) and when the editor asks for it.

## Identity and tenancy

Everything about who is asking lives in [`src/server/auth.ts`](src/server/auth.ts).

- **Sessions and users are better-auth's**, on D1 through its Drizzle adapter. Google is the sign-in method. `ADMIN_PASSWORD` adds a second door, a single built-in admin, as a small better-auth plugin: it produces an ordinary session for an ordinary user, so nothing downstream can tell the two apart.
- **A person belongs to exactly one workspace.** It is the one they were invited into, or one of their own, created the first time it is needed. The rule is a unique index on `member.user_id`, so it holds whatever the code does. Projects belong to workspaces, never to people.
- **Membership is read on every request, not taken from the session.** A session lasts for weeks; membership can end this minute. `requireSession` looks the member row up, puts `organizationId` and `role` on the request context, and every query in `src/server/routes` filters by that organization. Tests sign in two people and check that neither can list, read, change, delete or take over anything of the other's, and that someone removed from a workspace loses it on their next request with the same cookie.
- **Joining means moving.** Accepting an invitation takes a person out of the workspace they are in and into the new one, in one transaction. It is refused if that would leave projects behind, and for any address other than the invited one.
- **The allow list** (`ALLOWED_EMAILS`) is checked when an account is created, on every Google sign-in against the email Google reports at that moment, and on every request, for sessions and keys alike. A pending invitation counts as being on the list, which is how a closed instance grows, and a member of someone's workspace is let in by its owner. For everyone on the list, and on an instance without one, the per-request check reads nothing.
- **better-auth's own organization endpoints are not reachable.** They can create organizations, switch between them and accept invitations without knowing the one-workspace rule, so `/api/auth/organization/*` answers 404 and [`routes/workspace.ts`](src/server/routes/workspace.ts) is the only way to change who is in what.

**API keys** come in two kinds ([`src/shared/access.ts`](src/shared/access.ts)), told apart by what they are for. Only a key's SHA-256 is stored. A request that carries `Authorization: Bearer oap_...` is authenticated by the key alone: its cookies are not read, and the CSRF check (which is about cookies) does not apply to it.

- A **deploy API key** belongs to the workspace. It is for a pipeline, and reaches exactly one route: `PUT /api/projects/<slug>`, which applies a definition. `requireSession` lets it through for that request and answers 403 for every other. Only the owner makes and revokes such keys, and one keeps working when whoever made it leaves. On an instance with an allow list it works for as long as the workspace's owner may sign in.
- A **user API key** belongs to the person who made it and reads private variants, all of the workspace's or one. It is looked up together with its maker's membership, so it stops working the moment they leave, and it is deleted when they do. It reaches nothing under `/api`.

What a key may do is decided in one function for each door (`requireSession` for the API, `reads` in [`keys.ts`](src/server/keys.ts) for a variant), so a narrower kind of key is one more value of `access` and one more line there. The routes that decide who is in a workspace and what may act for it (members, invitations, keys) take a person, never a key: if a key could invite someone or make another key, revoking it would not end the access it gave.

Roles are deliberately two: the owner (who created the workspace) can remove people; everyone can invite, and can leave.

The auth instance is built per request, because its configuration (the database binding, the secrets, the request's own origin as base URL) only exists per request on Workers.

## Plans

[`src/shared/plans.ts`](src/shared/plans.ts) defines what a workspace may do: how many projects (OpenAPI documents) and how many variants. The server enforces it and the web app and landing page explain it from the same numbers.

- Plans exist only where they are sold: on an instance that says where requests for one go (`CONTACT_EMAIL`). A self-hosted instance leaves it unset, and every workspace has everything. There is no setting for a default plan: without a subscription a workspace is on Free.
- **A workspace's plan is that of its subscription** ([`subscriptions`](src/server/db/schema.ts), read by `planOf` in [`plans.ts`](src/server/plans.ts)), while that is in force: its status says so, and the period it is paid for has not run out (one without an end runs until it is removed). A workspace has at most one row, and the row says what state it is in. The table has the shape of Stripe's subscription object, under the names better-auth's Stripe plugin uses (`referenceId`, `status`, `periodStart`, `periodEnd`, `cancelAtPeriodEnd`), so that a webhook or that plugin can keep the rows one day without the data moving.
- **Until there is a checkout, people do what Stripe would.** Under Workspace, Billing shows the plan, when it renews or ends, and how much of it is in use. The owner asks for Pro there (`POST /api/workspace/plan-request`): that makes the workspace's subscription `incomplete` and emails `CONTACT_EMAIL` who is asking, with the statement that gives Pro once it is paid. Asking to cancel marks it `cancelAtPeriodEnd` and sends the statement that removes it. The two statements (`giveProStatement` and `removePlanStatement` in [`plans.ts`](src/server/plans.ts)) name the workspace by the email address of anyone in it, can be run again, and are what whoever runs an instance uses to give or remove Pro without a request; the self-hosting page of the docs shows them. Whether a request is new is decided by the write that records it, so asking twice sends one email.
- Limits apply when something is created, never to serving.
- The limits on projects and variants are conditions of the write that an apply makes ([`apply.ts`](src/server/apply.ts)): a project that would be one too many is taken out again in the same transaction, and an update that adds variants only matches while they fit. Counting first and writing afterwards would let requests that arrive together all pass. The caps on invitations and keys are checked after the insert, by position ([`limits.ts`](src/server/limits.ts)), for the same reason.
- The free limits are set from what hosting costs. Per workspace that is mostly storage, a compressed copy of each source and of each rendered variant, plus one check per source per interval, of which a check against an unchanged source parses nothing. Three documents and fifteen variants stay well inside a few megabytes and a few hundred checks a day.

## Noticing changes

A new document for a source arrives in one of two ways: a check of a followed source finds it, or a deploy uploads it. Either way the old and new operation lists are compared (`diffOperations` in [`src/server/notify.ts`](src/server/notify.ts)): added, removed, and changed.

"Changed" needs more than comparing operation objects, because an operation mostly changes through a schema it uses. `fingerprintOperations` in the engine gives each operation one hash over its own definition, what its path item shares, the document's default security, and every component it reaches, however indirectly, with key order ignored. Fingerprints are stored with the operation index, so the comparison costs nothing at check time.

The result goes out by email to the members of the workspace, each at their own setting: nothing, new operations plus whatever touches what a variant serves (the default), or everything. It is sent once, by whoever's write stored the document. What an edit to the definition does to the operations (a source added, a path prefix) is not reported: it is the doing of whoever made it.

A name in a selection that the documents do not have is never an error, anywhere: a file is deployed before the API it describes, an operation is renamed. `unmatchedNames` in the engine says which names match nothing, and the app, `validate` and `deploy` report them.

Email is optional, and goes through Cloudflare Email Sending when it is on ([`src/server/email.ts`](src/server/email.ts)). Without `CLOUDFLARE_EMAIL_TOKEN`, `CLOUDFLARE_EMAIL_ACCOUNT_ID` and `EMAIL_FROM` nothing is sent and nothing else changes; an invitation is then a link to pass on.

## Serving a variant

`GET /v/pipe0/public-docs.json`, in order:

1. One query resolves project and variant by their slugs and reads only what serving needs (not the operation index, which can be large). The URL names a representation of the variant: the format by its extension, and the OpenAPI version by a path segment (`/v/pipe0/public-docs/3.0.json`). Without one, it is the documents' own. There is no setting for it: the URL alone says which version a reader gets.
   - Who may read it comes from the same query: `coalesce(variant.visibility, project.visibility, organization.default_visibility)`. Nothing is copied when a variant is made, so a default that changes holds at once for everything that follows it.
   - A **private** variant is answered only to a user API key of its workspace that reads it. This is decided here, before anything else is done or said about the variant: no key is a 401, a key that is not for it a 403. Its responses are `Cache-Control: private, no-cache`.
2. The ETag is a hash of the engine version, the project's document hash, the variant's id, its `served_hash`, the format and the OpenAPI version. Nothing else can change the bytes, so nothing else changes the ETag: a project default that changes moves the ETags of exactly the variants that inherit it. A matching `If-None-Match` ends here with a 304.
3. Otherwise the body comes from the first of: the edge cache (custom domains), the `variant_outputs` row for this format and version with this ETag, or a fresh render that is then stored. A render reads the documents, the variant and the two hashes that describe them in one batch, and the response carries the ETag of what was actually rendered, so an apply or a check landing mid-request cannot pair one document with another's validator.

No request for a variant causes a fetch. That is what makes serving independent of the API behind it, and it is why the timer exists.

Rendering (parse the sources, filter, serialize) costs real CPU on large documents, YAML most of all. Storing the result means it happens once per change per format rather than once per request or per edge location.

## Keeping a project current

A source is kept in one of two ways, and the definition says which.

- **Uploaded.** The document arrives with an apply and stays as it is until the next one. A project with only such sources is never checked.
- **Followed** (`follow: true`, which is what the app writes for a URL). The service keeps reading the URL.

Three modules: [`upstream.ts`](src/server/upstream.ts) talks to one source, [`assemble.ts`](src/server/assemble.ts) puts a project's sources together and stores the result of a check, and [`scheduled.ts`](src/server/scheduled.ts) is the timer.

**The timer** runs every five minutes. Each project says when it is due (`next_check_at`, decided by one pure function in [`schedule.ts`](src/server/schedule.ts)): about five minutes on if every followed source can be checked without a download (ETag or Last-Modified), about an hour if not; at the next run after a first failure, and hourly while it keeps failing; never, without a followed source or without a variant. A run takes the projects that are due, longest due first, by moving `next_check_at` ahead with a conditional `UPDATE`, which is also what keeps two runs from checking the same project. It does as much as the platform lets one invocation do, stops after eight checks that stored a document (parsing is what costs), and what it did not reach is first in line at the next run. Running into the platform's ceiling is never recorded as a source's failure.

**After a deploy** to a project with a followed source, the timer looks at every run for fifteen minutes (`watch_until`), or until the first new document arrives. The deploy uploaded what the pipeline could read, and the API behind the URL is about to change.

A round of checks looks at every followed source of the project, in parallel. For each, `checkSource` tries the cheapest check first and stops when one settles it:

1. **Conditional GET** with the validators the source sent. A 304 transfers nothing.
2. **Download** and hash. The same bytes as the stored copy end here, without the document being parsed: for a source that sends no validators this is the usual outcome, and parsing is most of what a check would cost.
3. **Parse** and validate.

If any source has a new document, `refreshProject` assembles all of them again (the new documents, and the stored copies of the others, followed or not), indexes and fingerprints the result, and writes it in one D1 batch: the project's new hash and operation list, and each new document.

Details that matter:

- The project's hash covers every source's bytes, name and path prefix, in merge order: everything the assembled document depends on. Every ETag derives from it, and it is written in the same batch as the documents it describes.
- Everything a check writes is conditional on the project still being at the revision and the hash the check found it at (`projectAt`). Of two checks that overlap, one stores and reports; the other finds nothing left to do. A check that overlaps with an apply writes nothing: what it looked at is no longer what the project is made of.
- Operation fingerprints are compared only with ones computed the same way. After an upgrade of the engine that changes how they are computed, the stored ones are made again from the stored documents before the first comparison, so a change that arrives with the upgrade is reported as what it is.
- A source that fails keeps its last good copy in the merge. The others are still updated. The failure is recorded on the source and on the project.
- New documents that cannot be put together (too large, for instance) are not stored: the project keeps serving what it had and says why.
- Requests go out with a timeout, the body is read with a size cap, and redirects are followed by hand so that a source's credentials are only sent to the origin they were entered for. Credentials stay with a source while its URL stays on that origin and it stays followed.
- The document itself gets 25 seconds. Frameworks build it on the first request after a deploy, and for a large API that can take ten seconds or more; the moment after a deploy is exactly when a check matters.

## The command line tool

[`packages/cli`](packages/cli) is built into one file with nothing to install beside it, plus the page of the local editor.

```
config.ts    the definition file: read, validated, with the line of each problem
sources.ts   the documents it names, read from disk or fetched, held to the service's limits
project.ts   file + documents: describe (operations), render (a variant's bytes), summarize
server.ts    the local server: variants at the service's paths, and the editor's three calls
save.ts      a changed definition written into the YAML, where it changed and nowhere else
view.ts      the file as a project, in the shape the service gives one
commands/    init, dev, validate, operations, deploy
page/        the React page that hosts the editor (built into dist/editor)
```

- **`dev` keeps nothing.** The file and its sources are read on every request, so what is served is what is on disk and running now, and a source that cannot be read is an error, never an older copy. It renders with the engine's `renderVariantText`, the same function the Worker uses, and a browser journey holds the two to the same bytes for every format and version.
- **The local editor talks to the local server the way the app talks to the service** (the contract is `packages/core/src/definition/api.ts`). The state says what the backend can do (`can`), which is how the editor leaves out what only a service has: keys, credentials, checks.
- **A save changes the file where the definition changed** ([`save.ts`](packages/cli/src/save.ts)). The YAML library's document model carries comments and order; because it writes the whole document in its own spacing, every line that says what a line of the original said is then put back as its author wrote it. What is written is read back and compared with what was asked for before it replaces the file, and a save that started from an older file is refused.
- **The local server is reachable from this machine only**, by default. It answers only requests addressed to a loopback name or to a host that was named (`--allowed-host`), which is what keeps a page on another site from reading it through a domain that points at 127.0.0.1. A save is taken only from a page of the same origin, as JSON. `--no-editor` leaves out everything that writes.
- **`deploy` reads every source it can and uploads the bytes as they are**, so the service stores the document its source serves. It sends no flags of its own into the file: what is deployed is what is in the repository.

## The engine

Everything that happens to a document is in [`packages/core`](packages/core), laid out as the pipeline it is:

```
text ─▶ parse ─▶ [convert] ─▶ merge ─▶ select ─▶ [convert] ─▶ serialize ─▶ text
                 only if sources          only if the variant
                 differ in version        asks for another version
```

`assembleDocument(sources)` is the first half, `buildVariant(document, { selection, version, overrides })` the second. `overrides` is the title, description and servers a variant states instead of the document's (`transforms/override.ts`): that is all an environment comes to, so there is no such thing as an environment in the data model. A variant for staging is a variant whose first server is staging. Nothing is converted that does not have to be: one source served in its own version goes through unchanged, byte for byte.

**Merging** (`transforms/merge.ts`) follows fixed rules, because it runs unattended whenever a source changes. The first document is the main one and supplies everything at the top level. What holds throughout is that an operation means in the merged document what it meant in its own: it keeps its schemas, under whatever name, and the security its document gave it, written onto the operation where that was a document-wide default. An operation defined twice is kept from the earlier document. For a component name used twice, the two are compared by meaning, a digest of the component and everything it references: equal ones are shared, different ones are renamed after their document, with every `$ref`, discriminator and security requirement following. The walk that does this covers the whole document and knows the two kinds of places where a key is not a keyword: maps of names (a response called `default`) and literal data (an example that happens to contain `$ref`). What was done comes back as notes, which the project stores and its settings show next to the documents.

**Selecting** (`transforms/select.ts`):

1. Index every operation under `paths` and `webhooks` (including OpenAPI 3.2's `query` and `additionalOperations`, and path items behind a `$ref`) and resolve the selection to a set of operation keys.
2. Drop unselected operations. A path item left with none is dropped too.
3. Find `$ref`s that pointed into something just removed (bundlers emit refs like `#/paths/~1users/get/...`) and replace each with a copy of its target.
4. Compute what the remaining document references, transitively, and prune the standard component groups to that. Unknown groups and vendor extensions pass through untouched and count as references themselves.
5. Drop tags and `x-tagGroups` entries that no kept operation uses.

**Converting** (`transforms/convert/`) between 3.0 and 3.1 is a list of small named steps per direction, each a few lines with its own test (`nullable becomes the type null`, `const becomes a one-value enum`). Steps are applied to schemas found by where they stand in the document (`document/schemas.ts`), never by what they look like, so a property named `nullable` is left alone. Going down, whatever 3.0 cannot express is removed and reported by name. Selecting happens first, so only what a variant serves is converted and reported.

The input is never mutated and untouched subtrees are shared, not copied.

**Limits and the budget** (`document/limits.ts`, `document/budget.ts`). Sharing is why a document's size in bytes says little about what it costs: one object can be mentioned a thousand times in memory for nothing (YAML aliases on the way in, a reference replaced by its target on the way through), and written out each mention is the whole thing again. `measure` walks a document as a serializer would, adds up the bytes it can come to in JSON or in YAML (indentation and escapes included), and stops the moment it is past a limit; `parseSpec` applies it to every source, and `assembleDocument` and `buildVariant` to what they produce. `serialize` is tested against that number. That bounds one pass. How often something is passed over is bounded separately and once: whatever loops over what a document holds, or reads its text, calls `spend`, a job runs inside `withBudget`, and a job that runs out of steps stops with a `DocumentTooComplexError`. A job is a call into the engine or everything a request needs done: the server puts a whole render under one budget, and a whole check. The budget is about four times what the largest project takes (five megabytes of YAML, rendered).

Whether the count is honest is not left to reading the code. `test/cost.test.ts` makes documents at random, each with a few things grown out of all proportion (twenty thousand paths that share one path item, a summary of a megabyte, five thousand security requirements), puts each through everything the service does with a document, and requires that the time a job took is covered by the steps it counted. A loop that is not paid for fails it. `COST_SEEDS=2000` looks further than an ordinary run.

**Going over a document** has two forms, and each exists once. What can stand almost anywhere (a reference, a security requirement, an operation id) is found by `walk` (`document/walk.ts`), which goes everywhere and knows the two kinds of places where a key is not a keyword: maps of names (`properties`, `responses`) and literal data (`example`, `default`). Scanning for references, renaming in a merge, inlining and conversion all go through it, so they agree on what a reference is. What has a fixed place (schemas, operations) is reached by following the structure (`document/schemas.ts`). A path item is taken apart in `document/path-items.ts` and nowhere else.

**YAML** is read by the `yaml` library and turned into plain values here (`document/parse.ts`); it is written here too (`document/yaml.ts`), in the three forms a document of plain data needs, because a general library builds a tree several times the document's size to write it. Both directions are tested against the library as an independent reader.

A selection is two lists of rules, `include` and `exclude`, each of tags and operations: an operation is served when `include` is absent or matches it and `exclude` does not. People think in outcomes instead: is this served, and what happens to what comes later. `selection/edit.ts` translates between the two, each helper changing only the operations it is asked about, so the UI can offer one meaning for a checkbox and still store rules. A test drives the helpers at random against a model of what should be served.

**The definition** (`definition/`) is the format of an `openapi-proxy.yaml`, and the engine is where it lives because the server, the command line tool and the editor all read it. One description of the format (`format.ts`) gives the validator its rules and messages (`read.ts`) and the JSON Schema that editors use (`schema.ts`, written to `public/schema/definition.v1.json`, with a test that fails when the file is stale). `effective.ts` holds the two cascades: who may read a variant (variant, project, workspace) and what stands at the top of its document (variant over project, key by key). `api.ts` is the contract an editor has with whatever holds a project: three calls and the shapes they exchange. `write.ts` writes a definition as YAML the way a person would.

## The web app

React on TanStack Start, with TanStack Query, Tailwind, and shadcn's Base UI components restyled through one set of tokens and materials; see [docs/design.md](docs/design.md).

```
src/web/routes/        the route tree, one thin file per URL
  _site/               server-rendered: /, /blog, /blog/<slug>
  docs.tsx, docs/      server-rendered: /docs, /docs/<slug>, laid out by Fumadocs UI (sidebar, search, contents)
  _client/             rendered in the browser (ssr: false): /login, /invite/<id>
    _app/              behind sign-in, inside the app shell: /app, /connect, /workspace, /p/...
src/web/pages/         the screens of the app
src/web/site/          the landing page and the blog's pages
src/web/content/blog/  posts, as MDX (compiled by Fumadocs)
src/web/content/docs/  the documentation, as MDX; meta.json sets the order of its pages
src/web/components/    the app's own components
packages/editor/src/   the variant editor and what it is drawn with: also shown by `openapi-proxy dev`
```

- **Two kinds of route, chosen by directory.** Everything under `_client` inherits `ssr: false`: the server answers with the shell and the browser does the rest, exactly like a single-page app, including the sign-in guard. Everything under `_site` is rendered on the server per request, so it is readable without JavaScript and by crawlers.
- **The site switch is in the Worker entry.** With `PUBLIC_SITE` off, `/` redirects to `/app` and `/blog` does not exist. With it on, `/` is the landing page for visitors and still redirects for anyone who carries a session cookie.
- **Security headers are set by the root route**, because pages now come from the Worker and `public/_headers` only reaches static files. Start needs two inline scripts to hydrate a page; they carry a nonce that is generated per request, so the policy stays `script-src 'self' 'nonce-...'` with no `unsafe-inline`.
- **The editor is a package of its own** ([`packages/editor`](packages/editor), MIT, reached as `@editor/*`), because the command line tool shows the same screen over a definition file. It knows no router and no API: a host gives it the project, a function that applies a changed definition, and where its buttons lead. The app's host is [`pages/variant-editor.tsx`](src/web/pages/variant-editor.tsx); the local one is [`packages/cli/page/main.tsx`](packages/cli/page/main.tsx). The design tokens live with it, in `theme.css`, which both pages import. It loads on demand, since it carries the filter engine and the YAML library.
- **The app addresses things by slug**: `/p/<project>/v/<variant>`, as the API does. One query holds every project of the workspace as its definition and its state, and every screen reads from it. A save applies the whole definition with the revision it started from ([`lib/use-apply.ts`](src/web/lib/use-apply.ts)), one save of a project at a time.
- **Blog posts with `draft: true`** are rendered while developing and are neither listed nor reachable in a production build.

## Rate limiting

Counting is left to Cloudflare: the Worker has a [rate limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/), `API_RATE_LIMIT`, declared in `wrangler.jsonc` together with the budget (300 per minute). [`src/server/rate-limit.ts`](src/server/rate-limit.ts) decides the three things that are ours to decide:

- **For whom:** the key is the workspace. Ten keys of one workspace share a budget; two workspaces behind one office address do not.
- **What is counted:** every authenticated request to the API, charged by one middleware right after `requireSession`.
- **What it costs:** one, or ten for a request that makes the instance fetch from a source: "Check now" (marked `contactsSource`), and an apply at the moment it has to read a source's address itself (`chargeForFetching`). An apply that brings its documents, or changes none, costs one. Outbound requests to a URL of the customer's choosing are the scarce thing, not requests to us.

If the binding is missing, nothing is limited. If it fails, ordinary requests go through, since a guard against abuse should not be able to take the API down, and the requests that fetch a source are refused until it is back: with nothing counting them, the instance would fetch whatever it is pointed at as fast as it is asked. Unauthenticated routes are not counted here; that is the job of the network in front of the Worker.

## Toward a hosted product

In place: users, workspaces with several members, isolation enforced in every query, plans with limits, public URLs that need no tenant, customer secrets encrypted at rest, change notifications, definition files with a command line tool, two kinds of API key. What is not built, and where it attaches:

| Addition                               | Where it attaches                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Checkout                               | A Stripe webhook (or better-auth's Stripe plugin) writes the `subscription` rows people write now |
| Deploy from a connected Git repository | A webhook reads the file and its documents and calls `applyDefinition`, as `deploy` does          |
| Deploy API keys for named projects     | One more column on `api_keys`, read where `requireSession` lets a deploy key through              |
| Swagger 2.0 sources                    | One more conversion in `packages/core/src/transforms/convert`, run before a source is assembled   |
| Usage metering                         | `serve.ts` has the variant id at the point a request is answered                                  |
| Teams inside a workspace               | better-auth's organization plugin has them; nothing here assumes their absence                    |

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

`pnpm run deploy` builds in Vite's "deploy" mode, applies D1 migrations to the remote database, and uploads the Worker. The repository carries no account-specific values: the database id, an optional custom domain and the settings of a public service (`CONTACT_EMAIL`, `PUBLIC_SITE`, `EMAIL_FROM`, ...) come from a gitignored `.env.deploy` (or the environment) and are merged into the Worker's configuration at build time, in [`vite.config.ts`](vite.config.ts). Secrets are never in that file; they are set with `wrangler secret put`. "Deploy to Cloudflare" does not need the file, because Cloudflare writes the id of the database it creates into `wrangler.jsonc` of the copy it makes.

## Storage notes

- Each source's document is stored gzip-compressed and base64-encoded in a D1 text column, whether the service fetched it or a deploy uploaded it: one copy per source, replaced when a newer one arrives. OpenAPI JSON compresses 10 to 20 times, so the 2 MB row limit is far away; the 5 MB cap on a project's sources together comes from Worker memory and CPU instead, since the whole assembled document is in memory when a variant is rendered. R2 is the escape hatch if that ever needs to grow.
- Output is rendered lazily, on the first request after a change, not eagerly on refresh. A project with many variants therefore costs nothing until someone asks. Rendering runs the whole pipeline once (assemble, select, convert) and stores the result. A render that fails is stored too, as the reason: it depends only on the documents and the variant, which is what the ETag stands for, so a public URL costs one attempt per change however often it is requested.
- Deleting a project cascades to its sources, its variants and their outputs through foreign keys.
