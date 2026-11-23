import { describe, expect, it } from "vitest";
import { GUARDS } from "../src/shared/plans";
import {
  type ApiKey,
  type ApiProject,
  applied,
  apply,
  bearer,
  call,
  callAsProgram,
  createKey,
  createProject,
  createReadKey,
  definitionOf,
  deploy,
  document,
  edit,
  getProject,
  googleLogin,
  json,
  publish,
  serveSpec,
  sql,
  variantOf,
} from "./harness";

const withKey = (key: string, path: string, init: RequestInit = {}) =>
  callAsProgram(path, { ...init, headers: { ...bearer(key), ...init.headers } });

/** A definition as a repository holds it: its document is a file, uploaded with each deploy. */
const FILE = definitionOf({
  sources: [{ file: "./openapi.json" }],
  variants: { public: { include: { tags: ["pets"] } } },
});
const DOCUMENTS = { documents: { main: document() } };

/** Ada, who owns a workspace, with a deploy API key. */
async function setup() {
  const ada = await googleLogin("ada@example.com", "Ada");
  const { key, id } = await createKey(ada);
  return { ada, key, id };
}

/** Someone Ada invited, signed in. */
async function invite(ada: string, email: string, name?: string) {
  const invitation = (await (
    await call("/api/workspace/invitations", json("POST", { email }, ada))
  ).json()) as { id: string };
  const cookie = await googleLogin(email, name);
  await call(`/api/invitations/${invitation.id}/accept`, { method: "POST", headers: { cookie } });
  return cookie;
}
const members = async (ada: string) =>
  (
    (await (await call("/api/workspace", { headers: { cookie: ada } })).json()) as {
      members: Array<{ id: string; email: string }>;
    }
  ).members;
const listKeys = async (cookie: string) =>
  (await (await call("/api/workspace/keys", { headers: { cookie } })).json()) as ApiKey[];

describe("a deploy API key", () => {
  it("is shown once, and applies a definition for its workspace", async () => {
    const { ada } = await setup();
    const created = await createKey(ada, "Deploy pipeline");
    expect(created.key).toMatch(/^oap_[0-9a-z]{40}$/);
    expect(created.prefix).toBe(created.key.slice(0, 8));
    expect(created).toMatchObject({
      name: "Deploy pipeline",
      access: "deploy",
      variant: null,
      createdBy: "Ada",
      yours: true,
    });

    const rehearsal = await applied(deploy(created.key, FILE, { ...DOCUMENTS, dryRun: true }));
    expect(rehearsal).toMatchObject({ dryRun: true, created: true });
    const result = await applied(
      deploy(created.key, FILE, {
        ...DOCUMENTS,
        origin: { commit: "4f2a9c1", ref: "refs/heads/main", repository: "acme/api" },
      }),
    );
    expect(result).toMatchObject({
      created: true,
      project: { slug: "test", managedBy: "file" },
      sources: [{ document: "uploaded", follow: false }],
      variants: [{ slug: "public", action: "created", url: "https://proxy.test/v/test/public" }],
    });
    expect((await call("/v/test/public.json")).status).toBe(200);

    // The app shows whose project it is now, and where it came from.
    const project = await getProject(ada);
    expect(project.state).toMatchObject({
      managedBy: "file",
      can: { edit: false },
      applied: {
        by: { kind: "key", id: created.id, name: "Deploy pipeline" },
        origin: { commit: "4f2a9c1", ref: "refs/heads/main", repository: "acme/api" },
      },
    });
  });

  it("does that one thing, and nothing else", async () => {
    const { ada, key } = await setup();
    await applied(deploy(key, { ...FILE, visibility: "private" }, DOCUMENTS));
    const invitation = (await (
      await call("/api/workspace/invitations", json("POST", { email: "bob@example.com" }, ada))
    ).json()) as { id: string };

    const refused = [
      withKey(key, "/api/projects"),
      withKey(key, "/api/projects/test"),
      withKey(key, "/api/projects/test/document"),
      withKey(key, "/api/projects/test", { method: "DELETE" }),
      withKey(key, "/api/projects/test/check", { method: "POST" }),
      withKey(key, "/api/projects/test/credentials", json("PUT", { source: "main", headers: [] })),
      withKey(key, "/api/projects/test/notifications", json("PUT", { scope: "off" })),
      withKey(key, "/api/slugs/test"),
      withKey(key, "/api/me"),
      withKey(key, "/api/workspace"),
      withKey(key, "/api/workspace", json("PATCH", { name: "Taken" })),
      withKey(key, "/api/workspace/keys"),
      withKey(key, "/api/workspace/keys", json("POST", { name: "Another", access: "deploy" })),
      withKey(key, "/api/workspace/invitations", json("POST", { email: "mallory@example.com" })),
      withKey(key, `/api/invitations/${invitation.id}/accept`, { method: "POST" }),
    ];
    for (const response of await Promise.all(refused)) {
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        code: "forbidden",
        error: expect.stringContaining("deploy API key"),
      });
    }
    // It does not read the private variants it deploys either.
    const read = await withKey(key, "/v/test/public.json");
    expect(read.status).toBe(403);

    const after = (await (await call("/api/workspace", { headers: { cookie: ada } })).json()) as {
      name: string;
      invitations: unknown[];
    };
    expect(after.name).not.toBe("Taken");
    expect(after.invitations).toHaveLength(1);
    expect(await listKeys(ada)).toHaveLength(1);
  });

  it("reaches nothing of another workspace", async () => {
    const { key } = await setup();
    await applied(deploy(key, FILE, DOCUMENTS));

    const bob = await googleLogin("bob@example.com", "Bob");
    const bobs = await createKey(bob);
    const taken = await deploy(bobs.key, { ...FILE, variants: {} }, DOCUMENTS);
    expect(taken.status).toBe(409);
    expect(await taken.json()).toMatchObject({ code: "slug-taken" });
    expect((await call("/v/test/public.json")).status).toBe(200);
  });

  it("works for a pipeline: no cookie, no Origin", async () => {
    const { ada, key } = await setup();
    const body = { method: "PUT", body: JSON.stringify({ definition: FILE, ...DOCUMENTS }) };
    const typed = { "content-type": "application/json" };

    // A page elsewhere can make a signed-in browser send this much: a form's
    // content type, no Origin. It is refused.
    const forged = await callAsProgram("/api/projects/test", {
      ...body,
      headers: { "content-type": "text/plain", cookie: ada },
    });
    expect(forged.status).toBe(403);

    // There is one way to present a key: `Authorization: Bearer`. Not `X-API-Key`, not a query.
    for (const attempt of [
      callAsProgram("/api/projects/test", { ...body, headers: { ...typed, "x-api-key": key } }),
      callAsProgram("/api/projects/test", { ...body, headers: { ...typed, authorization: key } }),
      callAsProgram(`/api/projects/test?api_key=${key}`, { ...body, headers: typed }),
    ]) {
      expect((await attempt).status).toBe(401);
    }
    expect((await withKey(key, "/api/projects/test", { ...body, headers: typed })).status).toBe(
      201,
    );
  });

  it("stops working when it is revoked", async () => {
    const { ada, key, id } = await setup();
    const revoked = await call(`/api/workspace/keys/${id}`, {
      method: "DELETE",
      headers: { cookie: ada },
    });
    expect(revoked.status).toBe(200);

    const after = await deploy(key, FILE, DOCUMENTS);
    expect(after.status).toBe(401);
    expect(after.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("is the workspace's: only its owner makes or revokes one, and it outlasts whoever made it", async () => {
    const { ada, key, id } = await setup();
    const bob = await invite(ada, "bob@example.com", "Bob");

    const made = await call(
      "/api/workspace/keys",
      json("POST", { name: "Bob's pipeline", access: "deploy" }, bob),
    );
    expect(made.status).toBe(403);
    expect(((await made.json()) as { error: string }).error).toContain("owner");
    const revoked = await call(`/api/workspace/keys/${id}`, {
      method: "DELETE",
      headers: { cookie: bob },
    });
    expect(revoked.status).toBe(403);
    // A member sees that it exists.
    expect((await listKeys(bob)).map((k) => [k.name, k.access, k.yours])).toEqual([
      ["CI", "deploy", false],
    ]);

    // The account that made it is gone. The pipeline goes on.
    await sql("UPDATE api_keys SET created_by = NULL");
    expect((await deploy(key, FILE, DOCUMENTS)).status).toBe(201);
    expect((await listKeys(ada))[0]).toMatchObject({ name: "CI", createdBy: null, yours: false });
  });

  it("is the only thing looked at when a request carries one", async () => {
    const { ada, key } = await setup();
    const body = JSON.stringify({ definition: FILE, ...DOCUMENTS });
    // A valid session next to a key that is not: the session does not rescue it.
    for (const credential of [`oap_${"0".repeat(40)}`, "nonsense", ""]) {
      const response = await call("/api/projects/test", {
        method: "PUT",
        headers: {
          cookie: ada,
          authorization: `Bearer ${credential}`,
          "content-type": "application/json",
        },
        body,
      });
      expect(response.status, credential).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
    }
    // And the other way round: a valid key decides, whoever the cookie belongs to.
    const bob = await googleLogin("bob@example.com", "Bob");
    const mixed = await callAsProgram("/api/projects/test", {
      method: "PUT",
      headers: { cookie: bob, ...bearer(key), "content-type": "application/json" },
      body,
    });
    expect(mixed.status).toBe(201);
    expect((await call("/api/projects/test", { headers: { cookie: bob } })).status).toBe(404);
    expect((await getProject(ada)).state.managedBy).toBe("file");
  });

  it("does not exempt sign-in routes from the cross-site check", async () => {
    const { ada, key } = await setup();
    // better-auth's routes only know cookies. A key header must not switch their protection off.
    const signOut = await callAsProgram("/api/auth/sign-out", {
      method: "POST",
      headers: { cookie: ada, ...bearer(key), "content-type": "text/plain" },
      body: "{}",
    });
    expect(signOut.status).toBe(403);
    expect((await call("/api/me", { headers: { cookie: ada } })).status).toBe(200);
  });

  it("is never listed, and neither is its hash", async () => {
    const { ada, key } = await setup();
    const listing = await (await call("/api/workspace/keys", { headers: { cookie: ada } })).text();
    expect(listing).not.toContain(key);
    expect(listing).not.toContain(key.slice(8));

    const [stored] = (await sql("SELECT key_hash, prefix FROM api_keys")).results as Array<{
      key_hash: string;
      prefix: string;
    }>;
    expect(stored?.key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(listing).not.toContain(stored?.key_hash);
    expect(JSON.parse(listing)).toMatchObject([
      { name: "CI", prefix: stored?.prefix, yours: true },
    ]);
    expect(Object.keys((JSON.parse(listing) as object[])[0] ?? {}).sort()).toEqual(
      [
        "access",
        "createdAt",
        "createdBy",
        "id",
        "lastUsedAt",
        "name",
        "prefix",
        "variant",
        "yours",
      ].sort(),
    );
  });

  it("records roughly when it was last used", async () => {
    const { ada, key } = await setup();
    const lastUsed = async () => (await listKeys(ada))[0]?.lastUsedAt;
    const use = () => deploy(key, FILE, { ...DOCUMENTS, dryRun: true });
    expect(await lastUsed()).toBeNull();

    await use();
    const first = await lastUsed();
    expect(first).toBeGreaterThan(0);

    // Not on every request: once a minute is enough to tell a live key from a dead one.
    await use();
    expect(await lastUsed()).toBe(first);
    await sql("UPDATE api_keys SET last_used_at = last_used_at - 61000");
    await use();
    expect(await lastUsed()).toBeGreaterThanOrEqual(first as number);
  });
});

describe("a project that is deployed from a file", () => {
  it("is the file's: what the file does not list is gone, and the app does not edit it", async () => {
    const { ada, key } = await setup();
    // It was made in the app first, with two variants and a followed URL.
    serveSpec();
    const before = await createProject(ada, {
      name: "Made in the app",
      variants: { public: {}, internal: {} },
    });
    const reader = await createReadKey(ada, { project: "test", variant: "public" });
    const internals = await createReadKey(ada, { project: "test", variant: "internal" });

    // A deploy of a file with the same slug takes it over, without asking.
    const result = await applied(deploy(key, FILE, DOCUMENTS));
    expect(result).toMatchObject({ created: false, tookOver: true });
    expect(
      result.variants.map(({ slug, action, keysRemoved }) => [slug, action, keysRemoved]),
    ).toEqual([
      ["public", "changed", undefined],
      ["internal", "deleted", 1],
    ]);
    const after = await getProject(ada);
    expect(after.definition).toEqual(FILE);
    expect(after.state.managedBy).toBe("file");
    // The variant that stayed is the same variant: its id, and the key that was for it.
    expect(after.state.variants.public?.id).toBe(before.state.variants.public?.id);
    expect((await listKeys(ada)).map((k) => k.id)).toContain(reader.id);
    expect((await listKeys(ada)).map((k) => k.id)).not.toContain(internals.id);
    expect((await call("/v/test/internal.json")).status).toBe(404);

    // In the app it can be read, and not changed.
    const saved = await apply(ada, { ...FILE, name: "Edited in the app" });
    expect(saved.status).toBe(409);
    expect(await saved.json()).toMatchObject({
      code: "managed-by-file",
      applied: { by: { kind: "key", name: "CI" } },
    });
    expect((await getProject(ada)).definition.name).toBeUndefined();

    // Until someone says that it is edited in the app from now on.
    const switched = await applied(
      apply(ada, { ...FILE, name: "Edited in the app" }, { editInApp: true }),
    );
    expect(switched.project.managedBy).toBe("app");
    const inApp = await getProject(ada);
    expect(inApp.state).toMatchObject({ managedBy: "app", can: { edit: true } });
    expect(inApp.state.applied?.by).toMatchObject({ kind: "person", name: "Ada" });
    // Its document is the one that was uploaded last, and stays.
    await applied(edit(ada, "test", (d) => ({ ...d, variants: { ...d.variants, more: {} } })));
    expect((await call("/v/test/more.json")).status).toBe(200);

    // The next deploy makes it the file's again.
    expect((await applied(deploy(key, FILE, DOCUMENTS))).tookOver).toBe(true);
    expect((await call("/v/test/more.json")).status).toBe(404);
  });

  it("keeps the ids of its variants from deploy to deploy, so user API keys keep working", async () => {
    const { ada, key } = await setup();
    await applied(
      deploy(
        key,
        { ...FILE, variants: { partners: { visibility: "private" }, public: {} } },
        DOCUMENTS,
      ),
    );
    const partners = variantOf(await getProject(ada), "partners");
    const reader = await createReadKey(ada, { project: "test", variant: "partners" });
    expect((await withKey(reader.key, "/v/test/partners.json")).status).toBe(200);

    // The file changes: another selection, another order, another document.
    const next = structuredClone(JSON.parse(DOCUMENTS.documents.main.content)) as {
      paths: Record<string, unknown>;
    };
    next.paths["/owners"] = {
      get: { tags: ["pets"], responses: { "200": { description: "ok" } } },
    };
    const result = await applied(
      deploy(
        key,
        {
          ...FILE,
          variants: {
            public: {},
            partners: { visibility: "private", include: { tags: ["pets"] } },
          },
        },
        { documents: { main: document(next) } },
      ),
    );
    expect(result.operations.added).toEqual(["GET /owners"]);
    expect(result.sources).toMatchObject([{ action: "updated", document: "uploaded" }]);

    const after = await getProject(ada);
    expect(Object.keys(after.definition.variants)).toEqual(["public", "partners"]);
    expect(after.state.variants.partners?.id).toBe(partners.id);
    const read = await withKey(reader.key, "/v/test/partners.json");
    expect(read.status).toBe(200);
    expect(Object.keys(((await read.json()) as { paths: object }).paths)).toEqual([
      "/pets",
      "/owners",
    ]);

    // Deployed again as it is: nothing changes, and it says so.
    const same = await applied(
      deploy(key, after.definition, { documents: { main: document(next) } }),
    );
    expect(same.sources).toMatchObject([{ action: "unchanged", document: "kept" }]);
    expect(same.variants.map((variant) => variant.action)).toEqual(["unchanged", "unchanged"]);
    expect(same.operations).toMatchObject({ added: [], removed: [], changed: [] });
  });

  it("can have a source the service follows: it is uploaded now, and read again later", async () => {
    const { ada, key } = await setup();
    const followed = definitionOf({ variants: { public: {} } });
    // The pipeline read the URL itself and sends what it got. Nothing is fetched here.
    const result = await applied(deploy(key, followed, DOCUMENTS));
    expect(result.sources).toMatchObject([{ document: "uploaded", follow: true }]);
    const project = await getProject(ada);
    // The timer looks at its next run, and at every run for a quarter of an hour.
    expect(project.state.check?.watchUntil).toBeGreaterThan(Date.now() + 14 * 60_000);
    expect(project.state.check?.nextCheckAt).toBeLessThanOrEqual(Date.now());
    expect(project.state.can.check).toBe(true);

    // Without the document, the service reads the URL at once.
    serveSpec();
    const fetched = await applied(deploy(key, { ...followed, project: "second" }));
    expect(fetched.sources).toMatchObject([{ document: "fetched", follow: true }]);
  });
});

describe("managing keys", () => {
  it("needs a name and a kind, and stops at a hundred per workspace", async () => {
    const ada = await googleLogin("ada@example.com", "Ada");
    const create = (name: unknown, access: unknown = "deploy") =>
      call("/api/workspace/keys", json("POST", { name, access }, ada));
    expect((await create("")).status).toBe(400);
    expect((await create("x".repeat(61))).status).toBe(400);
    expect((await create(42)).status).toBe(400);
    expect((await create("Old kind", "full")).status).toBe(400);
    expect((await create("No kind", null)).status).toBe(400);

    for (let n = 0; n < GUARDS.apiKeys; n++) expect((await create(`Key ${n}`)).status).toBe(201);
    const full = await create("One too many");
    expect(full.status).toBe(409);
    expect(await full.json()).toMatchObject({ code: "limit-reached" });
  });

  it("lets the owner revoke anyone's user API key, and a member only their own", async () => {
    const ada = await googleLogin("ada@example.com", "Ada");
    const bob = await invite(ada, "bob@example.com", "Bob");

    const adas = await createReadKey(ada, null, "Ada's");
    const bobs = await createReadKey(bob, null, "Bob's");
    const revoke = (cookie: string, id: string) =>
      call(`/api/workspace/keys/${id}`, { method: "DELETE", headers: { cookie } });

    // Bob sees both, marked by whose they are.
    expect((await listKeys(bob)).map((t) => [t.name, t.createdBy, t.yours])).toEqual([
      ["Ada's", "Ada", false],
      ["Bob's", "Bob", true],
    ]);

    expect((await revoke(bob, adas.id)).status).toBe(403);
    expect((await revoke(ada, bobs.id)).status).toBe(200);
    expect((await revoke(ada, "tok_missing")).status).toBe(404);

    // Another workspace cannot see or revoke it.
    const eve = await googleLogin("eve@example.com", "Eve");
    expect(await listKeys(eve)).toEqual([]);
    expect((await revoke(eve, adas.id)).status).toBe(404);
  });

  it("is not needed to serve: a key that is gone takes nothing public with it", async () => {
    const { cookie, variant } = await publish();
    const { key, id } = await createKey(cookie);
    await call(`/api/workspace/keys/${id}`, { method: "DELETE", headers: { cookie } });
    expect((await deploy(key, FILE, DOCUMENTS)).status).toBe(401);
    expect((await call(variant.path)).status).toBe(200);
  });
});

describe("a private variant, and the user API keys that read it", () => {
  const statusOf = async (key: string | undefined, path: string) =>
    (key === undefined ? await callAsProgram(path) : await withKey(key, path)).status;
  /** Ada with a project whose variants are as given. */
  async function withVariants(variants: ApiProject["definition"]["variants"]) {
    const ada = await googleLogin("ada@example.com", "Ada");
    serveSpec();
    const project = await createProject(ada, { variants });
    return { ada, project };
  }

  it("is read with a user API key of its workspace, and by no one else", async () => {
    const { ada, project } = await withVariants({ internal: { visibility: "private" } });
    const variant = variantOf(project, "internal");
    expect(variant.visibility).toEqual({ value: "private", from: "variant" });
    const { key } = await createReadKey(ada);
    const path = `${variant.path}.json`;

    // Nobody in particular is told that it is private, and how it is read.
    const anonymous = await callAsProgram(path);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toBe("Bearer");
    expect(anonymous.headers.get("cache-control")).toBe("no-store");
    expect(((await anonymous.json()) as { error: string }).error).toContain(
      "Authorization: Bearer",
    );
    expect(await statusOf(`oap_${"0".repeat(40)}`, path)).toBe(401);
    // Being signed in is not a key.
    expect((await call(path, { headers: { cookie: ada } })).status).toBe(401);

    const read = await withKey(key, path);
    expect(read.status).toBe(200);
    expect(((await read.json()) as { openapi: string }).openapi).toBe("3.1.0");
    // For this reader alone, and asked for again each time.
    expect(read.headers.get("cache-control")).toBe("private, no-cache");
    expect(read.headers.get("vary")).toBe("Authorization");
    const etag = read.headers.get("etag") as string;
    expect((await withKey(key, path, { headers: { "if-none-match": etag } })).status).toBe(304);
    // Knowing its validator opens nothing.
    expect((await callAsProgram(path, { headers: { "if-none-match": etag } })).status).toBe(401);
    // Every representation is behind the same door.
    for (const other of [variant.path, `${variant.path}.yaml`, `${variant.path}/3.0.json`]) {
      expect(await statusOf(undefined, other)).toBe(401);
      expect(await statusOf(key, other)).toBe(200);
    }
    expect((await callAsProgram(path, { method: "HEAD" })).status).toBe(401);

    // A key of another workspace is a key, and not one for this.
    const bob = await googleLogin("bob@example.com", "Bob");
    expect(await statusOf((await createReadKey(bob)).key, path)).toBe(403);
    // A revoked key reads nothing.
    const once = await createReadKey(ada, null, "Once");
    expect(await statusOf(once.key, path)).toBe(200);
    await call(`/api/workspace/keys/${once.id}`, { method: "DELETE", headers: { cookie: ada } });
    expect(await statusOf(once.key, path)).toBe(401);

    // Made public, it is anyone's again, and says so to caches.
    await applied(
      edit(ada, "test", (d) => ({ ...d, variants: { internal: { visibility: "public" } } })),
    );
    const open = await callAsProgram(path);
    expect(open.status).toBe(200);
    expect(open.headers.get("cache-control")).toContain("public");
    // The document did not change, so neither did its validator.
    expect(open.headers.get("etag")).toBe(etag);
    const invalid = await edit(ada, "test", (d) => ({
      ...d,
      variants: { internal: { visibility: "secret" as never } },
    }));
    expect(invalid.status).toBe(400);
  });

  it("has keys for every private variant, or for one", async () => {
    const { ada, project } = await withVariants({
      internal: { visibility: "private" },
      partner: { visibility: "private" },
    });
    const internal = variantOf(project, "internal");
    const partner = variantOf(project, "partner");
    const scope = { project: "test", variant: "partner" };
    const all = await createReadKey(ada, null, "Docs build");
    const one = await createReadKey(ada, scope, "Partner");
    expect(all).toMatchObject({ access: "read", variant: null });
    expect(one).toMatchObject({ access: "read", variant: scope });

    expect(await statusOf(all.key, `${internal.path}.json`)).toBe(200);
    expect(await statusOf(all.key, `${partner.path}.json`)).toBe(200);
    expect(await statusOf(one.key, `${partner.path}.json`)).toBe(200);
    // The partner's key opens the partner's document and no other.
    const other = await withKey(one.key, `${internal.path}.json`);
    expect(other.status).toBe(403);
    expect(((await other.json()) as { error: string }).error).toContain("does not read");

    // Reading is all they do.
    for (const response of [
      await withKey(all.key, "/api/projects"),
      await withKey(all.key, "/api/me"),
      await withKey(one.key, "/api/projects/test", { method: "DELETE" }),
      await withKey(all.key, "/api/projects/test", json("PUT", { definition: project.definition })),
    ]) {
      expect(response.status).toBe(403);
      expect(((await response.json()) as { error: string }).error).toContain("user API key");
    }
    expect((await getProject(ada)).state.revision).toBe(project.state.revision);

    // The list says what each key is for.
    expect(
      (await listKeys(ada)).map(({ name, access, variant }) => ({ name, access, variant })),
    ).toEqual([
      { name: "Docs build", access: "read", variant: null },
      { name: "Partner", access: "read", variant: scope },
    ]);

    // Only a user API key is for one variant, and only for a variant of this workspace.
    const refuse = async (cookie: string, body: object) =>
      (await call("/api/workspace/keys", json("POST", { name: "No", ...body }, cookie))).status;
    expect(await refuse(ada, { access: "deploy", variant: scope })).toBe(400);
    expect(await refuse(ada, { access: "everything" })).toBe(400);
    // What a key reads is said, never assumed: left out or misspelled, it is not "all".
    expect(await refuse(ada, { access: "read" })).toBe(400);
    expect(await refuse(ada, { access: "read", variantId: partner.id })).toBe(400);
    expect(
      await refuse(ada, { access: "read", variant: { project: "test", variant: "nope" } }),
    ).toBe(404);
    const bob = await googleLogin("bob@example.com", "Bob");
    expect(await refuse(bob, { access: "read", variant: scope })).toBe(404);

    // The key goes with its variant: it never comes to read more than it was made for.
    const result = await applied(
      edit(ada, "test", ({ variants: { partner: _, ...rest }, ...d }) => ({
        ...d,
        variants: rest,
      })),
    );
    expect(result.variants.find((variant) => variant.slug === "partner")).toMatchObject({
      action: "deleted",
      keysRemoved: 1,
    });
    expect(await statusOf(one.key, `${internal.path}.json`)).toBe(401);
    expect((await sql("SELECT name FROM api_keys ORDER BY created_at")).results).toEqual([
      { name: "Docs build" },
    ]);
  });

  it("acts for whoever made it: it stops when they are removed or leave, and deploy API keys stay", async () => {
    const { ada, project } = await withVariants({ internal: { visibility: "private" } });
    const path = `${variantOf(project, "internal").path}.json`;
    await createKey(ada, "Pipeline");
    const bob = await invite(ada, "bob@example.com");
    const carol = await invite(ada, "carol@example.com");
    const bobs = (await createReadKey(bob)).key;
    const carols = (await createReadKey(carol)).key;
    for (const key of [bobs, carols]) expect(await statusOf(key, path)).toBe(200);

    const id = async (email: string) => (await members(ada)).find((m) => m.email === email)?.id;
    // Ada removes Bob; Carol leaves on her own.
    await call(`/api/workspace/members/${await id("bob@example.com")}`, {
      method: "DELETE",
      headers: { cookie: ada },
    });
    await call(`/api/workspace/members/${await id("carol@example.com")}`, {
      method: "DELETE",
      headers: { cookie: carol },
    });

    expect(await statusOf(bobs, path)).toBe(401);
    expect(await statusOf(carols, path)).toBe(401);
    expect((await listKeys(ada)).map((key) => key.name)).toEqual(["Pipeline"]);
  });

  it("is what a variant is when nothing closer says otherwise: its project, then the workspace", async () => {
    const { ada, project } = await withVariants({
      plain: {},
      open: { visibility: "public" },
      closed: { visibility: "private" },
    });
    const visibility = async () => {
      const { state } = await getProject(ada);
      return Object.fromEntries(
        Object.entries(state.variants).map(([slug, variant]) => [
          slug,
          `${variant.visibility.value} (${variant.visibility.from})`,
        ]),
      );
    };
    const reads = async () =>
      Object.fromEntries(
        await Promise.all(
          ["plain", "open", "closed"].map(
            async (slug) => [slug, (await callAsProgram(`/v/test/${slug}.json`)).status] as const,
          ),
        ),
      );
    const setDefault = (defaultVisibility: string) =>
      call("/api/workspace", json("PATCH", { defaultVisibility }, ada));
    const etag = (await callAsProgram("/v/test/plain.json")).headers.get("etag");

    expect(await visibility()).toEqual({
      plain: "public (workspace)",
      open: "public (variant)",
      closed: "private (variant)",
    });
    expect(await reads()).toEqual({ plain: 200, open: 200, closed: 401 });

    // The workspace's default changes: every variant that says nothing follows, at once.
    expect((await setDefault("private")).status).toBe(200);
    expect(await visibility()).toEqual({
      plain: "private (workspace)",
      open: "public (variant)",
      closed: "private (variant)",
    });
    expect(await reads()).toEqual({ plain: 401, open: 200, closed: 401 });
    // Nothing was applied for that, and nothing about the document changed.
    expect((await getProject(ada)).state.revision).toBe(project.state.revision);
    const { key } = await createReadKey(ada);
    expect((await withKey(key, "/v/test/plain.json")).headers.get("etag")).toBe(etag);

    // The project says what its variants are: that is closer than the workspace.
    await applied(edit(ada, "test", (d) => ({ ...d, visibility: "public" })));
    expect(await visibility()).toEqual({
      plain: "public (project)",
      open: "public (variant)",
      closed: "private (variant)",
    });
    expect(await reads()).toEqual({ plain: 200, open: 200, closed: 401 });
    expect((await callAsProgram("/v/test/plain.json")).headers.get("etag")).toBe(etag);

    expect((await setDefault("hidden")).status).toBe(400);
  });
});
