import type { ProjectDefinition } from "@openapi-proxy/core";
import { describe, expect, it } from "vitest";
import { GUARDS } from "../src/shared/plans";
import {
  type ApiProject,
  applied,
  apply,
  call,
  createProject,
  definitionOf,
  getProject,
  googleLogin,
  json,
  login,
  MAIL,
  mailbox,
  publish,
  SPEC,
  SPEC_URL,
  serveSpec,
  sql,
  upstream,
} from "./harness";

/**
 * Requests that arrive together, or overlap. Every test here is a way two or
 * three requests could end up somewhere no single request can: a limit
 * passed, one definition served under another's ETag, a project describing
 * documents it does not have.
 */

const ok = { "200": { description: "ok" } };
const BILLING_URL = "https://billing.example.com/openapi.json";
const BILLING = {
  openapi: "3.1.0",
  info: { title: "Billing API", version: "9" },
  paths: { "/invoices": { get: { tags: ["billing"], responses: ok } } },
};
const EXTRA_URL = "https://extra.example.com/openapi.json";
const EXTRA = {
  openapi: "3.1.0",
  info: { title: "Extra API", version: "1" },
  paths: { "/extra": { get: { tags: ["extra"], responses: ok } } },
};

const CORE = { name: "core", url: SPEC_URL, main: true, follow: true };
const BILLING_SOURCE = { name: "billing", url: BILLING_URL, follow: true };
const EXTRA_SOURCE = { name: "extra", url: EXTRA_URL, follow: true };

/** The main fixture with one more path. */
const withPath = (path: string) => {
  const next = structuredClone(SPEC) as typeof SPEC & { paths: Record<string, unknown> };
  next.paths[path] = { get: { tags: ["pets"], responses: ok } };
  return next;
};

const gate = () => {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
};

/** A source that answers only once it is let: whoever fetches it has read the project, and waits. */
function slowSource(url: string, body: unknown) {
  const { wait, open } = gate();
  const text = JSON.stringify(body);
  const answer = () => new Response(text, { headers: { "content-type": "application/json" } });
  upstream("GET", url, async () => {
    await wait;
    return answer();
  });
  return { open, answer };
}

/** Long enough for a request that is under way to get as far as it can. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

const keys = (project: ApiProject) => project.state.operations.map((op) => op.key);
const servedPaths = async (path: string) =>
  Object.keys(((await (await call(`${path}.json`)).json()) as { paths?: object }).paths ?? {});
const check = (cookie: string) =>
  call("/api/projects/test/check", { method: "POST", headers: { cookie } });

/** A project merged from two documents, with a variant that serves everything. */
async function merged() {
  const cookie = await login();
  serveSpec();
  serveSpec(BILLING, {}, BILLING_URL);
  const definition = definitionOf({
    sources: [CORE, BILLING_SOURCE],
    variants: { everything: {} },
  });
  await createProject(cookie, definition);
  return { cookie, definition, path: "/v/test/everything" };
}

describe("two applies to one project that overlap", () => {
  it("are two versions: the later one is what is served, under its own ETag", async () => {
    const { cookie, project, variant } = await publish();

    // "Serve nothing" also adds a document. It has read the project, and
    // waits for that document to arrive.
    const extra = slowSource(EXTRA_URL, EXTRA);
    const nothing = apply(cookie, {
      ...project.definition,
      sources: [CORE, EXTRA_SOURCE],
      variants: { public: { include: {} } },
    });
    await settle();

    // "Serve everything" runs start to finish, and a reader fetches the result.
    await applied(apply(cookie, { ...project.definition, variants: { public: {} } }));
    const first = await call(`${variant.path}.json`);
    expect(Object.keys(((await first.json()) as { paths: object }).paths)).toContain(
      "/internal/flush",
    );

    // What "serve nothing" read is out of date. It plans again from what is
    // stored now, and is written whole: its variant, and its document.
    extra.open();
    expect((await applied(nothing)).project.revision).toBe(3);

    const second = await call(`${variant.path}.json`);
    expect(second.headers.get("etag")).not.toBe(first.headers.get("etag"));
    expect(Object.keys(((await second.json()) as { paths?: object }).paths ?? {})).toEqual([]);
    const after = await getProject(cookie);
    expect(after.state.sources.map((source) => source.name)).toEqual(["core", "extra"]);
    // The variant is the one that was there all along.
    expect(after.state.variants.public?.id).toBe(variant.id);
  });
});

describe("a save that comes too late", () => {
  it("is refused whole: nothing of it is written", async () => {
    const { cookie, definition } = await merged();
    const before = await getProject(cookie);
    // The save started from revision 1. It also adds a document, takes a
    // variant out and brings a new one, and waits for the document it adds.
    const extra = slowSource(EXTRA_URL, EXTRA);
    const late = apply(
      cookie,
      {
        ...definition,
        name: "Too late",
        sources: [CORE, { ...BILLING_SOURCE, pathPrefix: "/billing" }, EXTRA_SOURCE],
        variants: { fresh: {} },
      },
      { ifRevision: before.state.revision },
    );
    await settle();

    // Meanwhile someone else saves, and the project is at the revision the
    // late save would have made of it.
    await applied(
      apply(cookie, { ...definition, name: "First" }, { ifRevision: before.state.revision }),
    );
    const between = await getProject(cookie);
    const rows = async () => ({
      sources: (await sql("SELECT id, name, path_prefix, body_hash FROM sources ORDER BY id"))
        .results,
      variants: (await sql("SELECT id, slug, served_hash FROM variants ORDER BY id")).results,
    });
    const stored = await rows();

    extra.open();
    const refused = await late;
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "conflict" });
    // The project is exactly what the first save left: its row, and every row under it.
    expect(await getProject(cookie)).toEqual(between);
    expect(await rows()).toEqual(stored);
    expect(await servedPaths("/v/test/everything")).toEqual([
      "/pets",
      "/internal/flush",
      "/invoices",
    ]);
    expect((await call("/v/test/fresh.json")).status).toBe(404);
  });

  it("does not let two saves to one project pass the limit on variants together", async () => {
    const FREE = { CONTACT_EMAIL: "support@proxy.test" };
    const cookie = await googleLogin("ada@example.com", "Ada", FREE);
    serveSpec();
    const thirteen = Object.fromEntries(Array.from({ length: 13 }, (_, n) => [`v-${n}`, {}]));
    const definition = definitionOf({ variants: thirteen });
    await applied(apply(cookie, definition, {}, FREE));

    // Each would bring the workspace to its fifteen. Both together would pass it.
    const both = await Promise.all(
      ["a", "b"].map((name) =>
        apply(
          cookie,
          { ...definition, variants: { ...thirteen, [`${name}-1`]: {}, [`${name}-2`]: {} } },
          {},
          FREE,
        ),
      ),
    );
    expect(both.map((response) => response.status)).toEqual([200, 200]);
    // They ran one after the other, and the second is what the project is now.
    const count = await sql("SELECT count(*) AS n FROM variants");
    expect(count.results[0]).toEqual({ n: 15 });
    const one = await apply(
      cookie,
      { ...definition, variants: { ...thirteen, "more-1": {}, "more-2": {}, "more-3": {} } },
      {},
      FREE,
    );
    expect(one.status).toBe(402);
    expect((await sql("SELECT count(*) AS n FROM variants")).results[0]).toEqual({ n: 15 });
  });
});

describe("an apply to a project that is deleted meanwhile", () => {
  it("starts over from what is there: nothing, so it makes the project", async () => {
    const { cookie, definition } = await merged();
    // The apply adds a document and a variant, and waits for the document.
    const extra = slowSource(EXTRA_URL, EXTRA);
    const adding = apply(cookie, {
      ...definition,
      sources: [CORE, BILLING_SOURCE, EXTRA_SOURCE],
      variants: { everything: {}, fresh: {} },
    });
    await settle();
    await call("/api/projects/test", { method: "DELETE", headers: { cookie } });

    extra.open();
    const response = await adding;
    // Not an error of ours: the definition is applied to what there is, as a deploy does.
    expect(response.status).toBe(201);
    expect(Object.keys((await getProject(cookie)).definition.variants)).toEqual([
      "everything",
      "fresh",
    ]);
  });

  it("refuses a save that started from the project that is gone", async () => {
    const { cookie, definition } = await merged();
    const before = await getProject(cookie);
    const extra = slowSource(EXTRA_URL, EXTRA);
    const saving = apply(
      cookie,
      {
        ...definition,
        sources: [CORE, BILLING_SOURCE, EXTRA_SOURCE],
        variants: { everything: {}, fresh: {} },
      },
      { ifRevision: before.state.revision },
    );
    await settle();
    await call("/api/projects/test", { method: "DELETE", headers: { cookie } });

    extra.open();
    const response = await saving;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "This project no longer exists." });
    expect((await sql("SELECT count(*) AS n FROM projects")).results[0]).toEqual({ n: 0 });
    expect((await sql("SELECT count(*) AS n FROM variants")).results[0]).toEqual({ n: 0 });
  });
});

describe("an apply that overlaps with checks", () => {
  it("is stored whole or planned again, so the project describes what it serves", async () => {
    const { cookie, definition, path } = await merged();

    // 1. The apply has read the project and waits for a document it adds.
    const extra = slowSource(EXTRA_URL, EXTRA);
    const sources: ProjectDefinition["sources"] = [
      CORE,
      { ...BILLING_SOURCE, pathPrefix: "/billing" },
      EXTRA_SOURCE,
    ];
    const edit = apply(cookie, { ...definition, sources });
    await settle();

    // 2. A check stores a new main document: the project has moved on.
    serveSpec(withPath("/owners"));
    expect(await (await check(cookie)).json()).toMatchObject({ changed: true });

    // 3. A second check has read the sources (billing without a prefix) and
    //    waits for the main source, which has changed again.
    const slow = slowSource(SPEC_URL, withPath("/vets"));
    const secondCheck = check(cookie);
    await settle();

    // 4. The apply goes on. What it read is out of date, so it plans again
    //    from what is stored now, and that is what it writes.
    extra.open();
    await applied(edit);

    // 5. The second check comes back to a project that is no longer what it
    //    looked at, and writes nothing.
    slow.open();
    expect(await (await secondCheck).json()).toMatchObject({ changed: false });

    const after = await getProject(cookie);
    expect(after.definition.sources[1]?.pathPrefix).toBe("/billing");
    expect(keys(after)).toEqual(
      expect.arrayContaining(["GET /owners", "GET /billing/invoices", "GET /extra"]),
    );
    expect(keys(after)).not.toContain("GET /invoices");
    expect(keys(after)).not.toContain("GET /vets");
    expect(await servedPaths(path)).toEqual(
      expect.arrayContaining(["/owners", "/billing/invoices", "/extra"]),
    );

    // What the second check had fetched is picked up by the next one.
    upstream("GET", SPEC_URL, slow.answer);
    await check(cookie);
    const later = await getProject(cookie);
    expect(keys(later)).toEqual(expect.arrayContaining(["GET /vets", "GET /billing/invoices"]));
    expect(await servedPaths(path)).toEqual(expect.arrayContaining(["/vets", "/billing/invoices"]));
  });

  it("does not blame a source for a document that was removed while it was checked", async () => {
    const { cookie, definition } = await merged();

    // A check waits for the main source, which has a new document.
    const slow = slowSource(SPEC_URL, withPath("/owners"));
    const checking = check(cookie);
    await settle();

    // Meanwhile the other document is taken out of the project.
    await applied(apply(cookie, { ...definition, sources: [{ url: SPEC_URL, follow: true }] }));

    slow.open();
    expect((await checking).status).toBe(200);
    const after = await getProject(cookie);
    expect(after.state.sources).toHaveLength(1);
    expect(after.state.check).toMatchObject({ lastStatus: "ok", lastError: null });
    expect(keys(after)).not.toContain("GET /invoices");

    upstream("GET", SPEC_URL, slow.answer);
    await check(cookie);
    expect(keys(await getProject(cookie))).toContain("GET /owners");
  });
});

describe("a limit, asked for many times at once", () => {
  const FREE = { CONTACT_EMAIL: "support@proxy.test" };
  const several = (n: number) =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`variant-${i}`, {}]));

  it("holds for projects and for variants", async () => {
    const cookie = await googleLogin("ada@example.com", "Ada", FREE);
    serveSpec();

    const created = await Promise.all(
      Array.from({ length: 10 }, (_, n) =>
        apply(cookie, definitionOf({ project: `service-${n}` }), {}, FREE),
      ),
    );
    const statuses = created.map((response) => response.status);
    expect(statuses.filter((status) => status === 201)).toHaveLength(3);
    expect(statuses.filter((status) => status === 402)).toHaveLength(7);
    const projects = (await (
      await call("/api/projects", { headers: { cookie } }, FREE)
    ).json()) as ApiProject[];
    expect(projects).toHaveLength(3);

    // Fifteen variants in all. Three projects ask for six each at the same moment.
    const grown = await Promise.all(
      projects.map((project) =>
        apply(cookie, { ...project.definition, variants: several(6) }, {}, FREE),
      ),
    );
    expect(grown.map((response) => response.status).sort()).toEqual([200, 200, 402]);
    const stored = await sql("SELECT count(*) AS n FROM variants");
    expect(stored.results[0]).toEqual({ n: 12 });
    // The one that was refused is as it was.
    const after = (await (
      await call("/api/projects", { headers: { cookie } }, FREE)
    ).json()) as ApiProject[];
    expect(after.map((project) => Object.keys(project.definition.variants).length).sort()).toEqual([
      0, 6, 6,
    ]);
  });

  it("holds for the variants that new projects bring", async () => {
    const cookie = await googleLogin("ada@example.com", "Ada", FREE);
    serveSpec();
    const created = await Promise.all(
      Array.from({ length: 3 }, (_, n) =>
        apply(cookie, definitionOf({ project: `service-${n}`, variants: several(6) }), {}, FREE),
      ),
    );
    expect(created.map((response) => response.status).sort()).toEqual([201, 201, 402]);
    expect((await sql("SELECT count(*) AS n FROM projects")).results[0]).toEqual({ n: 2 });
    expect((await sql("SELECT count(*) AS n FROM variants")).results[0]).toEqual({ n: 12 });
    expect((await sql("SELECT count(*) AS n FROM sources")).results[0]).toEqual({ n: 2 });
  });

  it("gives a slug to one of the workspaces that ask for it at once", async () => {
    const ada = await googleLogin("ada@example.com", "Ada");
    const bob = await googleLogin("bob@example.com", "Bob");
    serveSpec();
    const both = await Promise.all([apply(ada, definitionOf()), apply(bob, definitionOf())]);
    expect(both.map((response) => response.status).sort()).toEqual([201, 409]);
    expect((await sql("SELECT count(*) AS n FROM projects")).results[0]).toEqual({ n: 1 });
  });

  it("holds for invitations, so a workspace cannot be used to mail strangers in bulk", async () => {
    const cookie = await googleLogin("ada@example.com", "Ada");
    const sent = mailbox();
    const responses = await Promise.all(
      Array.from({ length: 60 }, (_, n) =>
        call(
          "/api/workspace/invitations",
          json("POST", { email: `stranger${n}@elsewhere.test` }, cookie),
          MAIL,
        ),
      ),
    );
    expect(responses.filter((response) => response.status === 201)).toHaveLength(20);
    expect(sent).toHaveLength(20);
    const pending = await sql("SELECT count(*) AS n FROM invitation");
    expect(pending.results[0]).toEqual({ n: 20 });
  });

  it("sends an invitation again once, however many ask", async () => {
    const cookie = await googleLogin("ada@example.com", "Ada");
    const sent = mailbox();
    const invite = () =>
      call("/api/workspace/invitations", json("POST", { email: "bob@example.com" }, cookie), MAIL);
    expect((await invite()).status).toBe(201);
    expect(sent).toHaveLength(1);

    // Ten minutes later, ten requests to send it again.
    await sql("UPDATE invitation SET expires_at = expires_at - ?", 10 * 60_000);
    const again = await Promise.all(Array.from({ length: 10 }, invite));
    expect(again.every((response) => response.status === 200)).toBe(true);
    expect(sent).toHaveLength(2);
  });

  it("holds for API keys", async () => {
    const cookie = await googleLogin("ada@example.com", "Ada");
    const responses = await Promise.all(
      Array.from({ length: GUARDS.apiKeys + 10 }, (_, n) =>
        call("/api/workspace/keys", json("POST", { name: `Key ${n}`, access: "deploy" }, cookie)),
      ),
    );
    expect(responses.filter((response) => response.status === 201)).toHaveLength(GUARDS.apiKeys);
    const stored = await sql("SELECT count(*) AS n FROM api_keys");
    expect(stored.results[0]).toEqual({ n: GUARDS.apiKeys });
  });

  it("holds for guesses at the admin password", async () => {
    const guess = (password: string) =>
      call("/api/auth/sign-in/admin-password", json("POST", { password }));
    const statuses = (
      await Promise.all(Array.from({ length: 40 }, (_, n) => guess(`guess-${n}`)))
    ).map((response) => response.status);
    // Five were looked at. The rest were refused unseen.
    expect(statuses.filter((status) => status === 401)).toHaveLength(5);
    expect(statuses.filter((status) => status === 429)).toHaveLength(35);

    // While it is locked, the right password is refused too. Afterwards it works.
    expect((await guess("test-password")).status).toBe(429);
    await sql("UPDATE login_throttle SET last_failure_at = last_failure_at - 31000");
    expect((await guess("test-password")).status).toBe(200);
  });
});
