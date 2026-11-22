# Security

## Reporting a vulnerability

Please do not open a public issue for security problems. Email support@openapi-proxy.app with details and steps to reproduce. You will get an acknowledgment within 72 hours.

## What is protected, and how

**Signing in.** Sessions, users and organizations are handled by [better-auth](https://better-auth.com).

- Google sign-in is an OAuth authorization-code flow with PKCE and a signed state, completed at the redirect URI registered with your client (`/api/auth/callback/google`). Without `ALLOWED_EMAILS`, anyone with a Google account can sign in and gets an organization of their own; set it on an instance that is meant to be private. The list is checked at every sign-in against the email Google reports, and again on every request: taking an address off it ends that person's sessions and tokens with their next request. People who were invited into a workspace are let in by its owner and stay for as long as they are members.
- `ADMIN_PASSWORD`, if set, lets a single built-in admin sign in without Google. It is compared in constant time and can be tried five times in 30 seconds. Attempts are counted in the database before they are looked at, so sending many guesses at once does not get more of them through. Leave it unset on a deployment that uses Google.
- Session cookies are `HttpOnly`, `Secure` and `SameSite=Lax`, and are signed with `AUTH_SECRET`. Rotating that secret ends every session.
- A deployment that still has the example secrets from `.env.example` refuses to authenticate anyone unless it is running on localhost.

**Tenancy.** Everything belongs to a workspace, and every query in the admin API filters by the workspace of the person asking. One workspace cannot list, read, change or delete another's projects and variants; a test signs in two people and checks exactly that.

- A person is in exactly one workspace, enforced by a unique index in the database.
- Membership is looked up on every request and not taken from the session, so someone who is removed loses access with their next request, not when their session ends. On an instance with `ALLOWED_EMAILS`, someone who is removed and is not on the list is out of the instance altogether.
- An invitation can only be accepted by someone signed in with the invited address, and only if the sign-in provider has verified that address.
- better-auth's own endpoints for creating and joining organizations are not reachable.

**API keys.** A key is shown once and stored only as a SHA-256 hash. It acts as the person who made it, in their workspace, and reaches projects and variants there, nothing else. It cannot invite or remove people, rename the workspace, or create or revoke keys: those take a signed-in person. So revoking a key ends everything it could do, including anything it might have set up to outlast itself. It stops working when it is revoked or when its maker leaves the workspace. A request with a key is authenticated by the key alone; a request without one needs a session and passes the cross-origin check. The MCP endpoint takes the same keys and can do nothing the API would not.

**Private variants.** A variant is public or private, and a workspace decides which a new one starts as. A private variant is answered only to a request that sends an API key of its workspace: one with full access, or a key that only reads, either every private variant or one. A read-only key is refused by the API and the MCP endpoint. The check comes before anything else is done or said about the variant, every representation (format and OpenAPI version) is behind it, and a session cookie is not a key. Its responses say `Cache-Control: private, no-cache`, and a key made for one variant is deleted with it, so it never comes to read more than it was made for. A variant that was public may stay in caches outside the proxy for up to six minutes after it is made private.

**Email.** Invitations are the one thing a signed-in person can make the instance send to an address of their choosing. A workspace can have 20 open invitations, create 30 a day, and re-send one at most every five minutes.

**Rate limits.** Each workspace has a budget of API requests per minute, 300 as shipped, counted by Cloudflare's rate limiter for Workers (the `API_RATE_LIMIT` binding in `wrangler.jsonc`). A request that makes the instance fetch a URL the workspace chose (connecting a document, adding one, checking a project, changing credentials) costs ten, which bounds how hard an account can make the instance hit somebody else's server: about 30 such requests a minute. Sessions, API keys and the MCP endpoint all spend from the same budget, so more tokens do not buy more requests. Over budget, the answer is `429` with `Retry-After`. The counts are per Cloudflare location and approximate. If the limiter itself is unavailable, ordinary requests go through and the ones that fetch a source are refused until it is back. Requests are also capped at 1 MB, and an MCP request at 20 messages.

**Limits hold under concurrency.** Plan limits, the invitation caps and the key cap are checked after the row is written, by its position among the rows of its kind, and whoever is over takes their row back out. Sending many requests at the same moment does not get past them.

**The admin surface.** State-changing requests from other origins are rejected, in addition to `SameSite`. The UI is served with a restrictive Content-Security-Policy (no inline scripts), cannot be framed, and API responses are never cached.

**Source credentials** (the request headers a project sends to fetch its document) are treated as someone else's secrets.

- They are encrypted with AES-GCM before they are stored, using a key derived from `AUTH_SECRET`. Rotating that secret makes them unreadable; enter them again afterwards.
- The API never returns their values, only their names.
- They are sent only to the origin of the project's source URL. Redirects to another origin are followed without them.

**Variant URLs** (`/v/<project>/<variant>`) are public by design. They exist to be read by docs renderers and SDK generators, so anything you include in a variant is published. If you rely on a URL staying unknown, use a random slug (the dice button).

**A URL does not change hands quietly.** When a project is renamed or deleted, its slug stays reserved for the workspace that had it for 90 days (the ten most recent per workspace, so that names cannot be collected by renaming a project through them). Until then nobody else can claim it and put a document of their own behind an address that someone's build still fetches.

**A document is data.** What a source returns is parsed, merged, filtered and served, and never anything else. A document with a key named `__proto__` is refused when it is fetched: that key is the one a JavaScript program cannot carry around safely, and no OpenAPI document needs it. The merge collects what documents bring in maps whose keys have no meaning of their own, so the engine is safe to use on documents that were parsed elsewhere too. Example values and defaults in a document are never rewritten, whatever their keys are called.

**A document is bounded by what it costs, not by its bytes.** A small file can stand for a very large document, or for a great deal of work: YAML aliases mention one thing many times, references can chain so that each copy nests inside the last, and thousands of operations can each point at the same large thing. Two things hold against all of that, and neither is a rule about a particular kind of document. What a document holds is measured the way it is served, written out with every repetition and every level of nesting: a source that comes to more than 30 MB or nests more than 200 levels is refused, and the same measure is taken of everything a transform produces. And the work done on a document is counted: every part of the engine that goes over a document draws from one budget per job (a render, a check), about four times what the largest project needs, and stops with a reason when it is spent. On an ordinary machine that is two or three seconds of work at the most. That the count covers the time is tested, on documents made at random to be out of proportion (`packages/core/test/cost.test.ts`), not argued. YAML is read as the part of it that is JSON with another syntax (no merge keys, sets, dates or binary values).

**A public URL costs one attempt per change.** Rendering happens once per change of a document or a variant, and what it came to is stored: the document, or the reason there is none, whatever the reason. A variant that cannot be served answers with that reason from storage until its document or its selection changes. However often a URL is requested, by anyone, the work is not done again.

**Fetching sources.** Only `http(s)` URLs are accepted. Requests have a timeout (for a whole chain of redirects, not per hop) and a size limit, and are made from Cloudflare's network, not from inside yours. Any host and port is accepted; on Workers that reaches the public internet and nothing internal. The fetched document is stored in your D1 database. Readers are anonymous, so they have no way to make the proxy contact a source. How often it does is decided by the service: every 5 minutes for a project whose sources can all be checked without a download, once an hour otherwise. A check on demand takes a signed-in person or an API key.

## What it does not do

- A workspace has two roles and no finer permissions: its owner can remove people, and everyone in it can do everything else.
- Variants have no access control of their own.
- There is no audit log.
- There is no CPU budget per workspace. A large, valid document costs what it costs to parse and render once per change (a second or two for five megabytes of YAML), and Cloudflare's limit per request (30 seconds of CPU) is the ceiling.
- Two requests for a variant that has just changed can both render it; the second result replaces the first. And if the platform stops a render (its CPU or memory limit), nothing is stored, so the next request tries again. The engine's own budget is what keeps a render far from those limits.
- Rendering and checking run in the same Worker that answers everyone else. While one runs, other requests that Cloudflare has given to the same instance wait.
- Requests from people who are not signed in are not rate-limited by the application: the sign-in routes, and public documents under `/v/`. Public documents are answered from storage, and readers cannot make the proxy contact a source more often than its schedule says; against floods, Cloudflare's own protection and WAF rules in front of the Worker are the tool.
- Sessions last 30 days and renew while they are used, and keys do not expire. Both end when the person is removed, taken off the allow list, or the key is revoked.
- The lock on password sign-in is global, so someone hammering it can delay the admin's own sign-in by up to 30 seconds at a time. They still cannot get in.
