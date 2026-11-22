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

**API tokens.** A token is shown once and stored only as a SHA-256 hash. It acts as the person who made it, in their workspace, and reaches projects and variants there, nothing else. It cannot invite or remove people, rename the workspace, or create or revoke tokens: those take a signed-in person. So revoking a token ends everything it could do, including anything it might have set up to outlast itself. It stops working when it is revoked or when its maker leaves the workspace. A request with a token is authenticated by the token alone; a request without one needs a session and passes the cross-origin check. The MCP endpoint takes the same tokens and can do nothing the API would not.

**Email.** Invitations are the one thing a signed-in person can make the instance send to an address of their choosing. A workspace can have 20 open invitations, create 30 a day, and re-send one at most every five minutes.

**Rate limits.** Each workspace has a budget of API requests per minute, 300 as shipped, counted by Cloudflare's rate limiter for Workers (the `API_RATE_LIMIT` binding in `wrangler.jsonc`). A request that makes the instance fetch a URL the workspace chose (connecting a document, adding one, checking a project, changing credentials) costs ten, which bounds how hard an account can make the instance hit somebody else's server: about 30 such requests a minute. Sessions, API tokens and the MCP endpoint all spend from the same budget, so more tokens do not buy more requests. Over budget, the answer is `429` with `Retry-After`. The counts are per Cloudflare location and approximate. Requests are also capped at 1 MB, and an MCP request at 20 messages.

**Limits hold under concurrency.** Plan limits, the invitation caps and the token cap are checked after the row is written, by its position among the rows of its kind, and whoever is over takes their row back out. Sending many requests at the same moment does not get past them.

**The admin surface.** State-changing requests from other origins are rejected, in addition to `SameSite`. The UI is served with a restrictive Content-Security-Policy (no inline scripts), cannot be framed, and API responses are never cached.

**Source credentials** (the request headers a project sends to fetch its document) are treated as someone else's secrets.

- They are encrypted with AES-GCM before they are stored, using a key derived from `AUTH_SECRET`. Rotating that secret makes them unreadable; enter them again afterwards.
- The API never returns their values, only their names.
- They are sent only to the origin of the project's source URL. Redirects to another origin are followed without them.

**Variant URLs** (`/v/<project>/<variant>`) are public by design. They exist to be read by docs renderers and SDK generators, so anything you include in a variant is published. If you rely on a URL staying unknown, use a random slug (the dice button).

**A URL does not change hands quietly.** When a project is renamed or deleted, its slug stays reserved for the workspace that had it for 90 days. Until then nobody else can claim it and put a document of their own behind an address that someone's build still fetches.

**A document is data.** What a source returns is parsed, merged, filtered and served, and never anything else. A document with a key named `__proto__` is refused when it is fetched: that key is the one a JavaScript program cannot carry around safely, and no OpenAPI document needs it. The merge collects what documents bring in maps whose keys have no meaning of their own, so the engine is safe to use on documents that were parsed elsewhere too. Example values and defaults in a document are never rewritten, whatever their keys are called.

**A document is bounded in structure, not only in bytes.** A small file can be nested thousands of levels deep, or use YAML aliases to describe a tree far larger than itself, and a size limit says nothing about what that costs to work on. A document is refused if it is nested more than 200 levels, has more than a million objects and lists once aliases are written out, or uses more than 5,000 YAML aliases. Inside those bounds, the work the engine does grows with the size of the document, and tests hold it to that with documents built to be expensive.

**Fetching sources.** Only `http(s)` URLs are accepted. Requests have a timeout (for a whole chain of redirects, not per hop) and a size limit, and are made from Cloudflare's network, not from inside yours. Any host and port is accepted; on Workers that reaches the public internet and nothing internal. The fetched document is stored in your D1 database. Anonymous readers can ask for a fresh check (`Cache-Control: no-cache`), but never make the proxy contact a source more than once every 10 seconds.

## What it does not do

- A workspace has two roles and no finer permissions: its owner can remove people, and everyone in it can do everything else.
- Variants have no access control of their own.
- There is no audit log.
- There is no CPU budget per workspace. A large, valid document costs what it costs to parse and render (once per change; the result is stored), and Cloudflare's limit per request is the ceiling.
- Requests from people who are not signed in are not rate-limited by the application: the sign-in routes, and public documents under `/v/`. Public documents are answered from storage and make the proxy contact a source at most once every 10 seconds; against floods, Cloudflare's own protection and WAF rules in front of the Worker are the tool.
- Sessions last 30 days and renew while they are used, and tokens do not expire. Both end when the person is removed, taken off the allow list, or the token is revoked.
- The lock on password sign-in is global, so someone hammering it can delay the admin's own sign-in by up to 30 seconds at a time. They still cannot get in.
