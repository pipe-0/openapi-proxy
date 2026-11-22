import { describe, expect, it } from "vitest";
import { GUARDS } from "../src/shared/plans";
import {
  type ApiProject,
  call,
  createProject,
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
 * three requests once ended up somewhere no single request could: a limit
 * passed, an edit served under another edit's ETag, a project describing
 * documents it does not have.
 */

const ok = { "200": { description: "ok" } };
const BILLING_URL = "https://billing.example.com/openapi.json";
const BILLING = {
  openapi: "3.1.0",
  info: { title: "Billing API", version: "9" },
  paths: { "/invoices": { get: { tags: ["billing"], responses: ok } } },
};

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

/** A request whose body arrives only on `release`: its handler has started, has read the database, and waits. */
function held(path: string, method: string, body: unknown, cookie: string) {
  const { wait, open } = gate();
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  const stream = new ReadableStream({
    async start(controller) {
      await wait;
      controller.enqueue(bytes);
      controller.close();
    },
  });
  const response = call(path, {
    method,
    headers: { cookie, "content-type": "application/json" },
    body: stream,
    duplex: "half",
  } as RequestInit);
  return { response, release: open };
}

/** Long enough for a request that is under way to get as far as it can. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

const getProject = async (cookie: string, id: string) =>
  (await (await call(`/api/projects/${id}`, { headers: { cookie } })).json()) as ApiProject;
const keys = (project: ApiProject) => project.operations.map((op) => op.key);
const servedPaths = async (path: string) =>
  Object.keys(((await (await call(`${path}.json`)).json()) as { paths?: object }).paths ?? {});

/** A project merged from two documents, with a variant that serves everything. */
async function merged() {
  const cookie = await login();
  serveSpec();
  serveSpec(BILLING, {}, BILLING_URL);
  const created = await createProject(cookie);
  const added = await call(
    `/api/projects/${created.id}/sources`,
    json("POST", { url: BILLING_URL }, cookie),
  );
  expect(added.status).toBe(201);
  const project = (await added.json()) as ApiProject;
  const variant = (await (
    await call(
      "/api/variants",
      json(
        "POST",
        {
          projectId: project.id,
          name: "Everything",
          selection: { mode: "exclude", operations: [], tags: [] },
        },
        cookie,
      ),
    )
  ).json()) as { path: string };
  return { cookie, project, variant };
}

describe("two edits of a variant that overlap", () => {
  it("are two versions: the later one is what is served, under its own ETag", async () => {
    const { cookie, variant } = await publish();

    // "Serve nothing" has read the variant and waits for its body.
    const nothing = held(
      `/api/variants/${variant.id}`,
      "PATCH",
      { selection: { mode: "include", operations: [], tags: [] } },
      cookie,
    );
    await settle();

    // "Serve everything" runs start to finish, and a reader fetches the result.
    const everything = await call(
      `/api/variants/${variant.id}`,
      json("PATCH", { selection: { mode: "exclude", operations: [], tags: [] } }, cookie),
    );
    expect(everything.status).toBe(200);
    const first = await call(`${variant.path}.json`);
    expect(Object.keys(((await first.json()) as { paths: object }).paths)).toContain(
      "/internal/flush",
    );

    nothing.release();
    expect((await nothing.response).status).toBe(200);

    const second = await call(`${variant.path}.json`);
    expect(second.headers.get("etag")).not.toBe(first.headers.get("etag"));
    expect(Object.keys(((await second.json()) as { paths?: object }).paths ?? {})).toEqual([]);
  });
});

describe("an edit to a project's sources that overlaps with checks", () => {
  it("is stored whole or planned again, so the project describes what it serves", async () => {
    const { cookie, project, variant } = await merged();
    const billing = project.sources[1];

    // 1. The edit has read the project and waits for its body.
    const edit = held(
      `/api/projects/${project.id}/sources/${billing?.id}`,
      "PATCH",
      { pathPrefix: "/billing" },
      cookie,
    );
    await settle();

    // 2. A check stores a new main document: the project has moved on.
    serveSpec(withPath("/owners"));
    await call(`/api/projects/${project.id}/check`, { method: "POST", headers: { cookie } });

    // 3. A second check has read the sources (billing without a prefix) and
    //    waits for the main source, which has changed again.
    const slow = gate();
    const next = JSON.stringify(withPath("/vets"));
    const answer = () => new Response(next, { headers: { "content-type": "application/json" } });
    upstream("GET", SPEC_URL, async () => {
      await slow.wait;
      return answer();
    });
    const secondCheck = call(`/api/projects/${project.id}/check`, {
      method: "POST",
      headers: { cookie },
    });
    await settle();

    // 4. The edit goes on. What it read is out of date, so it plans again
    //    from what is stored now, and that is what it writes.
    edit.release();
    expect((await edit.response).status).toBe(200);

    // 5. The second check comes back to a project that is no longer what it
    //    looked at, and writes nothing.
    slow.open();
    expect((await secondCheck).status).toBe(200);

    const after = await getProject(cookie, project.id);
    expect(after.sources[1]?.pathPrefix).toBe("/billing");
    expect(keys(after)).toContain("GET /billing/invoices");
    expect(keys(after)).not.toContain("GET /invoices");
    expect(await servedPaths(variant.path)).toContain("/billing/invoices");

    // What the second check had fetched is picked up by the next one.
    upstream("GET", SPEC_URL, answer);
    await call(`/api/projects/${project.id}/check`, { method: "POST", headers: { cookie } });
    const later = await getProject(cookie, project.id);
    expect(keys(later)).toEqual(expect.arrayContaining(["GET /vets", "GET /billing/invoices"]));
    expect(await servedPaths(variant.path)).toEqual(
      expect.arrayContaining(["/vets", "/billing/invoices"]),
    );
  });

  it("does not blame a source for a document that was removed while it was checked", async () => {
    const { cookie, project } = await merged();
    const billing = project.sources[1];

    // A check waits for the main source, which has a new document.
    const slow = gate();
    const next = JSON.stringify(withPath("/owners"));
    const answer = () => new Response(next, { headers: { "content-type": "application/json" } });
    upstream("GET", SPEC_URL, async () => {
      await slow.wait;
      return answer();
    });
    const check = call(`/api/projects/${project.id}/check`, {
      method: "POST",
      headers: { cookie },
    });
    await settle();

    // Meanwhile the other document is taken out of the project.
    const removed = await call(`/api/projects/${project.id}/sources/${billing?.id}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(removed.status).toBe(200);

    slow.open();
    expect((await check).status).toBe(200);
    const after = await getProject(cookie, project.id);
    expect(after.sources).toHaveLength(1);
    expect(after.lastStatus).toBe("ok");
    expect(after.lastError).toBeNull();
    expect(keys(after)).not.toContain("GET /invoices");

    upstream("GET", SPEC_URL, answer);
    await call(`/api/projects/${project.id}/check`, { method: "POST", headers: { cookie } });
    expect(keys(await getProject(cookie, project.id))).toContain("GET /owners");
  });
});

describe("a limit, asked for many times at once", () => {
  const FREE = { CONTACT_EMAIL: "support@proxy.test" };

  it("holds for projects and for variants", async () => {
    const cookie = await googleLogin("ada@example.com", "Ada", FREE);
    const urls = Array.from({ length: 10 }, (_, n) => `https://svc-${n}.example.com/openapi.json`);
    urls.forEach((url, n) => {
      serveSpec({ ...SPEC, info: { title: `Service ${n}`, version: "1" } }, {}, url);
    });

    const created = await Promise.all(
      urls.map((url) => call("/api/projects", json("POST", { url }, cookie), FREE)),
    );
    const statuses = created.map((response) => response.status);
    expect(statuses.filter((status) => status === 201)).toHaveLength(3);
    expect(statuses.filter((status) => status === 402)).toHaveLength(7);
    const projects = (await (
      await call("/api/projects", { headers: { cookie } }, FREE)
    ).json()) as ApiProject[];
    expect(projects).toHaveLength(3);

    const variants = await Promise.all(
      Array.from({ length: 30 }, (_, n) =>
        call(
          "/api/variants",
          json(
            "POST",
            {
              projectId: projects[0]?.id,
              name: `Variant ${n}`,
              selection: { mode: "exclude", operations: [], tags: [] },
            },
            cookie,
          ),
          FREE,
        ),
      ),
    );
    expect(variants.filter((response) => response.status === 201)).toHaveLength(15);
    const all = (await (
      await call("/api/variants", { headers: { cookie } }, FREE)
    ).json()) as unknown[];
    expect(all).toHaveLength(15);
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
        call("/api/workspace/keys", json("POST", { name: `Key ${n}` }, cookie)),
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
