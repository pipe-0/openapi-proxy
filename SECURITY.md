# Security

## Reporting a vulnerability

Please do not open a public issue for security problems. Email support@openapi-proxy.app with details and steps to reproduce. You will get an acknowledgment within 72 hours.

## What is protected, and how

**Signing in.** Sessions, users and organizations are handled by [better-auth](https://better-auth.com).

- Google sign-in is an OAuth authorization-code flow with PKCE and a signed state, completed at the redirect URI registered with your client (`/api/auth/callback/google`). Without `ALLOWED_EMAILS`, anyone with a Google account can sign in and gets an organization of their own; set it on an instance that is meant to be private. The list is checked at every sign-in against the email Google reports, and again on every request: taking an address off it ends that person's sessions and tokens with their next request. People who were invited into a workspace are let in by its owner and stay for as long as they are members.
- `ADMIN_PASSWORD`, if set, lets a single built-in admin sign in without Google. It is compared in constant time and can be tried five times in 30 seconds. Attempts are counted in the database before they are looked at, so sending many guesses at once does not get more of them through. Leave it unset on a deployment that uses Google.
- Session cookies are `HttpOnly`, `Secure` and `SameSite=Lax`, and are signed with `AUTH_SECRET`. Rotating that secret ends every session.
- A deployment that still has the example secrets from `.env.example` refuses to authenticate anyone unless it is running on localhost.

**Tenancy.** Everything belongs to a workspace, and every query behind the app filters by the workspace of the person asking. One workspace cannot list, read, change or delete another's projects and variants; a test signs in two people and checks exactly that.

- A person is in exactly one workspace, enforced by a unique index in the database.
- Membership is looked up on every request and not taken from the session, so someone who is removed loses access with their next request, not when their session ends. On an instance with `ALLOWED_EMAILS`, someone who is removed and is not on the list is out of the instance altogether.
- An invitation can only be accepted by someone signed in with the invited address, and only if the sign-in provider has verified that address.
- better-auth's own endpoints for creating and joining organizations are not reachable.

**API keys.** A key is shown once and stored only as a SHA-256 hash. There are two kinds, and neither can do what the other does.

- A **deploy API key** is for a pipeline. It reaches one route, the one that applies a definition file to a project of its workspace, and nothing else: it cannot read a private variant, list projects, or reach members, invitations and keys. With it, a pipeline can create, replace and empty the workspace's projects, so it belongs in a CI secret. It belongs to the workspace: the owner makes and revokes it, and it keeps working when the person who made it leaves. On an instance with `ALLOWED_EMAILS` it works for as long as the workspace's owner may sign in.
- A **user API key** reads private variants: every one of its workspace, or one. It belongs to the person who made it, stops working when they leave the workspace, and is refused by everything under `/api`.

Making and revoking keys takes a signed-in person, so revoking a key ends everything it could do, including anything it might have set up to outlast itself. A request with a key is authenticated by the key alone; a request without one needs a session and passes the cross-origin check.

**Private variants.** A variant is public or private. It says so itself, or its project does, or its workspace does: the first of the three that says anything decides, at the moment of each request, so making a workspace private by default closes every variant that states nothing of its own at once. A private variant is answered only to a request that sends a user API key of its workspace, for every private variant or for this one. The check comes before anything else is done or said about the variant, every representation (format and OpenAPI version) is behind it, and neither a session cookie nor a deploy API key is such a key. Its responses say `Cache-Control: private, no-cache`, and a key made for one variant is deleted with it, so it never comes to read more than it was made for. A variant that was public may stay in caches outside the proxy for up to six minutes after it is made private.

**Email.** Invitations are the one thing a signed-in person can make the instance send to an address of their choosing. A workspace can have 20 open invitations, create 30 a day, and re-send one at most every five minutes.

**Rate limits.** Each workspace has a budget of requests per minute, 300 as shipped, counted by Cloudflare's rate limiter for Workers (the `API_RATE_LIMIT` binding in `wrangler.jsonc`). A request that makes the instance fetch a URL the workspace chose (checking a project, or applying a definition whose document the service has to read itself) costs ten, which bounds how hard an account can make the instance hit somebody else's server: about 30 such requests a minute. A deploy that uploads its documents costs one. Sessions and deploy API keys spend from the same budget, so more keys do not buy more requests. Over budget, the answer is `429` with `Retry-After`. The counts are per Cloudflare location and approximate. If the limiter itself is unavailable, ordinary requests go through and the ones that fetch a source are refused until it is back. Requests are also capped at 1 MB, and one that applies a definition, which carries documents, at 8 MB.

**Limits hold under concurrency.** The plan's limits on projects and variants are conditions of the one write that creates them, and the caps on invitations and keys are checked after the row is written, by its position among the rows of its kind, with whoever is over taking their row back out. Sending many requests at the same moment does not get past them.

**A project changes all at once or not at all.** A definition is applied in one database transaction whose first statement only matches while the project is as it was read. An apply that lost a race writes nothing, not a part of itself, and tries again from what is there.

**The app's surface.** State-changing requests from other origins are rejected, in addition to `SameSite`. The UI is served with a restrictive Content-Security-Policy (no inline scripts), cannot be framed, and API responses are never cached.

**Source credentials** (the request headers a project sends to fetch its document) are treated as someone else's secrets.

- They are encrypted with AES-GCM before they are stored, using a key derived from `AUTH_SECRET`. Rotating that secret makes them unreadable; enter them again afterwards.
- The API never returns their values, only their names.
- They are sent only to the origin of the source's URL. Redirects to another origin are followed without them, and they are dropped when a source's URL moves to another origin or the source is no longer followed.
- They are never part of a definition file. They are entered in the app, by a signed-in person.

**Variant URLs** (`/v/<project>/<variant>`) of public variants are public by design. They exist to be read by docs renderers and SDK generators, so anything you include in a public variant is published. If you rely on a URL staying unknown, use a random slug (the dice button), or make the variant private.

**A URL does not change hands quietly.** A project's slug cannot be changed, and when a project is deleted its slug stays reserved for the workspace that had it for 90 days (the ten most recent per workspace, so that names cannot be collected by creating and deleting projects). Until then nobody else can claim it and put a document of their own behind an address that someone's build still fetches. A deploy cannot take a slug either: a definition file whose `project` belongs to another workspace is refused.

**A document is data.** What a source returns is parsed, merged, filtered and served, and never anything else. A document with a key named `__proto__` is refused when it is fetched: that key is the one a JavaScript program cannot carry around safely, and no OpenAPI document needs it. The merge collects what documents bring in maps whose keys have no meaning of their own, so the engine is safe to use on documents that were parsed elsewhere too. Example values and defaults in a document are never rewritten, whatever their keys are called.

**A document is bounded by what it costs, not by its bytes.** A small file can stand for a very large document, or for a great deal of work: YAML aliases mention one thing many times, references can chain so that each copy nests inside the last, and thousands of operations can each point at the same large thing. Two things hold against all of that, and neither is a rule about a particular kind of document. What a document holds is measured the way it is served, written out with every repetition and every level of nesting: a source that comes to more than 30 MB or nests more than 200 levels is refused, and the same measure is taken of everything a transform produces. And the work done on a document is counted: every part of the engine that goes over a document draws from one budget per job (a render, a check), about four times what the largest project needs, and stops with a reason when it is spent. On an ordinary machine that is two or three seconds of work at the most. That the count covers the time is tested, on documents made at random to be out of proportion (`packages/core/test/cost.test.ts`), not argued. YAML is read as the part of it that is JSON with another syntax (no merge keys, sets, dates or binary values).

**A public URL costs one attempt per change.** Rendering happens once per change of a document or a variant, and what it came to is stored: the document, or the reason there is none, whatever the reason. A variant that cannot be served answers with that reason from storage until its document or its selection changes. However often a URL is requested, by anyone, the work is not done again.

**Fetching sources.** Only `http(s)` URLs are accepted. Requests have a timeout (for a whole chain of redirects, not per hop) and a size limit, and are made from Cloudflare's network, not from inside yours. Any host and port is accepted; on Workers that reaches the public internet and nothing internal. The fetched document is stored in your D1 database. No request for a variant makes the instance contact a source, whoever sends it. How often it does is decided by the service: every 5 minutes for a project whose followed sources can all be checked without a download, once an hour otherwise, and never for a source that is not followed. A check on demand takes a signed-in person.

**Uploaded documents.** A deploy sends documents with the definition. They are held to the same limits as fetched ones (5 MB for a project's sources together, and the measures described under "A document is bounded by what it costs"), parsed and validated before anything is stored, and stored where fetched ones are.

## The command line tool

`@pipe0/openapi-proxy` runs on a developer's machine and in CI, so what it does there is kept small and stated.

- **It has no runtime dependencies and no install scripts.** Everything is bundled into the files that are published, and installing it runs nothing.
- **It sends nothing anywhere unasked.** No telemetry and no update check. `init`, `dev`, `validate` and `operations` read the definition file and the sources it names (and the ones given with `--source`), and nothing else. `deploy` sends the definition and its documents to the instance the file names, or to openapi-proxy.app, and refuses plain HTTP to anything but this machine.
- **It writes one file.** `dev` writes the definition file it was started with, when its editor saves; with `--no-editor` it writes nothing. `init` writes the file it was asked for and refuses to replace one that exists without `--force`.
- **`dev` is reachable from this machine only**, unless `--host` says otherwise. It listens on 127.0.0.1 and answers only requests addressed to a loopback name or to a host named with `--allowed-host`: a page on another site cannot read it through a domain that points at 127.0.0.1. A save is accepted only from the page the server itself served (same origin, as JSON), and is refused when the file changed since the page read it. Started with `--host`, it prints that whoever can reach the address can change the file.
- **The deploy key is read from the environment** (`OPENAPI_PROXY_API_KEY`) and never from the definition file, a flag or a prompt, so it does not end up in a repository or in a shell history.

## What it does not do

- A workspace has two roles and no finer permissions: its owner can remove people and manages deploy API keys, and everyone in it can do everything else.
- A deploy API key is for the whole workspace, not for named projects.
- There is no audit log.
- There is no CPU budget per workspace. A large, valid document costs what it costs to parse and render once per change (a second or two for five megabytes of YAML), and Cloudflare's limit per request (30 seconds of CPU) is the ceiling.
- Two requests for a variant that has just changed can both render it; the second result replaces the first. And if the platform stops a render (its CPU or memory limit), nothing is stored, so the next request tries again. The engine's own budget is what keeps a render far from those limits.
- Rendering and checking run in the same Worker that answers everyone else. While one runs, other requests that Cloudflare has given to the same instance wait.
- Requests from people who are not signed in are not rate-limited by the application: the sign-in routes, and public documents under `/v/`. Public documents are answered from storage, and readers cannot make the proxy contact a source at all; against floods, Cloudflare's own protection and WAF rules in front of the Worker are the tool.
- Sessions last 30 days and renew while they are used, and keys do not expire. A session and a user API key end when the person is removed or taken off the allow list. A deploy API key ends when the owner revokes it.
- The lock on password sign-in is global, so someone hammering it can delay the admin's own sign-in by up to 30 seconds at a time. They still cannot get in.
